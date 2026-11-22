import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { curriculumApp } from './curriculum-helpers';
import { pool as db, newSchool, newUser, newClassroom, newCompany } from './helpers';

// เฟส 7 โมดูล 5: แม่แบบรายการ / รายการประจำเดือน (docs/phase7-spec.md ข้อ 5)
// ค่าเช่าเดือนละ 8,000 ทุกวันที่ 31 (เดือนสั้น = วันสุดท้าย) เริ่ม ม.ค. 2570 · ลงจากรายการในสมุดรายวัน · แก้ยอดตอนลงได้ · กลับรายการ = ค้างอีก
const { ok, as, close } = curriculumApp();
afterAll(close);
let owner: string, other: string, co: string, entryId: string, tid: string;
const lines = async (entry: string) => Object.fromEntries((await db.query(
  `select a.code, l.debit::text d, l.credit::text c from acc.journal_lines l join acc.chart_of_accounts a on a.company_id = l.company_id and a.id = l.account_id
    where l.entry_id = $1 order by a.code`, [entry])).rows.map((r) => [r.code, [r.d, r.c]]));

beforeAll(async () => {
  const school = await newSchool();
  const teacher = await newUser(school, 'teacher');
  owner = await newUser(school, 'student');
  other = await newUser(school, 'student');
  await newClassroom(school, teacher, [owner, other]);
  co = await newCompany(owner, null);
  await ok(owner, 'POST', `/companies/${co}/journal`, { date: '2026-12-01', description: 'ลงทุน', lines: [{ account_code: '1110', debit: '100000' }, { account_code: '3110', credit: '100000' }] });
  entryId = (await ok(owner, 'POST', `/companies/${co}/journal`, { date: '2026-12-31', description: 'จ่ายค่าเช่าร้าน', lines: [{ account_code: '5220', debit: '8000' }, { account_code: '1110', credit: '8000' }] })).id;
});

describe('แม่แบบรายการ', () => {
  it('บันทึกรายการในสมุดรายวันเป็นแม่แบบประจำเดือน', async () => {
    const t = await ok(owner, 'POST', `/companies/${co}/templates`, { name: 'ค่าเช่ารายเดือน', fromEntry: entryId, recurring: true, dayOfMonth: 31, startMonth: '2027-01' });
    tid = t.id;
    const d = await ok(owner, 'GET', `/companies/${co}/templates?month=2027-02`);
    expect(d.templates[0]).toMatchObject({ name: 'ค่าเช่ารายเดือน', description: 'จ่ายค่าเช่าร้าน', recurring: true, dayOfMonth: 31, startMonth: '2027-01',
      lines: [{ account_code: '5220', debit: '8000.00', credit: '0.00', memo: '' }, { account_code: '1110', debit: '0.00', credit: '8000.00', memo: '' }] });
    expect(d.due).toEqual([{ id: tid, name: 'ค่าเช่ารายเดือน', dueDate: '2027-02-28' }]);
    expect((await ok(owner, 'GET', `/companies/${co}/templates?month=2026-12`)).due).toEqual([]); // ก่อนเดือนเริ่ม
    expect((await as(owner, 'POST', `/companies/${co}/templates`, { name: 'ค่าเช่ารายเดือน', fromEntry: entryId })).statusCode).toBe(409);
  });

  it('ไม่มีอะไรลงเอง: ยังไม่กดยืนยัน = ยังไม่มีรายการ', async () => {
    const n = (await db.query(`select count(*)::int n from acc.journal_entries where company_id = $1`, [co])).rows[0].n;
    expect(n).toBe(2);
  });

  it('ลงเดือน ก.พ. (แก้ยอด) · ลงซ้ำเดือนเดียวกันไม่ได้ · กลับรายการแล้วค้างอีก', async () => {
    const r = await ok(owner, 'POST', `/companies/${co}/templates/${tid}/post`, { date: '2027-02-28', lines: [{ account_code: '5220', debit: '8500' }, { account_code: '1110', credit: '8500' }] });
    expect(await lines(r.entryId)).toEqual({ 1110: ['0.00', '8500.00'], 5220: ['8500.00', '0.00'] });
    expect((await ok(owner, 'GET', `/companies/${co}/templates?month=2027-02`)).due).toEqual([]);
    const dup = await as(owner, 'POST', `/companies/${co}/templates/${tid}/post`, { date: '2027-02-27' });
    expect(dup.json()).toMatchObject({ code: 'ACC16' });
    const bad = await as(owner, 'POST', `/companies/${co}/templates/${tid}/post`, { date: '2027-03-31', lines: [{ account_code: '5220', debit: '8000' }, { account_code: '1110', credit: '7000' }] });
    expect(bad.json()).toMatchObject({ code: 'ACC01' });
    await ok(owner, 'POST', `/companies/${co}/journal/${r.entryId}/reverse`, { date: '2027-02-28' });
    expect((await ok(owner, 'GET', `/companies/${co}/templates?month=2027-02`)).due).toHaveLength(1);
    const again = await ok(owner, 'POST', `/companies/${co}/templates/${tid}/post`, { date: '2027-02-28' });
    expect(await lines(again.entryId)).toEqual({ 1110: ['0.00', '8000.00'], 5220: ['8000.00', '0.00'] });
    const tb = await ok(owner, 'GET', `/companies/${co}/trial-balance?month=2027-02`);
    expect(tb.rows.find((x: { code: string }) => x.code === '5220').debit).toBe('16000.00'); // ธ.ค. 8,000 + ก.พ. 8,000 (8,500 กลับรายการแล้ว)
    expect(tb.totalDebit).toBe(tb.totalCredit);
  });

  it('แม่แบบทั่วไปใช้ได้หลายครั้ง · แก้ไข/เลิกใช้ · version กันแก้ทับ · คีย์ซ้ำไม่ลงซ้ำ', async () => {
    const t = await ok(owner, 'POST', `/companies/${co}/templates`, { name: 'ซื้อวัสดุ', description: 'ซื้อวัสดุสิ้นเปลือง',
      lines: [{ account_code: '5260', debit: '500' }, { account_code: '1110', credit: '500' }] });
    const key = crypto.randomUUID();
    const a = await ok(owner, 'POST', `/companies/${co}/templates/${t.id}/post`, { date: '2027-03-02' }, key);
    expect((await ok(owner, 'POST', `/companies/${co}/templates/${t.id}/post`, { date: '2027-03-02' }, key)).entryId).toBe(a.entryId);
    await ok(owner, 'POST', `/companies/${co}/templates/${t.id}/post`, { date: '2027-03-05' });
    const u = await ok(owner, 'PUT', `/companies/${co}/templates/${t.id}`, { name: 'ซื้อวัสดุ', active: false, version: t.version });
    expect((await as(owner, 'PUT', `/companies/${co}/templates/${t.id}`, { name: 'x', version: t.version })).statusCode).toBe(409);
    expect((await as(owner, 'POST', `/companies/${co}/templates/${t.id}/post`, { date: '2027-03-06' })).statusCode).toBe(400);
    expect(u.version).toBe(t.version + 1);
    const uses = (await ok(owner, 'GET', `/companies/${co}/templates?month=2027-03`)).templates.find((x: { id: string }) => x.id === t.id).uses;
    expect(uses).toBe(2);
  });

  it('นักเรียนอื่นอ่าน/ใช้ไม่ได้', async () => {
    expect((await as(other, 'GET', `/companies/${co}/templates`)).statusCode).toBe(404);
    expect((await as(other, 'POST', `/companies/${co}/templates/${tid}/post`, { date: '2027-04-30' })).statusCode).toBe(404);
  });
});
