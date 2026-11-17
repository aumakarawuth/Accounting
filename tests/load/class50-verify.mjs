// ตรวจฐานข้อมูลหลังทดสอบห้องเรียน 50 คน (tests/load/class50.mjs) ด้วยสิทธิ์ superuser อ่านอย่างเดียว
// node tests/load/class50-verify.mjs <DATABASE_URL superuser> <โฟลเดอร์ผล>
// ตรวจ: รายการดุลทุกใบ · account_balances = สมุดรายวัน · เลขที่เอกสารไม่ซ้ำไม่ข้าม · ไม่มีรายการซ้ำจากกดซ้ำ/เน็ตหลุด
// · จำนวนรายการต่อคนตรงที่คาด · คะแนนตรวจอัตโนมัติ (app.grade_company) ตรงเฉลยที่คาด · ประวัติส่งงานถูกลำดับ
// · ลงรายการหลังส่งตรวจไม่ได้ · audit log บันทึกครบ · การเปิดดูของครูถูกบันทึก
import pg from 'pg';
import { readFileSync, writeFileSync } from 'node:fs';

const [url, dir] = process.argv.slice(2);
const setup = JSON.parse(readFileSync(`${dir}/setup.json`, 'utf8'));
const report = JSON.parse(readFileSync(`${dir}/report.json`, 'utf8'));
const db = new pg.Client({ connectionString: url });
await db.connect();
const out = { checks: [], students: [] };
const check = (name, ok, detail = '') => { out.checks.push({ name, ok, detail }); console.log(`${ok ? 'ผ่าน' : 'ไม่ผ่าน'}  ${name}${detail ? ` — ${detail}` : ''}`); };

const cos = (await db.query(
  `select c.id, u.student_code code from acc.companies c join acc.users u on u.id = c.owner_id
    where c.assignment_id = $1 order by u.student_code`, [setup.assignment.id ?? setup.assignment.assignmentId])).rows;
check('บริษัทเปิดให้ครบทุกคน', cos.length === setup.students.length, `${cos.length}/${setup.students.length}`);
const ids = cos.map((c) => c.id);

const q1 = async (sql) => (await db.query(sql, [ids])).rows;
const unbalanced = await q1(`select entry_id from acc.journal_lines where company_id = any($1) group by entry_id having sum(debit) <> sum(credit)`);
check('ทุกรายการดุล (เดบิต = เครดิต)', unbalanced.length === 0, `${unbalanced.length} รายการไม่ดุล`);
const drift = await q1(`with j as (select l.company_id, l.account_id, e.period_id, sum(l.debit) d, sum(l.credit) c
      from acc.journal_lines l join acc.journal_entries e on e.company_id = l.company_id and e.id = l.entry_id where l.company_id = any($1) group by 1, 2, 3)
  select count(*)::int n from acc.account_balances b full join j using (company_id, account_id, period_id)
   where coalesce(b.company_id, j.company_id) = any($1) and (coalesce(b.debit_total, 0) <> coalesce(j.d, 0) or coalesce(b.credit_total, 0) <> coalesce(j.c, 0))`);
check('ยอดสะสม (account_balances) ตรงกับสมุดรายวันทุกบัญชี', drift[0].n === 0, `${drift[0].n} แถวไม่ตรง`);
const gaps = await q1(`select company_id, doc_prefix, count(*) n, max(split_part(doc_no, '-', 2)::int) mx, count(distinct doc_no) d
    from acc.journal_entries where company_id = any($1) group by 1, 2 having count(*) <> max(split_part(doc_no, '-', 2)::int) or count(*) <> count(distinct doc_no)`);
check('เลขที่เอกสารต่อเนื่อง ไม่ซ้ำ ไม่ข้าม', gaps.length === 0, `${gaps.length} ชุดผิด`);
const dupIdem = await q1(`select company_id, key from acc.idempotency_keys where company_id = any($1) group by 1, 2 having count(*) > 1`);
check('idempotency key ไม่ซ้ำ', dupIdem.length === 0);

let entryOk = 0, scoreOk = 0, histOk = 0;
for (const s of setup.students) {
  const co = cos.find((c) => c.code === s.code);
  const r = report.results.find((x) => x.code === s.code) ?? {};
  if (!co) { out.students.push({ code: s.code, problem: 'ไม่มีบริษัท' }); continue; }
  const e = (await db.query(`select doc_no, description, reverses_entry_id is not null rv,
      exists (select 1 from acc.journal_entries x where x.company_id = e.company_id and x.reverses_entry_id = e.id) reversed
      from acc.journal_entries e where company_id = $1 order by posted_at`, [co.id])).rows;
  const live = e.filter((x) => !x.rv && !x.reversed);
  const wrongN = Object.values(s.wrong).filter(Boolean).length;
  // 6 ข้อ + ข้อที่แก้: กลับรายการ 1 + ลงใหม่ 1 (ไม่มีรายการเกินจากกดซ้ำ/เน็ตหลุด/สองแท็บ)
  const wantTotal = 6 + wrongN * 2;
  const perItem = [1, 2, 3, 4, 5, 6].map((no) => live.filter((x) => x.description.startsWith(`ข้อ ${no} `)).length);
  const entriesGood = e.length === wantTotal && live.length === 6 && perItem.every((n) => n === 1);
  if (entriesGood) entryOk++;
  const grade = (await db.query(`select app.grade_company($1) g`, [co.id])).rows[0].g;
  const score = Number(grade?.score ?? grade?.total ?? NaN);
  if (score === 7) scoreOk++;
  const sub = (await db.query(`select s.status, s.score, s.round,
      (select json_agg(ev.action order by ev.at, ev.id) from acc.submission_events ev where ev.company_id = s.company_id) events
      from acc.submissions s where s.company_id = $1`, [co.id])).rows[0];
  const wantEvents = s.expected < 7 ? ['submit', 'review', 'return', 'submit', 'review', 'pass'] : ['submit', 'review', 'pass'];
  const histGood = sub && sub.status === 'passed' && JSON.stringify(sub.events) === JSON.stringify(wantEvents) && Number(sub.score) === 7;
  if (histGood) histOk++;
  out.students.push({ code: s.code, device: s.device.name, expected1: s.expected, autoScore1: r.autoScore1, autoScore2: r.autoScore2, finalAuto: score,
    teacherScore: sub?.score, status: sub?.status, events: sub?.events, entries: e.length, wantEntries: wantTotal, perItem,
    postAfterSubmit: r.postAfterSubmit, faults: { dblPost: s.dblPost, lostResponse: s.lostResponse, reloadMid: s.reloadMid, twoTabs: s.twoTabs, dblSubmit: s.dblSubmit } });
}
const n = setup.students.length;
check('จำนวนรายการต่อคนตรงที่คาด (ไม่มีรายการซ้ำจากกดซ้ำ/เน็ตหลุด/สองแท็บ)', entryOk === n, `${entryOk}/${n}`);
check('คะแนนตรวจอัตโนมัติสุดท้าย = 7/7 ทุกคน (หลังแก้)', scoreOk === n, `${scoreOk}/${n}`);
check('ประวัติส่งงานถูกลำดับ และสถานะสุดท้าย "ผ่าน" คะแนนครู 7', histOk === n, `${histOk}/${n}`);
const first = report.results.filter((r) => r.autoScore1 !== undefined);
check('คะแนนอัตโนมัติรอบแรกที่ครูเห็น = ที่คาดจากข้อผิดที่ตั้งใจ', first.length === n && first.every((r) => r.autoScore1 === r.expected),
  `${first.filter((r) => r.autoScore1 === r.expected).length}/${n}`);
check('ลงรายการหลังส่งตรวจถูกปฏิเสธทุกคน', report.results.every((r) => r.postAfterSubmit >= 400 && r.postAfterSubmit < 500),
  JSON.stringify([...new Set(report.results.map((r) => r.postAfterSubmit))]));
const audit = (await db.query(`select count(*)::int n from acc.audit_log where company_id = any($1)`, [ids]).catch(() => ({ rows: [{ n: -1 }] }))).rows[0].n;
check('audit log มีบันทึก', audit > 0, `${audit} แถว`);
const views = (await db.query(`select count(*)::int n from acc.audit_log where company_id = any($1) and op = 'VIEW'`, [ids]).catch(() => ({ rows: [{ n: -1 }] }))).rows[0].n;
check('การเปิดดูงานของครูถูกบันทึก', views > 0, `${views} ครั้ง`);
writeFileSync(`${dir}/verify.json`, JSON.stringify(out, null, 1));
await db.end();
process.exit(out.checks.every((c) => c.ok) ? 0 : 1);
