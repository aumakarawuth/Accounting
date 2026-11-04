import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../apps/api/src/app';
import { devAuth } from '../apps/api/src/auth';
import { authConfigFromEnv } from '../apps/api/src/config';
import { createPool } from '../apps/api/src/db';
import { apiUrl } from './global-setup';
import { pool as db, asUser, newSchool, newUser, newClassroom, sqlstate } from './helpers';

// เฟส 4: ชุดโจทย์ มอบหมาย ตรวจอัตโนมัติ การซ่อนเฉลย (RLS/API) โหมดสอบ (เวลา/ล็อก/1 เซสชัน) สาธิต
const apiPool = createPool(apiUrl());
const app = buildApp({ pool: apiPool, auth: devAuth(), cfg: { ...authConfigFromEnv({}), allowedOrigins: false } });
afterAll(async () => { await app.close(); await apiPool.end(); await db.end(); });

const teachers = new Set<string>();
const as = (user: string, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
  app.inject({ method, url, payload, headers: {
    'x-dev-user-id': user, 'x-dev-role': teachers.has(user) ? 'teacher' : 'student', 'idempotency-key': randomUUID() } });

let teacher: string, teacher2: string, s1: string, s2: string, s3: string, room: string;

// โจทย์ 3 ข้อ: ข้อ 2 มียอดเฉพาะตัว (7,350.00) ใช้ตรวจว่าเฉลยไม่หลุดไปถึงนักเรียน
const SET = {
  title: 'กิจการให้บริการ เดือน ต.ค.',
  companyName: 'ร้านซ่อมดี',
  description: 'ลงรายการในสมุดรายวันทั่วไป',
  items: [
    { date: '2026-10-01', narrative: 'นำเงินสดมาลงทุน 50,000 บาท', points: '2', lines: [
      { account_code: '1110', debit: '50000' }, { account_code: '3110', credit: '50000' }] },
    { date: '2026-10-03', narrative: 'ซื้อวัสดุสิ้นเปลือง 7,350 บาท จ่ายเงินสด', points: '1', lines: [
      { account_code: '5260', debit: '7350' }, { account_code: '1110', credit: '7350' }] },
    { date: '2026-10-05', narrative: 'ให้บริการรับเงินสด 1,200 บาท', points: '1', lines: [
      { account_code: '1110', debit: '1200' }, { account_code: '4120', credit: '1200' }] },
  ],
};

beforeAll(async () => {
  const school = await newSchool();
  teacher = await newUser(school, 'teacher');
  teacher2 = await newUser(school, 'teacher');
  teachers.add(teacher); teachers.add(teacher2);
  s1 = await newUser(school, 'student');
  s2 = await newUser(school, 'student');
  s3 = await newUser(school, 'student');
  room = await newClassroom(school, teacher, [s1, s2]);
  await newClassroom(school, teacher2, [s3]);
  // รหัสในโจทย์ต้องมีในผังตั้งต้น
  const codes = (await db.query(`select code from acc.coa_template where code = any($1)`, [['1110', '3110', '5260', '4120']])).rows.map((r) => r.code);
  expect(codes.sort()).toEqual(['1110', '3110', '4120', '5260']);
});

async function createSet(body = SET) {
  const r = await as(teacher, 'POST', '/teacher/exercises', body);
  expect(r.statusCode, r.body).toBe(201);
  return r.json().id as string;
}
async function assign(setId: string, opts: Record<string, unknown>) {
  const r = await as(teacher, 'POST', `/teacher/exercises/${setId}/assign`, { classroomId: room, ...opts });
  expect(r.statusCode, r.body).toBe(201);
  return r.json() as { assignmentId: string; companies: number };
}
const companyOf = async (assignment: string, owner: string) =>
  (await db.query('select id from acc.companies where assignment_id = $1 and owner_id = $2', [assignment, owner])).rows[0].id as string;
const postJ = (user: string, co: string, date: string, lines: { account_code: string; debit?: string; credit?: string }[]) =>
  as(user, 'POST', `/companies/${co}/journal`, { date, description: 'ตามโจทย์', lines });

describe('ชุดโจทย์', () => {
  it('ตรวจเฉลยตอนบันทึก (ไม่ดุล รหัสไม่อยู่ในผังตั้งต้น) · นักเรียนสร้างไม่ได้ · ครูอื่นไม่เห็น · version กันแก้ทับ', async () => {
    const bad = await as(teacher, 'POST', '/teacher/exercises', { ...SET, items: [{ ...SET.items[0]!, lines: [
      { account_code: '1110', debit: '100' }, { account_code: '3110', credit: '90' }] }] });
    expect(bad.statusCode).toBe(422);
    expect(bad.json()).toMatchObject({ code: 'ACC19', message: 'ข้อ 1: เฉลยเดบิต 100.00 ไม่เท่าเครดิต 90.00 ผลต่าง 10.00' });
    const unknown = await as(teacher, 'POST', '/teacher/exercises', { ...SET, items: [{ ...SET.items[0]!, lines: [
      { account_code: '1999', debit: '1' }, { account_code: '3110', credit: '1' }] }] });
    expect(unknown.json()).toMatchObject({ code: 'ACC19', message: expect.stringContaining('ไม่มีรหัสบัญชี 1999') });
    expect((await as(s1, 'POST', '/teacher/exercises', SET)).statusCode).toBe(403);

    const id = await createSet();
    const got = (await as(teacher, 'GET', `/teacher/exercises/${id}`)).json();
    expect(got).toMatchObject({ title: SET.title, version: 1, classrooms: [{ id: room }] });
    expect(got.items[1]).toMatchObject({ no: 2, date: '2026-10-03', points: '1.00', lines: [{ account_code: '5260', debit: '7350.00', credit: null }, { account_code: '1110', credit: '7350.00' }] });
    expect((await as(teacher2, 'GET', `/teacher/exercises/${id}`)).statusCode).toBe(404);

    const upd = await as(teacher, 'PUT', `/teacher/exercises/${id}`, { ...SET, title: 'แก้ชื่อ', version: 1 });
    expect(upd.json()).toEqual({ id, version: 2 });
    expect((await as(teacher, 'PUT', `/teacher/exercises/${id}`, { ...SET, version: 1 })).statusCode).toBe(409);
    expect((await as(teacher2, 'PUT', `/teacher/exercises/${id}`, { ...SET, version: 2 })).statusCode).toBe(422);
    expect((await as(teacher, 'POST', `/teacher/exercises/${id}/delete`)).statusCode).toBe(200);
    expect((await as(teacher, 'GET', `/teacher/exercises/${id}`)).statusCode).toBe(404);
  });

  it('RLS: นักเรียน/ครูอื่นอ่านตารางโจทย์ เฉลย งาน ตรงไม่ได้ และเรียกตัวตรวจเต็มไม่ได้', async () => {
    const id = await createSet();
    const { assignmentId } = await assign(id, { mode: 'practice', companyName: `บริษัท RLS ${id.slice(0, 4)}` });
    const co = await companyOf(assignmentId, s1);
    for (const u of [s1, s3, teacher2]) {
      for (const t of ['exercise_sets', 'exercise_items', 'exercise_answer_lines', 'assignments', 'assignment_events']) {
        for (const role of ['app_rw', 'app_ro']) {
          const n = await asUser(u, async (c) => (await c.query(`select count(*)::int n from acc.${t}`)).rows[0].n, role);
          expect(n, `${t} ${role}`).toBe(0);
        }
      }
    }
    expect(await asUser(teacher, async (c) => (await c.query('select count(*)::int n from acc.exercise_answer_lines where set_id = $1', [id])).rows[0].n)).toBe(6);
    await expect(asUser(s1, (c) => c.query('select app.grade_company($1)', [co]))).rejects.toSatisfy((e) => sqlstate(e) === '42501');
    await expect(asUser(s1, (c) => c.query(`insert into acc.exercise_items (set_id, item_no, entry_date, narrative, points) values ($1, 9, '2026-10-01', 'x', 1)`, [id])))
      .rejects.toSatisfy((e) => sqlstate(e) === '42501');
    // เหตุการณ์ของงานแก้/ลบไม่ได้ แม้ superuser
    await expect(db.query('update acc.assignment_events set action = action where assignment_id = $1', [assignmentId])).rejects.toThrow();
  });
});

describe('มอบหมาย + ตรวจอัตโนมัติ', () => {
  it('ฝึกหัด แสดงรายข้อทันที: เปิดบริษัทให้ทั้งห้อง · ไม่สนลำดับบรรทัด · กลับรายการไม่นับ · ไม่มีเฉลยในคำตอบ API', async () => {
    const id = await createSet();
    const name = `ร้านซ่อมดี ${id.slice(0, 6)}`;
    const a = await assign(id, { mode: 'practice', companyName: name, feedback: 'items', reveal: 'anytime' });
    expect(a.companies).toBe(2);
    // ชื่อบริษัทซ้ำในห้อง
    const dup = await as(teacher, 'POST', `/teacher/exercises/${id}/assign`, { classroomId: room, mode: 'practice', companyName: name });
    expect(dup.json()).toMatchObject({ code: 'ACC19', message: expect.stringContaining('มีบริษัทชื่อ') });
    // ครูห้องอื่นมอบหมายเข้าห้องนี้ไม่ได้
    expect((await as(teacher2, 'POST', `/teacher/exercises/${id}/assign`, { classroomId: room, mode: 'practice' })).statusCode).toBe(422);

    const co = await companyOf(a.assignmentId, s1);
    let v = (await as(s1, 'GET', `/companies/${co}/assignment`)).json();
    expect(v).toMatchObject({ viewer: 'student', itemsVisible: true, lockReason: null, result: { level: 'items', score: '0.00', maxScore: '4.00', correct: 0, total: 3 } });
    expect(v.items.map((i: { answer: unknown }) => i.answer)).toEqual([null, null, null]);
    expect(JSON.stringify(v)).not.toContain('7350');
    expect(JSON.stringify(v)).not.toContain('5260');

    // ข้อ 1 ลงแยกเงินสดสองบรรทัด สลับลำดับ · ข้อ 3 ลงผิดแล้วกลับรายการ แล้วลงใหม่ให้ถูก · ข้อ 2 ลงบัญชีผิด
    expect((await postJ(s1, co, '2026-10-01', [{ account_code: '3110', credit: '50000' }, { account_code: '1110', debit: '30000' }, { account_code: '1110', debit: '20000' }])).statusCode).toBe(201);
    const wrong = await postJ(s1, co, '2026-10-05', [{ account_code: '1110', debit: '1200' }, { account_code: '4110', credit: '1200' }]);
    expect((await as(s1, 'POST', `/companies/${co}/journal/${wrong.json().id}/reverse`, { date: '2026-10-05' })).statusCode).toBe(201);
    await postJ(s1, co, '2026-10-05', [{ account_code: '4120', credit: '1200' }, { account_code: '1110', debit: '1200' }]);
    await postJ(s1, co, '2026-10-03', [{ account_code: '5230', debit: '7350' }, { account_code: '1110', credit: '7350' }]);

    v = (await as(s1, 'GET', `/companies/${co}/assignment`)).json();
    expect(v.result).toMatchObject({ score: '3.00', correct: 2 });
    expect(v.result.items.map((i: { status: string }) => i.status)).toEqual(['correct', 'wrong', 'correct']);
    expect(v.result.items[1]).not.toHaveProperty('missing'); // ระดับ "ข้อไหนถูก/ผิด" ไม่บอกบรรทัดเฉลย
    expect(v.result).not.toHaveProperty('answers');
    expect(JSON.stringify(v)).not.toContain('5260');

    // ครูเห็นทั้งเฉลยและบรรทัดที่ต่าง · ภาพรวมห้อง · เปลี่ยนเป็นแสดงเฉลย นักเรียนเห็นบรรทัดที่ขาด
    const tv = (await as(teacher, 'GET', `/companies/${co}/assignment`)).json();
    expect(tv).toMatchObject({ viewer: 'teacher', result: { level: 'answers' } });
    expect(tv.result.items[1]).toMatchObject({ status: 'wrong', missing: ['5260|D|7350.00'], extra: ['5230|D|7350.00'] });
    expect(tv.items[1].answer).toEqual([{ code: '5260', debit: '7350.00', credit: '0.00' }, { code: '1110', debit: '0.00', credit: '7350.00' }]);
    const ov = (await as(teacher, 'GET', `/teacher/assignments/${a.assignmentId}`)).json();
    expect(ov.students).toHaveLength(2);
    expect(ov.students.find((s: { studentId: string }) => s.studentId === s1)).toMatchObject({
      grade: { score: '3.00', correct: 2, extra: 0, items: [{ no: 1, status: 'correct' }, { no: 2, status: 'wrong' }, { no: 3, status: 'correct' }] }, entries: 5 });
    expect(ov.students.find((s: { studentId: string }) => s.studentId === s2).grade).toMatchObject({ score: '0.00', correct: 0 });
    expect((await as(teacher2, 'GET', `/teacher/assignments/${a.assignmentId}`)).statusCode).toBe(404);
    expect((await as(s1, 'GET', `/teacher/assignments/${a.assignmentId}`)).statusCode).toBe(403);
    expect((await as(s3, 'GET', `/companies/${co}/assignment`)).statusCode).toBe(404);

    expect((await as(teacher, 'POST', `/teacher/assignments/${a.assignmentId}/options`, { feedback: 'answers' })).statusCode).toBe(200);
    v = (await as(s1, 'GET', `/companies/${co}/assignment`)).json();
    expect(v.result.items[1]).toMatchObject({ missing: ['5260|D|7350.00'] });
    expect(v.result.answers[1].lines[0]).toMatchObject({ code: '5260', debit: '7350.00' });

    // แก้เฉลยหลังมอบหมาย = คิดคะแนนใหม่ทันที
    const items = SET.items.map((i, k) => (k === 1 ? { ...i, lines: [{ account_code: '5230', debit: '7350' }, { account_code: '1110', credit: '7350' }] } : i));
    const ver = (await as(teacher, 'GET', `/teacher/exercises/${id}`)).json().version;
    expect((await as(teacher, 'PUT', `/teacher/exercises/${id}`, { ...SET, items, version: ver })).statusCode).toBe(200);
    expect((await as(s1, 'GET', `/companies/${co}/assignment`)).json().result).toMatchObject({ score: '4.00', correct: 3 });
    // ชุดที่มอบหมายแล้วลบไม่ได้
    expect((await as(teacher, 'POST', `/teacher/exercises/${id}/delete`)).json()).toMatchObject({ code: 'ACC19' });

    // ปิดงาน = ล็อกทุกเส้นทางเขียน · เปิดอีกครั้งได้
    expect((await as(teacher, 'POST', `/teacher/assignments/${a.assignmentId}/actions`, { action: 'close' })).statusCode).toBe(200);
    const locked = await postJ(s1, co, '2026-10-06', [{ account_code: '1110', debit: '1' }, { account_code: '4110', credit: '1' }]);
    expect(locked.json()).toMatchObject({ code: 'ACC10', message: 'งานนี้ปิดแล้ว แก้ไขไม่ได้' });
    expect((await as(s1, 'GET', `/companies/${co}`)).json()).toMatchObject({ locked: true, assignment: { mode: 'practice', lockReason: 'closed' } });
    await as(teacher, 'POST', `/teacher/assignments/${a.assignmentId}/actions`, { action: 'reopen' });
    expect((await postJ(s1, co, '2026-10-06', [{ account_code: '1110', debit: '1' }, { account_code: '4110', credit: '1' }])).statusCode).toBe(201);
  });

  it('ส่งงาน: ผลแสดงหลังส่งตรวจ · คะแนนเต็มของงาน = คะแนนรวมของชุด · นักเรียนที่เข้าห้องทีหลังเปิดบริษัทเพิ่มได้', async () => {
    const id = await createSet();
    const a = await assign(id, { mode: 'submit', companyName: `ส่งงาน ${id.slice(0, 6)}`, feedback: 'score', reveal: 'after_submit' });
    const co = await companyOf(a.assignmentId, s2);
    expect((await db.query('select max_score::text from acc.submissions where company_id = $1', [co])).rows[0].max_score).toBe('4.00');
    await postJ(s2, co, '2026-10-01', [{ account_code: '1110', debit: '50000' }, { account_code: '3110', credit: '50000' }]);
    let v = (await as(s2, 'GET', `/companies/${co}/assignment`)).json();
    expect(v).toMatchObject({ result: null, resultHidden: 'after_submit' });
    expect((await as(s2, 'POST', `/companies/${co}/submission`, { action: 'submit', expected: 'draft' })).statusCode).toBe(200);
    v = (await as(s2, 'GET', `/companies/${co}/assignment`)).json();
    expect(v.result).toEqual({ level: 'score', score: '2.00', maxScore: '4.00', correct: 1, total: 3 });
    expect(v.lockReason).toBe('submitted');

    const late = await newUser((await db.query('select school_id from acc.classrooms where id = $1', [room])).rows[0].school_id, 'student');
    await db.query('insert into acc.enrollments values ($1, $2)', [room, late]);
    const open = await as(teacher, 'POST', `/teacher/assignments/${a.assignmentId}/actions`, { action: 'open-companies' });
    expect(open.json()).toEqual({ created: 1, existing: 2 });
    expect((await as(teacher, 'POST', `/teacher/assignments/${a.assignmentId}/actions`, { action: 'open-companies' })).json()).toEqual({ created: 0, existing: 3 });
    await db.query('delete from acc.enrollments where classroom_id = $1 and user_id = $2', [room, late]);
    // ฝึกหัดเลือก "หลังส่งตรวจ" ไม่ได้
    expect((await as(teacher, 'POST', `/teacher/exercises/${id}/assign`, { classroomId: room, mode: 'practice', reveal: 'after_submit', companyName: 'x' })).json())
      .toMatchObject({ code: 'ACC19' });
  });
});

describe('โหมดสอบ', () => {
  it('ยังไม่เริ่ม = ล็อกและไม่เห็นโจทย์ · เริ่มแล้วลงได้ · หมดเวลา = ล็อก · เพิ่มเวลา · ผลซ่อนจนครูเปิดเฉลย', async () => {
    const id = await createSet();
    const a = await assign(id, { mode: 'exam', companyName: `สอบ ${id.slice(0, 6)}`, feedback: 'answers', reveal: 'anytime', durationMinutes: 30 });
    const co = await companyOf(a.assignmentId, s1);
    let v = (await as(s1, 'GET', `/companies/${co}/assignment`)).json();
    expect(v).toMatchObject({ itemsVisible: false, items: null, result: null, lockReason: 'exam_not_started', attempt: null,
      assignment: { reveal: 'after_release', durationMinutes: 30 } });
    const before = await postJ(s1, co, '2026-10-01', [{ account_code: '1110', debit: '50000' }, { account_code: '3110', credit: '50000' }]);
    expect(before.json()).toMatchObject({ code: 'ACC10', message: expect.stringContaining('ยังไม่ได้เริ่มสอบ') });
    // ครูเห็นโจทย์และเฉลยเสมอ
    expect((await as(teacher, 'GET', `/companies/${co}/assignment`)).json().items[1].answer[0].code).toBe('5260');

    const start = await as(s1, 'POST', `/companies/${co}/assignment/start`);
    expect(start.statusCode).toBe(200);
    const deadline = new Date(start.json().deadline).getTime();
    expect(Math.abs(deadline - Date.now() - 30 * 60_000)).toBeLessThan(60_000);
    // กดซ้ำได้เวลาเดิม
    expect((await as(s1, 'POST', `/companies/${co}/assignment/start`)).json().deadline).toBe(start.json().deadline);
    expect((await as(s2, 'POST', `/companies/${co}/assignment/start`)).statusCode).toBe(404);

    expect((await postJ(s1, co, '2026-10-01', [{ account_code: '1110', debit: '50000' }, { account_code: '3110', credit: '50000' }])).statusCode).toBe(201);
    v = (await as(s1, 'GET', `/companies/${co}/assignment`)).json();
    expect(v).toMatchObject({ itemsVisible: true, result: null, resultHidden: 'after_release', lockReason: null });
    expect(v.items).toHaveLength(3);
    expect(JSON.stringify(v)).not.toContain('5260');
    const brief = (await as(s1, 'GET', `/companies/${co}`)).json().assignment;
    expect(brief).toMatchObject({ mode: 'exam', lockReason: null });
    expect(new Date(brief.deadline).getTime()).toBe(deadline);

    // หมดเวลา (ย้อนเวลาที่ DB) → ทุกเส้นทางเขียนถูกปฏิเสธ
    await db.query(`update acc.exam_attempts set deadline = now() - interval '1 second' where company_id = $1`, [co]);
    const over = await postJ(s1, co, '2026-10-05', [{ account_code: '1110', debit: '1200' }, { account_code: '4110', credit: '1200' }]);
    expect(over.json()).toMatchObject({ code: 'ACC10', message: 'หมดเวลาสอบแล้ว ลงรายการเพิ่มไม่ได้' });
    const acc = await as(s1, 'POST', `/companies/${co}/accounts`, { code: '1199', name: 'บัญชีใหม่', type: 'asset' });
    expect(acc.statusCode).toBe(409);

    // เพิ่มเวลา 10 นาที (นับจากตอนนี้เพราะหมดไปแล้ว) · ครูห้องอื่นทำไม่ได้
    expect((await as(teacher2, 'POST', `/teacher/assignments/${a.assignmentId}/actions`, { action: 'extend', minutes: 10 })).statusCode).toBe(404);
    expect((await as(teacher, 'POST', `/teacher/assignments/${a.assignmentId}/actions`, { action: 'extend', minutes: 10, companyId: co })).json()).toEqual({ extended: 1 });
    expect((await postJ(s1, co, '2026-10-05', [{ account_code: '1110', debit: '1200' }, { account_code: '4120', credit: '1200' }])).statusCode).toBe(201);

    // ปิดสอบทันที · เปิดเฉลย → นักเรียนเห็นผลระดับเฉลย
    await as(teacher, 'POST', `/teacher/assignments/${a.assignmentId}/actions`, { action: 'close' });
    expect((await as(s1, 'GET', `/companies/${co}/assignment`)).json()).toMatchObject({ lockReason: 'closed', result: null });
    await as(teacher, 'POST', `/teacher/assignments/${a.assignmentId}/actions`, { action: 'release' });
    v = (await as(s1, 'GET', `/companies/${co}/assignment`)).json();
    expect(v.result).toMatchObject({ level: 'answers', score: '3.00', correct: 2 });
    expect(v.result.items[1]).toMatchObject({ status: 'missing' });
    expect(v.result.answers[1].lines[0].code).toBe('5260');
    // นักเรียนที่ไม่เคยเริ่มสอบ: ไม่เห็นผล ไม่เห็นโจทย์ แม้เปิดเฉลยแล้ว
    const co2 = await companyOf(a.assignmentId, s2);
    expect((await as(s2, 'GET', `/companies/${co2}/assignment`)).json()).toMatchObject({ items: null, result: null });
    expect((await as(s2, 'POST', `/companies/${co2}/assignment/start`)).json()).toMatchObject({ code: 'ACC20', message: 'ครูปิดการสอบนี้แล้ว' });

    const events = (await db.query('select action from acc.assignment_events where assignment_id = $1 order by id', [a.assignmentId])).rows.map((r) => r.action);
    expect(events).toEqual(['create', 'open_companies', 'start', 'extend', 'close', 'release']);
  });

  it('ยังไม่ถึงเวลาเปิด/เลยเวลาปิดรับ · หมดเวลาไม่เกินเวลาปิดรับ · 1 เซสชันต่อคน (ตอนเริ่มสอบและตอนล็อกอิน)', async () => {
    const id = await createSet();
    const soon = new Date(Date.now() + 3600_000).toISOString();
    const a = await assign(id, { mode: 'exam', companyName: `สอบเวลา ${id.slice(0, 6)}`, durationMinutes: 60, opensAt: soon });
    const co = await companyOf(a.assignmentId, s2);
    expect((await as(s2, 'POST', `/companies/${co}/assignment/start`)).json()).toMatchObject({ code: 'ACC20', message: expect.stringContaining('ยังไม่ถึงเวลาเริ่มสอบ') });
    expect((await as(s2, 'GET', `/companies/${co}/assignment`)).json()).toMatchObject({ lockReason: 'not_open', itemsVisible: false });

    // เปิดแล้ว ปิดรับใน 5 นาที: หมดเวลา = เวลาปิดรับ (ไม่ใช่ 60 นาที)
    await db.query(`update acc.assignments set opens_at = now() - interval '1 minute', closes_at = now() + interval '5 minutes' where id = $1`, [a.assignmentId]);
    for (const [tok, user] of [['tok-a', s2], ['tok-b', s2], ['tok-other', s1]] as const) {
      await db.query(`insert into acc.sessions (token_hash, user_id, client, idle_seconds, expires_at) values ($1, $2, 'test', 3600, now() + interval '1 hour')`, [`${tok}-${id}`, user]);
    }
    const deadline = await asUser(s2, async (c) => (await c.query('select acc.start_exam($1, $2) d', [co, `tok-a-${id}`])).rows[0].d as Date);
    expect(deadline.getTime() - Date.now()).toBeLessThan(6 * 60_000);
    const live = async () => (await db.query(`select token_hash from acc.sessions where token_hash like $1 and revoked_at is null order by 1`, [`%-${id}`])).rows.map((r) => r.token_hash);
    expect(await live()).toEqual([`tok-a-${id}`, `tok-other-${id}`]);
    expect((await db.query(`select revoked_reason from acc.sessions where token_hash = $1`, [`tok-b-${id}`])).rows[0].revoked_reason).toBe('exam_single');
    // ล็อกอินเครื่องใหม่ระหว่างสอบ → เครื่องเก่าออก (นักเรียนที่ไม่ได้สอบไม่โดน)
    await db.query(`insert into acc.sessions (token_hash, user_id, client, idle_seconds, expires_at) values ($1, $2, 'test', 3600, now() + interval '1 hour')`, [`tok-c-${id}`, s2]);
    expect((await apiPool.query('select app.exam_single_session($1, $2) n', [s2, `tok-c-${id}`])).rows[0].n).toBe(1);
    expect((await apiPool.query('select app.exam_single_session($1, $2) n', [s1, `tok-zzz`])).rows[0].n).toBe(0);
    expect(await live()).toEqual([`tok-c-${id}`, `tok-other-${id}`]);

    await db.query(`update acc.assignments set closes_at = now() - interval '1 second', opens_at = now() - interval '2 minutes' where id = $1`, [a.assignmentId]);
    const co1 = await companyOf(a.assignmentId, s1);
    expect((await as(s1, 'POST', `/companies/${co1}/assignment/start`)).json()).toMatchObject({ code: 'ACC20', message: 'หมดเวลารับเข้าสอบแล้ว' });
  });
});

describe('โหมดสาธิต', () => {
  it('บริษัทสาธิตเป็นของครู ลงรายการได้ เห็นเฉลย · นักเรียนไม่เห็น · บริษัทเปล่าได้', async () => {
    const id = await createSet();
    const r = await as(teacher, 'POST', `/teacher/exercises/${id}/assign`, { mode: 'demo', companyName: 'บริษัท สาธิต จำกัด' });
    expect(r.statusCode, r.body).toBe(201);
    const { companyId, assignmentId } = r.json();
    expect((await db.query('select owner_id, classroom_id, mode from acc.companies where id = $1', [companyId])).rows[0]).toEqual({ owner_id: teacher, classroom_id: null, mode: 'practice' });
    expect((await postJ(teacher, companyId, '2026-10-01', [{ account_code: '1110', debit: '50000' }, { account_code: '3110', credit: '50000' }])).statusCode).toBe(201);
    const v = (await as(teacher, 'GET', `/companies/${companyId}/assignment`)).json();
    expect(v).toMatchObject({ assignment: { mode: 'demo' }, viewer: 'teacher', result: { correct: 1 } });
    expect(v.items[0].answer).toHaveLength(2);
    expect((await as(teacher, 'GET', `/companies/${companyId}`)).json()).toMatchObject({ can_write: true, assignment: { mode: 'demo', lockReason: null } });
    expect((await as(s1, 'GET', `/companies/${companyId}`)).statusCode).toBe(404);
    expect((await as(teacher2, 'GET', `/companies/${companyId}/assignment`)).statusCode).toBe(404);
    const list = (await as(teacher, 'GET', '/teacher/exercises')).json();
    expect(list.assignments.find((x: { id: string }) => x.id === assignmentId)).toMatchObject({ mode: 'demo', demoCompanyId: companyId, classroom: null });

    const blank = await as(teacher, 'POST', '/teacher/demo', { companyName: 'บริษัทเปล่า' });
    expect(blank.statusCode).toBe(201);
    const bv = (await as(teacher, 'GET', `/companies/${blank.json().companyId}/assignment`)).json();
    expect(bv).toMatchObject({ assignment: { mode: 'demo' }, items: null, result: null });
    expect((await as(s1, 'POST', '/teacher/demo', { companyName: 'x' })).statusCode).toBe(403);
  });
});
