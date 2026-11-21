import type pg from 'pg';
import { fiscalContext } from './reports.js';

// งบกระแสเงินสด (docs/phase6-spec.md ข้อ 2) คิดจากรายการในงวด เงินคิดเป็นสตางค์ (BigInt)
// เงินสด = บัญชีสินทรัพย์ 11xx ทุกบัญชี · ไม่รวมรายการปิดบัญชี (CL) · ยอดยกมา (OB) ในงวด = เงินสดต้นงวด

type Cat = 'cash' | 'pl' | 'wc' | 'inv' | 'fin';
export function cashFlowCategory(code: string, type: string): Cat {
  if (type === 'revenue' || type === 'expense') return 'pl';
  if (type === 'asset') {
    if (code.startsWith('11')) return 'cash';
    return /^1[2-5]/.test(code) ? 'wc' : 'inv';
  }
  if (type === 'liability') return /^2[1-4]/.test(code) ? 'wc' : 'fin';
  return 'fin'; // ส่วนของเจ้าของ
}

/** กลุ่มของวิธีทางตรง (กิจกรรมดำเนินงาน) ตามบัญชีคู่ของเงินสด */
export type DirectKey = 'customers' | 'suppliers' | 'expenses' | 'taxes' | 'interest' | 'otherIncome' | 'other';
export function directKey(code: string, type: string): DirectKey {
  if (type === 'revenue') return /^4[12]/.test(code) ? 'customers' : 'otherIncome';
  if (type === 'expense') {
    if (code.startsWith('51')) return 'suppliers';
    if (code.startsWith('531')) return 'interest';
    if (/^5[4-9]/.test(code)) return 'taxes';
    return 'expenses';
  }
  if (type === 'asset') {
    if (code.startsWith('12')) return 'customers';
    if (code.startsWith('13') || code === '1410' || code === '1411') return 'suppliers';
    if (code.startsWith('14')) return 'taxes';
    if (code === '1510') return 'expenses';
    if (code.startsWith('15')) return 'suppliers';
    return 'other';
  }
  if (code === '2210' || code === '2211' || code.startsWith('24')) return 'customers';
  if (code.startsWith('21')) return 'suppliers';
  if (code.startsWith('22')) return 'taxes';
  if (code.startsWith('23')) return 'expenses';
  return 'other';
}

export type CfLine = { code: string; name: string; amount: string };
/** ลงทุน/จัดหาเงิน: แยกเงินรับ (in) กับเงินจ่าย (out) ของบัญชีเดียวกัน เช่น ซื้อกับขายอุปกรณ์ */
export type CfFlow = CfLine & { kind: 'in' | 'out' };
export type CashFlowData = {
  month: string; scope: 'month' | 'ytd'; from: string;
  fiscalYear: { start: string; end: string };
  operating: {
    netIncome: string;
    /** ปรับกระทบรายบัญชีกำไรขาดทุนที่ไม่ใช่เงินสด (ค่าเสื่อมราคา กำไร/ขาดทุนจากจำหน่ายสินทรัพย์) บวก = บวกกลับ */
    adjustments: CfLine[];
    /** การเปลี่ยนแปลงสินทรัพย์/หนี้สินดำเนินงาน (บวก = เงินสดเพิ่ม) */
    workingCapital: (CfLine & { kind: 'asset' | 'liability' })[];
    direct: { key: DirectKey; amount: string }[];
    total: string;
  };
  investing: { lines: CfFlow[]; total: string };
  financing: { lines: CfFlow[]; total: string };
  netChange: string; openingCash: string; closingCash: string;
  cashAccounts: { code: string; name: string; opening: string; closing: string }[];
  /** ยอดรวมบัญชี 11xx ณ สิ้นงวดตามบัญชี (งบแสดงฐานะการเงิน) */
  ledgerCash: string; matches: boolean;
  nonCash: { docNo: string; date: string; description: string; amount: string }[];
};

const toC = (v: string): bigint => {
  const neg = v.startsWith('-');
  const [i, f = ''] = (neg ? v.slice(1) : v).split('.');
  const c = BigInt(i || '0') * 100n + BigInt((f + '00').slice(0, 2));
  return neg ? -c : c;
};
const money = (c: bigint) => {
  const neg = c < 0n;
  const a = neg ? -c : c;
  return `${neg ? '-' : ''}${a / 100n}.${String(a % 100n).padStart(2, '0')}`;
};
const abs = (c: bigint) => (c < 0n ? -c : c);

type Ln = { code: string; name: string; type: string; n: bigint; cat: Cat };

export async function cashFlow(c: pg.PoolClient, companyId: string, month: string, scope: 'month' | 'ytd'): Promise<CashFlowData> {
  const to = `${month}-01`;
  const fy = await fiscalContext(c, companyId, month);
  const from = scope === 'month' ? to : fy.start;
  const r = await c.query(
    // บรรทัดของงวด (ไม่รวม CL) อ่านครั้งเดียวแบบ materialized กันแผนวนซ้อนของบริษัทใหม่
    `with ents as materialized (
       select e.id, e.entry_date, e.posted_at, e.doc_no, e.doc_prefix, e.description, e.total_amount
         from acc.journal_entries e
        where e.company_id = $1 and e.entry_date >= $2::date and e.entry_date < ($3::date + interval '1 month') and e.doc_prefix <> 'CL'
     )
     select e.id, e.entry_date::text as date, e.doc_no as "docNo", e.doc_prefix as prefix, e.description, e.total_amount::text as total,
            json_agg(json_build_object('code', a.code, 'name', a.name, 'type', a.type, 'n', (l.credit - l.debit)::text) order by l.line_no) as lines
       from ents e
       join acc.journal_lines l on l.company_id = $1 and l.entry_id = e.id
       join acc.chart_of_accounts a on a.company_id = l.company_id and a.id = l.account_id
      group by e.id, e.entry_date, e.posted_at, e.doc_no, e.doc_prefix, e.description, e.total_amount
      order by e.entry_date, e.posted_at`, [companyId, from, to]);
  const bal = await c.query(
    `select a.code, a.name,
            coalesce(sum(b.debit_total - b.credit_total) filter (where p.start_date < $2::date), 0)::numeric(18,2)::text as opening,
            coalesce(sum(b.debit_total - b.credit_total) filter (where p.start_date <= $3::date), 0)::numeric(18,2)::text as closing
       from acc.chart_of_accounts a
       left join acc.account_balances b on b.company_id = a.company_id and b.account_id = a.id
       left join acc.periods p on p.company_id = b.company_id and p.id = b.period_id
      where a.company_id = $1 and a.type = 'asset' and a.code like '11%'
      group by a.code, a.name order by a.code`, [companyId, from, to]);

  let netIncome = 0n;
  const adj = new Map<string, { name: string; c: bigint }>();
  const wc = new Map<string, { name: string; type: string; c: bigint }>();
  const direct = new Map<DirectKey, bigint>();
  const inv = new Map<string, { name: string; c: bigint }>();
  const fin = new Map<string, { name: string; c: bigint }>();
  const obCash = new Map<string, bigint>();
  const nonCash: CashFlowData['nonCash'] = [];
  const add = <K>(m: Map<K, { name: string; c: bigint }>, k: K, name: string, v: bigint) => {
    const x = m.get(k) ?? { name, c: 0n };
    x.c += v; m.set(k, x);
  };

  for (const e of r.rows as { date: string; docNo: string; prefix: string; description: string; total: string; lines: { code: string; name: string; type: string; n: string }[] }[]) {
    const lines: Ln[] = e.lines.map((l) => ({ ...l, n: toC(l.n), cat: cashFlowCategory(l.code, l.type) }));
    if (e.prefix === 'OB') { // ยอดยกมา: เงินสดของรายการนี้เป็นเงินสดต้นงวด ไม่ใช่กระแสเงินสด
      for (const l of lines) if (l.cat === 'cash') obCash.set(l.code, (obCash.get(l.code) ?? 0n) - l.n);
      continue;
    }
    const hasCash = lines.some((l) => l.cat === 'cash');
    const hasInv = lines.some((l) => l.cat === 'inv');
    const hasIF = hasInv || lines.some((l) => l.cat === 'fin');
    for (const l of lines) if (l.cat === 'pl') netIncome += l.n;
    // บรรทัดกำไรขาดทุนในรายการที่มีบัญชีลงทุน/จัดหาเงิน = ไม่ใช่เงินสดจากการดำเนินงาน (ค่าเสื่อม กำไร/ขาดทุนจากขาย) → บวกกลับ
    if (hasIF) for (const l of lines) if (l.cat === 'pl') add(adj, l.code, l.name, -l.n);
    if (hasCash || !hasIF) for (const l of lines) if (l.cat === 'wc') {
      const x = wc.get(l.code) ?? { name: l.name, type: l.type, c: 0n };
      x.c += l.n; wc.set(l.code, x);
    }
    if (!hasCash) {
      // รายการลงทุน/จัดหาเงินที่ไม่ใช้เงินสด (ไม่มีกำไรขาดทุน เช่น ซื้อสินทรัพย์เงินเชื่อ ลงทุนเป็นสินทรัพย์) แสดงในหมายเหตุ
      if (hasIF && !lines.some((l) => l.cat === 'pl')) nonCash.push({ docNo: e.docNo, date: e.date, description: e.description, amount: money(toC(e.total)) });
      continue;
    }
    // เงินสดของรายการแบ่งไปตามบรรทัดที่ไม่ใช่เงินสด: ลงทุน/จัดหาเงินรวมไปที่บัญชีหลักของรายการ (ยอดมากสุด) รวมกำไรขาดทุนในรายการนั้น
    const primary = (cat: Cat) => lines.filter((l) => l.cat === cat).sort((a, b) => (abs(b.n) > abs(a.n) ? 1 : abs(b.n) < abs(a.n) ? -1 : 0))[0];
    const invMain = primary('inv'), finMain = primary('fin');
    let invSum = 0n, finSum = 0n;
    for (const l of lines) {
      if (l.cat === 'cash') continue;
      if (l.cat === 'inv') invSum += l.n;
      else if (l.cat === 'fin') finSum += l.n;
      else if (l.cat === 'pl' && hasIF) {
        if (invMain) invSum += l.n; else finSum += l.n;
      } else {
        const k = directKey(l.code, l.type);
        direct.set(k, (direct.get(k) ?? 0n) + l.n);
      }
    }
    if (invMain && invSum !== 0n) add(inv, `${invMain.code}:${invSum > 0n ? 'in' : 'out'}`, invMain.name, invSum);
    if (finMain && finSum !== 0n) add(fin, `${finMain.code}:${finSum > 0n ? 'in' : 'out'}`, finMain.name, finSum);
  }

  const lineList = (m: Map<string, { name: string; c: bigint }>) => [...m].filter(([, x]) => x.c !== 0n).sort(([a], [b]) => a.localeCompare(b))
    .map(([code, x]) => ({ code, name: x.name, amount: money(x.c) }));
  const flowList = (m: Map<string, { name: string; c: bigint }>): CfFlow[] => [...m].filter(([, x]) => x.c !== 0n).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, x]) => ({ code: key.split(':')[0]!, name: x.name, amount: money(x.c), kind: key.endsWith(':in') ? 'in' as const : 'out' as const }));
  const sum = (m: Map<unknown, { c: bigint }>) => [...m.values()].reduce((a, x) => a + x.c, 0n);
  const adjustments = lineList(adj);
  const workingCapital = [...wc].filter(([, x]) => x.c !== 0n).sort(([a], [b]) => a.localeCompare(b))
    .map(([code, x]) => ({ code, name: x.name, amount: money(x.c), kind: (x.type === 'asset' ? 'asset' : 'liability') as 'asset' | 'liability' }));
  const opTotal = netIncome + sum(adj) + sum(wc);
  const directTotal = [...direct.values()].reduce((a, x) => a + x, 0n);
  if (directTotal !== opTotal) throw new Error(`งบกระแสเงินสด: ทางตรง ${money(directTotal)} ไม่เท่าทางอ้อม ${money(opTotal)}`);
  const invTotal = sum(inv), finTotal = sum(fin);

  const accounts = bal.rows.map((x) => {
    const opening = toC(x.opening) + (obCash.get(x.code) ?? 0n);
    return { code: x.code as string, name: x.name as string, opening, closing: toC(x.closing) };
  }).filter((x) => x.opening !== 0n || x.closing !== 0n);
  const openingCash = accounts.reduce((a, x) => a + x.opening, 0n);
  const ledgerCash = accounts.reduce((a, x) => a + x.closing, 0n);
  const netChange = opTotal + invTotal + finTotal;
  const closingCash = openingCash + netChange;
  const ORDER: DirectKey[] = ['customers', 'suppliers', 'expenses', 'interest', 'taxes', 'otherIncome', 'other'];
  return {
    month, scope, from: from.slice(0, 7), fiscalYear: { start: fy.start, end: fy.end },
    operating: {
      netIncome: money(netIncome), adjustments, workingCapital,
      direct: ORDER.filter((k) => (direct.get(k) ?? 0n) !== 0n).map((k) => ({ key: k, amount: money(direct.get(k)!) })),
      total: money(opTotal),
    },
    investing: { lines: flowList(inv), total: money(invTotal) },
    financing: { lines: flowList(fin), total: money(finTotal) },
    netChange: money(netChange), openingCash: money(openingCash), closingCash: money(closingCash),
    cashAccounts: accounts.map((x) => ({ code: x.code, name: x.name, opening: money(x.opening), closing: money(x.closing) })),
    ledgerCash: money(ledgerCash), matches: closingCash === ledgerCash,
    nonCash,
  };
}
