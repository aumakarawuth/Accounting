import type pg from 'pg';
import { fiscalContext, partnershipAllocation, statements } from './reports.js';

// งบแสดงการเปลี่ยนแปลงส่วนของเจ้าของ (docs/phase6-spec.md ข้อ 3 · docs/phase7-spec.md ข้อ 1 ตามประเภทกิจการ) เงินคิดเป็นสตางค์ (BigInt)
// ไม่รวมรายการปิดบัญชี (CL) ของงวด (กำไรยังแสดงเป็นกำไรสุทธิ/ส่วนแบ่งกำไร) · ยอดยกมา (OB) ในงวด = ยอดต้นงวด
// รวมปลายงวดต้องเท่า "รวมส่วนของเจ้าของ" ในงบแสดงฐานะการเงิน
//   เจ้าของคนเดียว: ทุน · กำไรสะสม · ถอนใช้ · อื่น ๆ
//   ห้างหุ้นส่วน: คอลัมน์รายหุ้นส่วน (ทุน + กระแสทุน + ถอนใช้) · กำไรแบ่งตามสัญญา (acc.partnership_allocation)
//   บริษัทจำกัด: ทุนเรือนหุ้น · ส่วนเกินมูลค่าหุ้น · ทุนสำรองตามกฎหมาย · กำไรสะสม · อื่น ๆ

export type EntityType = 'sole' | 'partnership' | 'company';
export type EquityRowKey = 'opening' | 'contribution' | 'withdrawal' | 'shareIssue' | 'salary' | 'interest' | 'ratioShare'
  | 'netIncome' | 'drawings' | 'reserve' | 'dividends' | 'other' | 'closing';
export type EquityChangesData = {
  month: string; scope: 'month' | 'ytd'; from: string; entityType: EntityType;
  /** key: capital retained drawings other (เจ้าของคนเดียว) · p1..p9 unallocated other (ห้างหุ้นส่วน) · capital premium reserve retained other (บริษัท) */
  columns: { key: string; partner?: string; accounts: { code: string; name: string }[] }[];
  rows: { key: EquityRowKey; values: Record<string, string>; total: string }[];
  netIncome: string;
  /** รวมส่วนของเจ้าของในงบแสดงฐานะการเงิน ณ สิ้นงวด */
  positionEquity: string; matches: boolean;
};

export const equityColumn = (code: string, entity: EntityType = 'sole'): string => {
  if (entity === 'partnership') {
    const m = /^3[123]([1-9])0$/.exec(code);
    return m ? `p${m[1]}` : 'other';
  }
  if (entity === 'company') {
    if (code === '3120') return 'premium';
    if (code.startsWith('31')) return 'capital';
    if (code === '3210') return 'retained';
    if (code.startsWith('32')) return 'reserve';
    return 'other';
  }
  return code.startsWith('31') ? 'capital' : code.startsWith('32') ? 'retained' : code.startsWith('33') ? 'drawings' : 'other';
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

const prevMonth = (iso: string) => {
  const [y, m] = iso.split('-').map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12-01` : `${y}-${String(m - 1).padStart(2, '0')}-01`;
};

export async function equityChanges(c: pg.PoolClient, companyId: string, month: string, scope: 'month' | 'ytd'): Promise<EquityChangesData> {
  const to = `${month}-01`;
  const fy = await fiscalContext(c, companyId, month);
  const from = scope === 'month' ? to : fy.start;
  const co = (await c.query(`select entity_type from acc.companies where id = $1`, [companyId])).rows[0] as { entity_type: EntityType };
  const entity = co.entity_type;
  // ยอดก่อนต้นงวด (รวม CL ของปีก่อน) ของบัญชีทุน และกำไรขาดทุนที่ยังไม่ปิด (แยกก่อนต้นปีบัญชี / ในปีนี้ก่อนต้นงวด)
  const before = await c.query(
    `select a.code, a.name, a.type, a.active,
            coalesce(sum(b.credit_total - b.debit_total), 0)::numeric(18,2)::text as net,
            coalesce(sum(b.credit_total - b.debit_total) filter (where p.start_date < $3::date), 0)::numeric(18,2)::text as prior
       from acc.chart_of_accounts a
       left join acc.account_balances b on b.company_id = a.company_id and b.account_id = a.id
        and b.period_id = any (array(select p.id from acc.periods p where p.company_id = $1 and p.start_date < $2::date))
       left join acc.periods p on p.company_id = b.company_id and p.id = b.period_id
      where a.company_id = $1 and a.type in ('equity', 'revenue', 'expense')
      group by a.code, a.name, a.type, a.active order by a.code`, [companyId, from, fy.start]);
  const lines = await c.query(
    `select a.code, a.type, e.doc_prefix as prefix, l.entry_id as "entryId", l.debit::text as debit, l.credit::text as credit
       from acc.journal_lines l
       join acc.chart_of_accounts a on a.company_id = l.company_id and a.id = l.account_id
       join acc.journal_entries e on e.company_id = l.company_id and e.id = l.entry_id
      where l.company_id = $1 and a.type in ('equity', 'revenue', 'expense')
        and l.entry_id = any (array(select x.id from acc.journal_entries x where x.company_id = $1 and x.entry_date >= $2::date
              and x.entry_date < ($3::date + interval '1 month') and x.doc_prefix <> 'CL'))`,
    [companyId, from, to]);
  const partners = entity === 'partnership'
    ? (await c.query(`select no, name from acc.partners where company_id = $1 order by no`, [companyId])).rows as { no: number; name: string }[]
    : [];
  const dividendEntries = new Set<string>(entity === 'company'
    ? (await c.query(`select unnest(array[entry_id, void_entry_id]) id from acc.dividends where company_id = $1`, [companyId])).rows
      .map((r) => r.id as string).filter(Boolean)
    : []);

  const keys: string[] = entity === 'partnership'
    ? [...partners.map((p) => `p${p.no}`), 'unallocated', 'other']
    : entity === 'company' ? ['capital', 'premium', 'reserve', 'retained', 'other'] : ['capital', 'retained', 'drawings', 'other'];
  const cols = new Map<string, Map<string, string>>(keys.map((k) => [k, new Map()]));
  const rowKeys: EquityRowKey[] = ['opening', 'contribution', 'withdrawal', 'shareIssue', 'salary', 'interest', 'ratioShare', 'netIncome', 'drawings', 'reserve', 'dividends', 'other', 'closing'];
  const v = Object.fromEntries(rowKeys.map((k) => [k, Object.fromEntries(keys.map((x) => [x, 0n]))])) as Record<EquityRowKey, Record<string, bigint>>;
  const col = (code: string) => { const k = equityColumn(code, entity); return cols.has(k) ? k : 'other'; };
  const profitCol = entity === 'sole' || entity === 'company' ? 'retained' : 'unallocated';

  let priorProfit = 0n, yearProfitBefore = 0n;
  for (const r of before.rows as { code: string; name: string; type: string; active: boolean; net: string; prior: string }[]) {
    if (r.type === 'equity') {
      const k = col(r.code);
      if (r.active || toC(r.net) !== 0n) cols.get(k)!.set(r.code, r.name);
      v.opening[k]! += toC(r.net);
    } else { priorProfit += toC(r.prior); yearProfitBefore += toC(r.net) - toC(r.prior); }
  }
  if (entity === 'partnership') {
    v.opening.unallocated! += priorProfit; // กำไรปีก่อนที่ยังไม่ได้ปิดบัญชี (ยังไม่ได้แบ่ง)
    if (yearProfitBefore !== 0n) {
      for (const a of await partnershipAllocation(c, companyId, fy.start, prevMonth(from), money(yearProfitBefore))) v.opening[`p${a.no}`]! += toC(a.total);
    }
  } else v.opening[profitCol]! += priorProfit + yearProfitBefore;

  let netIncome = 0n;
  const byEntry = new Map<string, { code: string; d: bigint; c: bigint }[]>();
  for (const l of lines.rows as { code: string; type: string; prefix: string; entryId: string; debit: string; credit: string }[]) {
    const d = toC(l.debit), cr = toC(l.credit);
    if (l.prefix === 'OB') { v.opening[l.type === 'equity' ? col(l.code) : (entity === 'partnership' ? 'unallocated' : profitCol)]! += cr - d; continue; }
    if (l.type !== 'equity') { netIncome += cr - d; continue; }
    const k = col(l.code);
    if (entity === 'sole') {
      if (k === 'capital') { v.contribution.capital! += cr; v.withdrawal.capital! -= d; }
      else if (k === 'drawings') v.drawings.drawings! += cr - d;
      else v.other[k]! += cr - d;
    } else if (entity === 'partnership') {
      if (/^31/.test(l.code) && k !== 'other') { v.contribution[k]! += cr; v.withdrawal[k]! -= d; }
      else if (/^33/.test(l.code) && k !== 'other') v.drawings[k]! += cr - d;
      else v.other[k]! += cr - d;
    } else {
      if (k === 'capital' || k === 'premium') v.shareIssue[k]! += cr - d;
      else if (k === 'reserve' || k === 'retained') {
        const list = byEntry.get(l.entryId) ?? [];
        list.push({ code: l.code, d, c: cr });
        byEntry.set(l.entryId, list);
      } else v.other[k]! += cr - d;
    }
  }
  // บริษัท: ทุนสำรองที่จัดสรรจากกำไรสะสมในรายการเดียวกัน = แถวจัดสรรทุนสำรอง · กำไรสะสมที่เหลือในรายการประกาศปันผล = แถวเงินปันผล
  for (const [entryId, ls] of byEntry) {
    const res = ls.filter((x) => equityColumn(x.code, entity) === 'reserve').reduce((a, x) => a + x.c - x.d, 0n);
    const ret = ls.filter((x) => x.code === '3210').reduce((a, x) => a + x.c - x.d, 0n);
    const moved = ret !== 0n ? res : 0n;
    v.reserve.reserve! += moved; v.reserve.retained! -= moved;
    v.other.reserve! += res - moved;
    v[dividendEntries.has(entryId) ? 'dividends' : 'other'].retained! += ret + moved;
  }
  if (entity === 'partnership') {
    for (const a of await partnershipAllocation(c, companyId, from, to, money(netIncome))) {
      v.salary[`p${a.no}`]! += toC(a.salary); v.interest[`p${a.no}`]! += toC(a.interest); v.ratioShare[`p${a.no}`]! += toC(a.share);
    }
  } else v.netIncome[profitCol]! += netIncome;

  const flows = rowKeys.filter((k) => k !== 'closing');
  for (const k of keys) v.closing[k] = flows.reduce((a, r) => a + v[r][k]!, 0n);
  const always = (k: string) => entity === 'partnership' ? /^p/.test(k) : entity === 'company' ? k !== 'other' : k === 'capital' || k === 'retained';
  const usedCols = keys.filter((k) => always(k) || cols.get(k)!.size > 0 || rowKeys.some((r) => v[r][k] !== 0n));
  const required: EquityRowKey[] = entity === 'partnership' ? ['opening', 'salary', 'interest', 'ratioShare', 'closing'] : ['opening', 'netIncome', 'closing'];
  const rows = rowKeys
    .filter((k) => required.includes(k) && !(entity === 'partnership' && (k === 'salary' || k === 'interest') && usedCols.every((x) => v[k][x] === 0n))
      || (!required.includes(k) && usedCols.some((x) => v[k][x] !== 0n)))
    .map((k) => ({
      key: k,
      values: Object.fromEntries(usedCols.map((x) => [x, money(v[k][x]!)])),
      total: money(usedCols.reduce((a, x) => a + v[k][x]!, 0n)),
    }));
  const st = await statements(c, companyId, month, scope);
  const closingTotal = usedCols.reduce((a, x) => a + v.closing[x]!, 0n);
  return {
    month, scope, from: from.slice(0, 7), entityType: entity,
    columns: usedCols.map((k) => ({
      key: k,
      ...(k.startsWith('p') && k !== 'premium' ? { partner: partners.find((p) => `p${p.no}` === k)?.name ?? k } : {}),
      accounts: [...cols.get(k)!].map(([code, name]) => ({ code, name })),
    })),
    rows, netIncome: money(netIncome),
    positionEquity: st.totalEquity, matches: toC(st.totalEquity) === closingTotal,
  };
}
