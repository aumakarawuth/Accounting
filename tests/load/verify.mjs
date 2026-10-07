// ตรวจความถูกต้องหลังทดสอบโหลด (ฐาน accounting_load): ทุกบริษัทต้องดุล ยอดคงเหลือตรง ไม่มีรายการซ้ำ เลขที่ไม่ข้าม
// node tests/load/verify.mjs <ADMIN_LOAD_URL> [entries_confirmed] [entries_unknown]
import pg from 'pg';
const [url, okArg, unknownArg] = process.argv.slice(2);
const c = new pg.Client({ connectionString: url });
await c.connect();
const q = async (sql) => (await c.query(sql)).rows[0];
const r = {
  entries: Number((await q(`select count(*) n from acc.journal_entries`)).n),
  companiesWithEntries: Number((await q(`select count(distinct company_id) n from acc.journal_entries`)).n),
  unbalancedEntries: Number((await q(`select count(*) n from (select entry_id from acc.journal_lines group by company_id, entry_id having sum(debit) <> sum(credit)) x`)).n),
  unbalancedCompanies: Number((await q(`select count(*) n from (select company_id from acc.journal_lines group by company_id having sum(debit) <> sum(credit)) x`)).n),
  balanceMismatches: Number((await q(`
    with t as (select e.company_id, e.period_id, l.account_id, sum(l.debit) d, sum(l.credit) c
                 from acc.journal_lines l join acc.journal_entries e on e.company_id = l.company_id and e.id = l.entry_id group by 1,2,3)
    select count(*) n from t full join acc.account_balances b using (company_id, period_id, account_id)
     where t.d is distinct from b.debit_total or t.c is distinct from b.credit_total`)).n),
  docNoGaps: Number((await q(`
    select count(*) n from (select company_id, doc_prefix, count(*) cnt, max(substring(doc_no from '\\d+$')::int) mx
                              from acc.journal_entries group by 1,2) x where cnt <> mx`)).n),
  entriesWithoutKey: Number((await q(`select count(*) n from acc.journal_entries e where not exists
    (select 1 from acc.idempotency_keys k where k.company_id = e.company_id and k.entry_id = e.id)`)).n),
  keysPerEntryOver1: Number((await q(`select count(*) n from (select entry_id from acc.idempotency_keys where entry_id is not null group by entry_id having count(*) > 1) x`)).n),
  spectateSessions: Number((await q(`select count(*) n from acc.spectate_log`)).n),
  openSpectates: Number((await q(`select count(*) n from acc.spectate_log where ended_at is null`)).n),
};
await c.end();
const ok = Number(okArg ?? NaN), unknown = Number(unknownArg ?? 0);
const checks = {
  'ทุกรายการดุล': r.unbalancedEntries === 0,
  'ทุกบริษัทดุล': r.unbalancedCompanies === 0,
  'account_balances ตรงกับสมุดรายวัน': r.balanceMismatches === 0,
  'เลขที่เอกสารไม่ข้าม': r.docNoGaps === 0,
  'ทุกรายการมี idempotency key เดียว (ไม่มีซ้ำ)': r.entriesWithoutKey === 0 && r.keysPerEntryOver1 === 0,
  ...(Number.isFinite(ok) ? { [`จำนวนรายการอยู่ระหว่างที่ยืนยัน (${ok}) ถึงยืนยัน+ไม่แน่ใจ (${ok + unknown})`]: r.entries >= ok && r.entries <= ok + unknown } : {}),
};
console.log(JSON.stringify(r, null, 2));
for (const [k, v] of Object.entries(checks)) console.log(`${v ? 'ผ่าน' : 'ไม่ผ่าน'}  ${k}`);
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
