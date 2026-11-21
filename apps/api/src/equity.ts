import type pg from 'pg';
import { fiscalContext, statements } from './reports.js';

// งบแสดงการเปลี่ยนแปลงส่วนของเจ้าของ (docs/phase6-spec.md ข้อ 3) เงินคิดเป็นสตางค์ (BigInt)
// ไม่รวมรายการปิดบัญชี (CL) ของงวด (กำไรยังแสดงเป็นกำไรสุทธิ) · ยอดยกมา (OB) ในงวด = ยอดต้นงวด
// รวมปลายงวดต้องเท่า "รวมส่วนของเจ้าของ" ในงบแสดงฐานะการเงิน

export type EquityCol = 'capital' | 'retained' | 'drawings' | 'other';
export type EquityRowKey = 'opening' | 'contribution' | 'withdrawal' | 'drawings' | 'netIncome' | 'other' | 'closing';
export type EquityChangesData = {
  month: string; scope: 'month' | 'ytd'; from: string;
  columns: { key: EquityCol; accounts: { code: string; name: string }[] }[];
  rows: { key: EquityRowKey; values: Partial<Record<EquityCol, string>>; total: string }[];
  netIncome: string;
  /** รวมส่วนของเจ้าของในงบแสดงฐานะการเงิน ณ สิ้นงวด */
  positionEquity: string; matches: boolean;
};

export const equityColumn = (code: string): EquityCol =>
  code.startsWith('31') ? 'capital' : code.startsWith('32') ? 'retained' : code.startsWith('33') ? 'drawings' : 'other';

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

export async function equityChanges(c: pg.PoolClient, companyId: string, month: string, scope: 'month' | 'ytd'): Promise<EquityChangesData> {
  const to = `${month}-01`;
  const fy = await fiscalContext(c, companyId, month);
  const from = scope === 'month' ? to : fy.start;
  // ยอดก่อนต้นงวด (รวม CL ของปีก่อน) ของบัญชีทุนและกำไรขาดทุนที่ยังไม่ปิด
  const before = await c.query(
    `select a.code, a.name, a.type, coalesce(sum(b.credit_total - b.debit_total), 0)::numeric(18,2)::text as net
       from acc.chart_of_accounts a
       left join acc.account_balances b on b.company_id = a.company_id and b.account_id = a.id
        and b.period_id = any (array(select p.id from acc.periods p where p.company_id = $1 and p.start_date < $2::date))
      where a.company_id = $1 and a.type in ('equity', 'revenue', 'expense')
      group by a.code, a.name, a.type order by a.code`, [companyId, from]);
  // บรรทัดในงวด (ไม่รวม CL)
  const lines = await c.query(
    `select a.code, a.type, e.doc_prefix as prefix, l.debit::text as debit, l.credit::text as credit
       from acc.journal_lines l
       join acc.chart_of_accounts a on a.company_id = l.company_id and a.id = l.account_id
       join acc.journal_entries e on e.company_id = l.company_id and e.id = l.entry_id
      where l.company_id = $1 and a.type in ('equity', 'revenue', 'expense')
        and l.entry_id = any (array(select x.id from acc.journal_entries x where x.company_id = $1 and x.entry_date >= $2::date
              and x.entry_date < ($3::date + interval '1 month') and x.doc_prefix <> 'CL'))`,
    [companyId, from, to]);

  const cols: Record<EquityCol, Map<string, string>> = { capital: new Map(), retained: new Map(), drawings: new Map(), other: new Map() };
  const v: Record<EquityRowKey, Record<EquityCol, bigint>> = Object.fromEntries(
    (['opening', 'contribution', 'withdrawal', 'drawings', 'netIncome', 'other', 'closing'] as const)
      .map((k) => [k, { capital: 0n, retained: 0n, drawings: 0n, other: 0n }])) as never;
  for (const r of before.rows as { code: string; name: string; type: string; net: string }[]) {
    if (r.type === 'equity') {
      const col = equityColumn(r.code);
      cols[col].set(r.code, r.name);
      v.opening[col] += toC(r.net);
    } else v.opening.retained += toC(r.net); // กำไรขาดทุนก่อนต้นงวดที่ยังไม่ได้ปิดบัญชี
  }
  let netIncome = 0n;
  for (const l of lines.rows as { code: string; type: string; prefix: string; debit: string; credit: string }[]) {
    const d = toC(l.debit), cr = toC(l.credit);
    if (l.prefix === 'OB') { // ยอดยกมาในงวด = ยอดต้นงวด
      v.opening[l.type === 'equity' ? equityColumn(l.code) : 'retained'] += cr - d;
      continue;
    }
    if (l.type !== 'equity') { netIncome += cr - d; continue; }
    const col = equityColumn(l.code);
    if (col === 'capital') { v.contribution.capital += cr; v.withdrawal.capital -= d; }
    else if (col === 'drawings') v.drawings.drawings += cr - d;
    else v.other[col] += cr - d;
  }
  v.netIncome.retained = netIncome;
  const keys: EquityCol[] = ['capital', 'retained', 'drawings', 'other'];
  for (const k of keys) v.closing[k] = (['opening', 'contribution', 'withdrawal', 'drawings', 'netIncome', 'other'] as const).reduce((a, r) => a + v[r][k], 0n);
  // ส่วนของเจ้าของแสดงยอดด้านเครดิตเป็นบวก ถอนใช้ (เดบิต) จึงติดลบ = หักออก
  const usedCols = keys.filter((k) => k === 'capital' || k === 'retained' || cols[k].size > 0
    || Object.values(v).some((row) => row[k] !== 0n));
  const rowKeys: EquityRowKey[] = ['opening', 'contribution', 'withdrawal', 'drawings', 'netIncome', 'other', 'closing'];
  const rows = rowKeys
    .filter((k) => k === 'opening' || k === 'netIncome' || k === 'closing' || usedCols.some((col) => v[k][col] !== 0n))
    .map((k) => ({
      key: k,
      values: Object.fromEntries(usedCols.map((col) => [col, money(v[k][col])])) as Partial<Record<EquityCol, string>>,
      total: money(usedCols.reduce((a, col) => a + v[k][col], 0n)),
    }));
  const st = await statements(c, companyId, month, scope);
  const closingTotal = usedCols.reduce((a, col) => a + v.closing[col], 0n);
  return {
    month, scope, from: from.slice(0, 7),
    columns: usedCols.map((k) => ({ key: k, accounts: [...cols[k]].map(([code, name]) => ({ code, name })) })),
    rows, netIncome: money(netIncome),
    positionEquity: st.totalEquity, matches: toC(st.totalEquity) === closingTotal,
  };
}
