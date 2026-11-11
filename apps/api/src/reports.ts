import type pg from 'pg';
import { HttpError } from './errors.js';

// ข้อมูลรายงานชุดเดียวที่ใช้ทั้งหน้าจอ (JSON) และไฟล์ส่งออก (PDF/Excel) ตัวเลขตรงกันเสมอ
// เงินเป็นสตริงทศนิยมจาก SQL ตลอดทาง ไม่ผ่าน float · ผู้เรียกต้องตรวจสิทธิ์อ่าน (requireReadable) ก่อน

export type TrialBalanceData = {
  month: string;
  rows: { code: string; name: string; type: string; normalSide: 'debit' | 'credit'; debit: string; credit: string }[];
  totalDebit: string; totalCredit: string;
  /** before = ก่อนปิดบัญชี (ไม่รวม CL ของปีบัญชีนี้) · after = หลังปิดบัญชี */
  stage: 'before' | 'after';
  fiscalYear: { start: string; end: string };
  /** รายการปิดบัญชี (CL) ของปีบัญชีนี้ที่ลงในเดือนนี้: มี = เลือกดูหลังปิดบัญชีได้ */
  closingDocNos: string[];
  /** ปีบัญชีก่อนยังไม่ได้ปิดบัญชี: ยอดรายได้/ค่าใช้จ่ายปีก่อนยังรวมอยู่ */
  priorYearUnclosed: boolean;
};

/** ปีบัญชีของเดือน + มีรายได้/ค่าใช้จ่ายก่อนต้นปีบัญชีที่ยังไม่ได้ปิดบัญชีหรือไม่ */
export async function fiscalContext(c: pg.PoolClient, companyId: string, month: string) {
  const r = await c.query(
    `with fy as (select acc.fiscal_year_start($1, $2::date) as s)
     select fy.s::text as start, (fy.s + interval '1 year - 1 day')::date::text as "end",
            exists (select 1 from acc.journal_lines l
                      join acc.journal_entries e on e.company_id = l.company_id and e.id = l.entry_id
                      join acc.chart_of_accounts a on a.company_id = l.company_id and a.id = l.account_id
                     where l.company_id = $1 and e.entry_date < fy.s and a.type in ('revenue', 'expense')
                     group by a.id having sum(l.debit - l.credit) <> 0) as "priorYearUnclosed"
       from fy`, [companyId, `${month}-01`]);
  return r.rows[0] as { start: string; end: string; priorYearUnclosed: boolean };
}

// งบทดลอง: ยอดสะสมตั้งแต่เริ่มบริษัทถึงสิ้นเดือนที่เลือก (จาก account_balances)
// ก่อนปิดบัญชี (ค่าเริ่มต้น) หักรายการปิดบัญชี CL ของปีบัญชีนี้ออก ปีก่อนที่ปิดแล้วยอดอยู่ใน 3210
// ยอดสุทธิของแต่ละบัญชีลงช่องเดบิตหรือเครดิตช่องเดียว; ยอดรวมคำนวณใน SQL (ไม่บวกเงินใน JS)
export async function trialBalance(c: pg.PoolClient, companyId: string, month: string, all = false, stage: 'before' | 'after' = 'before'): Promise<TrialBalanceData> {
  const fy = await fiscalContext(c, companyId, month);
  const r = await c.query(
    `with cl as (
       select l.account_id, sum(l.debit - l.credit) as net
         from acc.journal_lines l join acc.journal_entries e on e.company_id = l.company_id and e.id = l.entry_id
        where l.company_id = $1 and e.doc_prefix = 'CL' and e.entry_date >= $4::date
          and e.entry_date < ($2::date + interval '1 month')
        group by l.account_id
     ), net as (
       select a.code, a.name, a.type, a.normal_side,
              coalesce(sum(b.debit_total - b.credit_total) filter (where p.start_date <= $2::date), 0)
                - case when $5 then 0 else coalesce(max(cl.net), 0) end as net
         from acc.chart_of_accounts a
         left join acc.account_balances b on b.company_id = a.company_id and b.account_id = a.id
         left join acc.periods p on p.company_id = b.company_id and p.id = b.period_id
         left join cl on cl.account_id = a.id
        where a.company_id = $1
        group by a.code, a.name, a.type, a.normal_side
     )
     select code, name, type, normal_side as "normalSide",
            greatest(net, 0)::numeric(18,2)::text as debit,
            greatest(-net, 0)::numeric(18,2)::text as credit,
            sum(greatest(net, 0)) over ()::numeric(18,2)::text as "totalDebit",
            sum(greatest(-net, 0)) over ()::numeric(18,2)::text as "totalCredit"
       from net
      where $3 or net <> 0
      order by code`,
    [companyId, `${month}-01`, all, fy.start, stage === 'after'],
  );
  const docs = await c.query(
    `select doc_no from acc.journal_entries
      where company_id = $1 and doc_prefix = 'CL' and entry_date >= $2::date and entry_date >= $3::date
        and entry_date < ($3::date + interval '1 month') order by doc_no`, [companyId, fy.start, `${month}-01`]);
  const first = r.rows[0];
  return {
    month,
    rows: r.rows.map(({ totalDebit: _d, totalCredit: _c, ...row }) => row),
    totalDebit: first?.totalDebit ?? '0.00',
    totalCredit: first?.totalCredit ?? '0.00',
    stage,
    fiscalYear: { start: fy.start, end: fy.end },
    closingDocNos: docs.rows.map((x) => x.doc_no as string),
    priorYearUnclosed: fy.priorYearUnclosed,
  };
}

export type LedgerAccountRow = { code: string; name: string; normalSide: 'debit' | 'credit'; opening: string; debit: string; credit: string; closing: string };

// บัญชีที่มีความเคลื่อนไหวหรือมียอดในเดือนนี้ ยอดหันตามด้านปกติของบัญชี: บวก = ด้านปกติ, ติดลบ = กลับด้าน
export async function ledgerAccounts(c: pg.PoolClient, companyId: string, month: string): Promise<LedgerAccountRow[]> {
  const r = await c.query(
    `with s as (
       select a.code, a.name, a.normal_side,
              case a.normal_side when 'debit' then 1 else -1 end as sign,
              coalesce(sum(b.debit_total - b.credit_total) filter (where p.start_date < $2::date), 0) as open_net,
              coalesce(sum(b.debit_total) filter (where p.start_date = $2::date), 0) as dr,
              coalesce(sum(b.credit_total) filter (where p.start_date = $2::date), 0) as cr
         from acc.chart_of_accounts a
         join acc.account_balances b on b.company_id = a.company_id and b.account_id = a.id
         join acc.periods p on p.company_id = b.company_id and p.id = b.period_id
        where a.company_id = $1 and p.start_date <= $2::date
        group by a.code, a.name, a.normal_side
     )
     select code, name, normal_side as "normalSide",
            (open_net * sign)::numeric(18,2)::text as opening,
            dr::numeric(18,2)::text as debit, cr::numeric(18,2)::text as credit,
            ((open_net + dr - cr) * sign)::numeric(18,2)::text as closing
       from s where open_net <> 0 or dr <> 0 or cr <> 0
      order by code`,
    [companyId, `${month}-01`],
  );
  return r.rows;
}

export type LedgerData = {
  month: string;
  account: { code: string; name: string; type: string; normalSide: 'debit' | 'credit' };
  opening: string; closing: string; totalDebit: string; totalCredit: string;
  lines: { date: string; docNo: string; description: string; memo: string; debit: string; credit: string; balance: string; reversal: boolean }[];
};

// แยกประเภทบัญชีเดียว ในเดือนที่เลือก: ยอดยกมา → รายการ (ยอดคงเหลือต่อเนื่อง) → ยอดยกไป
export async function ledger(c: pg.PoolClient, companyId: string, month: string, account: string): Promise<LedgerData> {
  const a = (await c.query(
    `select id, code, name, type, normal_side from acc.chart_of_accounts where company_id = $1 and code = $2`,
    [companyId, account])).rows[0];
  if (!a) throw new HttpError(404, 'not_found', `ไม่พบรหัสบัญชี ${account}`);
  const from = `${month}-01`;
  const r = await c.query(
    `with sign as (select case $3::text when 'debit' then 1 else -1 end as s),
     opening as (
       select coalesce(sum(l.debit - l.credit), 0) as net
         from acc.journal_lines l join acc.journal_entries e on e.company_id = l.company_id and e.id = l.entry_id
        where l.company_id = $1 and l.account_id = $2 and e.entry_date < $4::date
     ), lines as (
       select e.entry_date, e.posted_at, l.line_no, e.doc_no, e.description, l.memo, l.debit, l.credit,
              e.reverses_entry_id is not null as reversal
         from acc.journal_lines l join acc.journal_entries e on e.company_id = l.company_id and e.id = l.entry_id
        where l.company_id = $1 and l.account_id = $2
          and e.entry_date >= $4::date and e.entry_date < ($4::date + interval '1 month')
     )
     select (select (net * s)::numeric(18,2)::text from opening, sign) as opening,
            coalesce(json_agg(json_build_object(
              'date', entry_date::text, 'docNo', doc_no, 'description', description, 'memo', memo,
              'debit', debit::text, 'credit', credit::text, 'reversal', reversal,
              'balance', (((select net from opening) + running) * (select s from sign))::numeric(18,2)::text)
              order by entry_date, posted_at, line_no), '[]') as lines,
            (select coalesce(sum(debit), 0)::numeric(18,2)::text from lines) as "totalDebit",
            (select coalesce(sum(credit), 0)::numeric(18,2)::text from lines) as "totalCredit",
            (((select net from opening) + coalesce((select sum(debit - credit) from lines), 0)) * (select s from sign))::numeric(18,2)::text as closing
       from (select *, sum(debit - credit) over (order by entry_date, posted_at, line_no) as running from lines) x`,
    [companyId, a.id, a.normal_side, from],
  );
  return {
    month,
    account: { code: a.code, name: a.name, type: a.type, normalSide: a.normal_side },
    ...r.rows[0],
  };
}

type StLine = { code: string; name: string; amount: string };
export type StatementsData = {
  month: string; scope: 'month' | 'ytd'; from: string;
  fiscalYear: { start: string; end: string };
  revenue: StLine[]; expense: StLine[]; assets: StLine[]; liabilities: StLine[]; equity: StLine[];
  totalRevenue: string; totalExpense: string; netIncome: string;
  /** กำไรที่ยังไม่ได้โอนเข้าบัญชีทุน = yearProfit + priorUnclosedProfit */
  unclosedProfit: string;
  /** กำไร(ขาดทุน)สุทธิตั้งแต่ต้นปีบัญชีถึงสิ้นเดือนนี้ */
  yearProfit: string;
  /** กำไร(ขาดทุน)ของปีบัญชีก่อนที่ยังไม่ได้ปิดบัญชี */
  priorUnclosedProfit: string;
  totalAssets: string; totalLiabilities: string; totalEquity: string; totalLiabilitiesEquity: string; balanced: boolean;
  /** งบกำไรขาดทุนหลายขั้น (docs/phase5-spec.md ข้อ 2) */
  multiStep: IncomeMultiStep;
  /** งบแสดงฐานะการเงินแยกหมุนเวียน/ไม่หมุนเวียน */
  classified: ClassifiedPosition;
};

export type CostOfSales = {
  opening: string; purchases: string; discounts: string; returns: string; otherCosts: StLine[];
  netPurchases: string; available: string; closing: string; adjustments: string; total: string;
};
export type IncomeMultiStep = {
  sales: StLine[]; netSales: string;
  costOfSales: CostOfSales | null;
  grossProfit: string;
  otherIncome: StLine[]; totalOtherIncome: string;
  sellingAdmin: StLine[]; totalSellingAdmin: string;
  otherExpenses: StLine[]; totalOtherExpenses: string;
  profitBeforeFinance: string;
  financeCosts: StLine[]; totalFinanceCosts: string;
  profitBeforeTax: string;
  incomeTax: StLine[]; totalIncomeTax: string;
  netIncome: string;
};
export type ClassifiedPosition = {
  currentAssets: StLine[]; totalCurrentAssets: string; nonCurrentAssets: StLine[]; totalNonCurrentAssets: string;
  currentLiabilities: StLine[]; totalCurrentLiabilities: string; nonCurrentLiabilities: StLine[]; totalNonCurrentLiabilities: string;
};

// ---- จัดกลุ่มตามรหัสบัญชี (ผังไทย: หลักที่สองบอกกลุ่มย่อย) ----
type IncomeGroup = 'sales' | 'otherIncome' | 'cogs' | 'sellingAdmin' | 'otherExpenses' | 'financeCosts' | 'incomeTax';
export function incomeGroup(code: string, type: 'revenue' | 'expense'): IncomeGroup {
  if (type === 'revenue') return /^4[12]/.test(code) ? 'sales' : 'otherIncome';
  if (code.startsWith('51')) return 'cogs';
  if (code.startsWith('531')) return 'financeCosts';
  if (code.startsWith('53')) return 'otherExpenses';
  if (/^5[4-9]/.test(code)) return 'incomeTax';
  return 'sellingAdmin';
}
/** สินทรัพย์ 11–15 / หนี้สิน 21–25 = หมุนเวียน */
export const isCurrent = (code: string) => /^[12][1-5]/.test(code);

const toC = (v: string): bigint => {
  const neg = v.startsWith('-');
  const [i, f = ''] = (neg ? v.slice(1) : v).split('.');
  const c = BigInt(i || '0') * 100n + BigInt((f + '00').slice(0, 2));
  return neg ? -c : c;
};
const sumC = (lines: StLine[]) => lines.reduce((a, l) => a + toC(l.amount), 0n);

async function multiStepParts(
  c: pg.PoolClient, companyId: string, from: string, to: string, fyStart: string,
  revenue: StLine[], expense: StLine[], assets: StLine[], liabilities: StLine[],
): Promise<{ multiStep: IncomeMultiStep; classified: ClassifiedPosition }> {
  const g: Record<IncomeGroup, StLine[]> = { sales: [], otherIncome: [], cogs: [], sellingAdmin: [], otherExpenses: [], financeCosts: [], incomeTax: [] };
  for (const l of revenue) g[incomeGroup(l.code, 'revenue')].push(l);
  for (const l of expense) g[incomeGroup(l.code, 'expense')].push(l);

  // ต้นทุนขาย: 1310 ต้น/ปลายงวด + บัญชี 51xx จากรายการที่ไม่ได้ลง 1310 (รายการที่ลง 1310 = โอนภายในของระบบต่อเนื่อง)
  const inv = (await c.query(
    `select coalesce(sum(l.debit - l.credit) filter (where e.entry_date < $2::date), 0)::numeric(18,2)::text as opening,
            coalesce(sum(l.debit - l.credit) filter (where e.entry_date < ($3::date + interval '1 month')), 0)::numeric(18,2)::text as closing
       from acc.journal_lines l
       join acc.journal_entries e on e.company_id = l.company_id and e.id = l.entry_id
       join acc.chart_of_accounts a on a.company_id = l.company_id and a.id = l.account_id
      where l.company_id = $1 and a.code = '1310'`, [companyId, from, to])).rows[0] as { opening: string; closing: string };
  const flows = (await c.query(
    `with ent as (
       select e.id from acc.journal_entries e
        where e.company_id = $1 and e.entry_date >= $2::date and e.entry_date < ($3::date + interval '1 month')
          and not (e.doc_prefix = 'CL' and e.entry_date >= $4::date)
          and not exists (select 1 from acc.journal_lines x join acc.chart_of_accounts xa on xa.company_id = x.company_id and xa.id = x.account_id
                           where x.company_id = e.company_id and x.entry_id = e.id and xa.code = '1310')
     )
     select a.code, a.name, sum(l.debit - l.credit)::numeric(18,2)::text as net
       from ent join acc.journal_lines l on l.company_id = $1 and l.entry_id = ent.id
       join acc.chart_of_accounts a on a.company_id = l.company_id and a.id = l.account_id
      where a.type = 'expense' and a.code like '51%'
      group by a.code, a.name having sum(l.debit - l.credit) <> 0
      order by a.code`, [companyId, from, to, fyStart])).rows as { code: string; name: string; net: string }[];
  const flow = (code: string) => toC(flows.find((f) => f.code === code)?.net ?? '0.00');
  const total = sumC(g.cogs);
  const opening = toC(inv.opening), closing = toC(inv.closing);
  let costOfSales: CostOfSales | null = null;
  if (total !== 0n || opening !== 0n || closing !== 0n || flows.length > 0) {
    const purchases = flow('5110'), discounts = -flow('5120'), returns = -flow('5140');
    const otherCosts = flows.filter((f) => !['5110', '5120', '5130', '5140'].includes(f.code)).map((f) => ({ code: f.code, name: f.name, amount: f.net }));
    const netPurchases = purchases - discounts - returns + sumC(otherCosts);
    const available = opening + netPurchases;
    costOfSales = {
      opening: money(opening), purchases: money(purchases), discounts: money(discounts), returns: money(returns), otherCosts,
      netPurchases: money(netPurchases), available: money(available), closing: money(closing),
      adjustments: money(total - (available - closing)), total: money(total),
    };
  }
  const netSales = sumC(g.sales);
  const gross = netSales - total;
  const oi = sumC(g.otherIncome), sa = sumC(g.sellingAdmin), oe = sumC(g.otherExpenses), fc = sumC(g.financeCosts), tax = sumC(g.incomeTax);
  const pbf = gross + oi - sa - oe;
  const pbt = pbf - fc;
  const cur = (ls: StLine[], want: boolean) => ls.filter((l) => isCurrent(l.code) === want);
  const ca = cur(assets, true), nca = cur(assets, false), cl = cur(liabilities, true), ncl = cur(liabilities, false);
  return {
    multiStep: {
      sales: g.sales, netSales: money(netSales), costOfSales, grossProfit: money(gross),
      otherIncome: g.otherIncome, totalOtherIncome: money(oi),
      sellingAdmin: g.sellingAdmin, totalSellingAdmin: money(sa),
      otherExpenses: g.otherExpenses, totalOtherExpenses: money(oe),
      profitBeforeFinance: money(pbf),
      financeCosts: g.financeCosts, totalFinanceCosts: money(fc),
      profitBeforeTax: money(pbt),
      incomeTax: g.incomeTax, totalIncomeTax: money(tax),
      netIncome: money(pbt - tax),
    },
    classified: {
      currentAssets: ca, totalCurrentAssets: money(sumC(ca)), nonCurrentAssets: nca, totalNonCurrentAssets: money(sumC(nca)),
      currentLiabilities: cl, totalCurrentLiabilities: money(sumC(cl)), nonCurrentLiabilities: ncl, totalNonCurrentLiabilities: money(sumC(ncl)),
    },
  };
}

// งบการเงิน: กำไรขาดทุน (เดือนนี้หรือต้นปีบัญชีถึงเดือนนี้) + ฐานะการเงิน ณ สิ้นเดือน
// ยอดหันตามด้านปกติ (บัญชีปรับลด เช่น ค่าเสื่อมราคาสะสม/ถอนใช้ส่วนตัว/ส่วนลด จึงติดลบ = หักออก)
// ก่อนปิดบัญชี: ไม่รวมรายการปิดบัญชี (CL) ของปีบัญชีนี้ · กำไรปีนี้และกำไรปีก่อนที่ยังไม่ได้ปิดบัญชีแสดงแยกในส่วนทุน
export async function statements(c: pg.PoolClient, companyId: string, month: string, scope: 'month' | 'ytd'): Promise<StatementsData> {
  const to = `${month}-01`;
  const fy = await fiscalContext(c, companyId, month);
  const from = scope === 'month' ? to : fy.start;
  const r = await c.query(
    `with cl as (
       select l.account_id, sum(l.debit - l.credit) as net
         from acc.journal_lines l join acc.journal_entries e on e.company_id = l.company_id and e.id = l.entry_id
        where l.company_id = $1 and e.doc_prefix = 'CL' and e.entry_date >= $4::date
          and e.entry_date < ($3::date + interval '1 month')
        group by l.account_id
     ), b as (
       select a.code, a.name, a.type, case a.normal_side when 'debit' then 1 else -1 end as s,
              coalesce(sum(x.debit_total - x.credit_total) filter (where p.start_date between $2::date and $3::date), 0)
                - coalesce(max(cl.net), 0) as period_net,
              coalesce(sum(x.debit_total - x.credit_total) filter (where p.start_date between $4::date and $3::date), 0)
                - coalesce(max(cl.net), 0) as year_net,
              coalesce(sum(x.debit_total - x.credit_total) filter (where p.start_date <= $3::date), 0)
                - coalesce(max(cl.net), 0) as cum_net
         from acc.chart_of_accounts a
         left join acc.account_balances x on x.company_id = a.company_id and x.account_id = a.id
         left join acc.periods p on p.company_id = x.company_id and p.id = x.period_id
         left join cl on cl.account_id = a.id
        where a.company_id = $1
        group by a.code, a.name, a.type, a.normal_side
     ), lines as (
       select type, code, name, (period_net * s) as period_amt, (year_net * s) as year_amt, (cum_net * s) as balance from b
     ), t as (
       select coalesce(sum(period_amt) filter (where type = 'revenue'), 0) as rev,
              coalesce(sum(period_amt) filter (where type = 'expense'), 0) as exp,
              coalesce(sum(year_amt) filter (where type = 'revenue'), 0) - coalesce(sum(year_amt) filter (where type = 'expense'), 0) as year_profit,
              coalesce(sum(balance) filter (where type = 'revenue'), 0) - coalesce(sum(balance) filter (where type = 'expense'), 0) as unclosed,
              coalesce(sum(balance) filter (where type = 'asset'), 0) as assets,
              coalesce(sum(balance) filter (where type = 'liability'), 0) as liabilities,
              coalesce(sum(balance) filter (where type = 'equity'), 0) as equity
         from lines
     )
     select json_build_object(
       'revenue', (select coalesce(json_agg(json_build_object('code', code, 'name', name, 'amount', period_amt::numeric(18,2)::text) order by code), '[]') from lines where type = 'revenue' and period_amt <> 0),
       'expense', (select coalesce(json_agg(json_build_object('code', code, 'name', name, 'amount', period_amt::numeric(18,2)::text) order by code), '[]') from lines where type = 'expense' and period_amt <> 0),
       'assets', (select coalesce(json_agg(json_build_object('code', code, 'name', name, 'amount', balance::numeric(18,2)::text) order by code), '[]') from lines where type = 'asset' and balance <> 0),
       'liabilities', (select coalesce(json_agg(json_build_object('code', code, 'name', name, 'amount', balance::numeric(18,2)::text) order by code), '[]') from lines where type = 'liability' and balance <> 0),
       'equity', (select coalesce(json_agg(json_build_object('code', code, 'name', name, 'amount', balance::numeric(18,2)::text) order by code), '[]') from lines where type = 'equity' and balance <> 0),
       'totalRevenue', rev::numeric(18,2)::text,
       'totalExpense', exp::numeric(18,2)::text,
       'netIncome', (rev - exp)::numeric(18,2)::text,
       'unclosedProfit', unclosed::numeric(18,2)::text,
       'yearProfit', year_profit::numeric(18,2)::text,
       'priorUnclosedProfit', (unclosed - year_profit)::numeric(18,2)::text,
       'totalAssets', assets::numeric(18,2)::text,
       'totalLiabilities', liabilities::numeric(18,2)::text,
       'totalEquity', (equity + unclosed)::numeric(18,2)::text,
       'totalLiabilitiesEquity', (liabilities + equity + unclosed)::numeric(18,2)::text,
       'balanced', assets = liabilities + equity + unclosed
     ) as st from t`,
    [companyId, from, to, fy.start],
  );
  const st = r.rows[0].st;
  const parts = await multiStepParts(c, companyId, from, to, fy.start, st.revenue, st.expense, st.assets, st.liabilities);
  return { month, scope, from: from.slice(0, 7), fiscalYear: { start: fy.start, end: fy.end }, ...st, ...parts };
}

// ---- กระดาษทำการ ----
// 10 ช่อง: งบทดลอง · ปรับปรุง · งบทดลองหลังปรับปรุง · กำไรขาดทุน · ฐานะการเงิน
// 8 ช่อง: ไม่มีงบทดลองหลังปรับปรุง · 6 ช่อง: ไม่มีปรับปรุง งบทดลองใช้ยอดหลังปรับปรุง
// เงินคิดเป็นสตางค์ (BigInt) ไม่ใช้ทศนิยมของ JS
type Pair = { debit: string; credit: string };
const money = (c: bigint) => {
  const neg = c < 0n;
  const a = neg ? -c : c;
  return `${neg ? '-' : ''}${a / 100n}.${String(a % 100n).padStart(2, '0')}`;
};
const side = (net: bigint): Pair => ({ debit: money(net > 0n ? net : 0n), credit: money(net < 0n ? -net : 0n) });
const ZERO = { d: 0n, c: 0n };

export type WorksheetRow = { code: string; name: string; type: string; tb: Pair; adj: Pair; atb: Pair; is: Pair | null; bs: Pair | null };
export type WorksheetData =
  | { month: string; formats: number[]; format: null }
  | {
      month: string; formats: number[]; format: number; rows: WorksheetRow[];
      fiscalYear: { start: string; end: string }; priorYearUnclosed: boolean;
      totals: { tb: Pair; adj: Pair; atb: Pair; is: Pair; bs: Pair };
      netIncome: string; result: { is: Pair; bs: Pair }; grand: { is: Pair; bs: Pair };
    };

export async function worksheet(c: pg.PoolClient, companyId: string, month: string, requested?: string): Promise<WorksheetData> {
  const fr = await c.query(
    `select s.worksheet_formats::int[] as formats from acc.companies co join acc.schools s on s.id = co.school_id where co.id = $1`, [companyId]);
  const formats: number[] = fr.rows[0]?.formats ?? [];
  if (formats.length === 0) return { month, formats, format: null };
  const format = requested ? Number(requested) : formats[formats.length - 1]!;
  if (!formats.includes(format)) throw new HttpError(403, 'disabled', `โรงเรียนยังไม่เปิดใช้กระดาษทำการแบบ ${format} ช่อง`);

  const r = await c.query(
    `select code, name, type, (unadjusted * 100)::bigint::text as u, (adj_debit * 100)::bigint::text as ad, (adj_credit * 100)::bigint::text as ac
       from acc.worksheet($1, $2)`, [companyId, `${month}-01`]);
  const sum = { tb: { ...ZERO }, adj: { ...ZERO }, atb: { ...ZERO }, is: { ...ZERO }, bs: { ...ZERO } };
  const add = (k: keyof typeof sum, net: bigint) => { if (net > 0n) sum[k].d += net; else sum[k].c -= net; };
  const rows = r.rows.flatMap((x): WorksheetRow[] => {
    const u = BigInt(x.u), ad = BigInt(x.ad), ac = BigInt(x.ac);
    const adjusted = u + ad - ac;
    const tbNet = format === 6 ? adjusted : u;
    if (tbNet === 0n && ad === 0n && ac === 0n && adjusted === 0n) return [];
    const pl = x.type === 'revenue' || x.type === 'expense';
    add('tb', tbNet);
    sum.adj.d += ad; sum.adj.c += ac;
    add('atb', adjusted);
    add(pl ? 'is' : 'bs', adjusted);
    return [{
      code: x.code as string, name: x.name as string, type: x.type as string,
      tb: side(tbNet), adj: { debit: money(ad), credit: money(ac) }, atb: side(adjusted),
      is: pl ? side(adjusted) : null, bs: pl ? null : side(adjusted),
    }];
  });
  // กำไรสุทธิ = เครดิตงบกำไรขาดทุน − เดบิต (ใส่ฝั่งที่น้อยกว่าของงบกำไรขาดทุน และฝั่งตรงข้ามของงบฐานะการเงิน)
  const net = sum.is.c - sum.is.d;
  const fy = await fiscalContext(c, companyId, month);
  const pair = (k: keyof typeof sum) => ({ debit: money(sum[k].d), credit: money(sum[k].c) });
  return {
    month, formats, format, rows,
    fiscalYear: { start: fy.start, end: fy.end }, priorYearUnclosed: fy.priorYearUnclosed,
    totals: { tb: pair('tb'), adj: pair('adj'), atb: pair('atb'), is: pair('is'), bs: pair('bs') },
    netIncome: money(net),
    result: {
      is: { debit: money(net > 0n ? net : 0n), credit: money(net < 0n ? -net : 0n) },
      bs: { debit: money(net < 0n ? -net : 0n), credit: money(net > 0n ? net : 0n) },
    },
    grand: {
      is: { debit: money(sum.is.d + (net > 0n ? net : 0n)), credit: money(sum.is.c + (net < 0n ? -net : 0n)) },
      bs: { debit: money(sum.bs.d + (net < 0n ? -net : 0n)), credit: money(sum.bs.c + (net > 0n ? net : 0n)) },
    },
  };
}
