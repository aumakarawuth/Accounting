import type pg from 'pg';

// อายุหนี้ ณ วันที่ (นับจากวันครบกำหนด) ใช้ร่วมกันทั้งลูกหนี้ (ar_open_items) และเจ้าหนี้ (ap_open_items)
const BUCKETS = ['current', 'd30', 'd60', 'd90', 'over90'] as const;

export async function agingReport(c: pg.PoolClient, fn: 'acc.ar_open_items' | 'acc.ap_open_items', companyId: string, asOf?: string) {
  const day = asOf ?? (await c.query(`select to_char(now() at time zone 'Asia/Bangkok', 'YYYY-MM-DD') d`)).rows[0].d;
  const extra = fn === 'acc.ap_open_items' ? `o.vendor_doc_no as "vendorDocNo"` : `o.kind`;
  const r = await c.query(
    `select o.document_id as id, o.doc_no as "docNo", ${extra}, to_char(o.doc_date, 'YYYY-MM-DD') as date,
            to_char(o.due_date, 'YYYY-MM-DD') as "dueDate", o.party_code as "partyCode", o.party_name as "partyName",
            o.total::text, o.open::text, greatest($2::date - coalesce(o.due_date, o.doc_date), 0) as "daysOverdue",
            case when $2::date <= coalesce(o.due_date, o.doc_date) then 'current'
                 when $2::date - o.due_date <= 30 then 'd30' when $2::date - o.due_date <= 60 then 'd60'
                 when $2::date - o.due_date <= 90 then 'd90' else 'over90' end as bucket
       from ${fn}($1) o where o.doc_date <= $2::date`, [companyId, day]);
  const sum = (rows: { open: string; bucket: string }[], b?: string) =>
    rows.filter((x) => !b || x.bucket === b).reduce((s, x) => s + BigInt(x.open.replace('.', '')), 0n);
  const cents = (n: bigint) => `${n / 100n}.${(n % 100n).toString().padStart(2, '0')}`;
  const totals = (rows: { open: string; bucket: string }[]) =>
    ({ all: cents(sum(rows)), ...Object.fromEntries(BUCKETS.map((b) => [b, cents(sum(rows, b))])) });
  const parties = [...new Set(r.rows.map((x) => x.partyCode as string))].sort();
  return {
    asOf: day,
    items: r.rows,
    totals: totals(r.rows),
    byParty: parties.map((p) => {
      const rows = r.rows.filter((x) => x.partyCode === p);
      return { partyCode: p, partyName: rows[0].partyName, ...totals(rows) };
    }),
  };
}
