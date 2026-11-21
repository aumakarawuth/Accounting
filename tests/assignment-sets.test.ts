import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../apps/api/src/app';
import { devAuth } from '../apps/api/src/auth';
import { authConfigFromEnv } from '../apps/api/src/config';
import { createPool } from '../apps/api/src/db';
import { apiUrl } from './global-setup';
import { pool as db, newSchool, newUser, newClassroom } from './helpers';

// งานเดียวหลายชุดโจทย์ (migration 20261115000119, docs/assumptions.md ข้อ 52)
// ชุด ก: ลงทุน 50,000 (2 คะแนน) + ให้บริการ 1,200 (1) = เต็ม 3 · ชุด ข: ลงทุน 80,000 (2) + ซื้อวัสดุ 4,500 (2) = เต็ม 4
const apiPool = createPool(apiUrl());
const app = buildApp({ pool: apiPool, auth: devAuth(), limiter: { hit: async () => 0 }, cfg: { ...authConfigFromEnv({}), allowedOrigins: false } });
afterAll(async () => { await app.close(); await apiPool.end(); await db.end(); });

let teacher: string, school: string, room: string;
let students: string[] = [];
const as = (user: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as object, headers: {
    'x-dev-user-id': user, 'x-dev-role': user === teacher ? 'teacher' : 'student', 'idempotency-key': randomUUID() } });
const SET_A = { title: 'ชุด ก', companyName: 'ร้านซ่อมดี', description: '', items: [
  { date: '2026-10-01', narrative: 'นำเงินสดมาลงทุน 50,000 บาท', points: '2', lines: [{ account_code: '1110', debit: '50000' }, { account_code: '3110', credit: '50000' }] },
  { date: '2026-10-05', narrative: 'ให้บริการรับเงินสด 1,200 บาท', points: '1', lines: [{ account_code: '1110', debit: '1200' }, { account_code: '4120', credit: '1200' }] },
] };
const SET_B = { title: 'ชุด ข', companyName: 'ร้านซ่อมดี', description: '', items: [
  { date: '2026-10-01', narrative: 'นำเงินสดมาลงทุน 80,000 บาท', points: '2', lines: [{ account_code: '1110', debit: '80000' }, { account_code: '3110', credit: '80000' }] },
  { date: '2026-10-03', narrative: 'ซื้อวัสดุสิ้นเปลือง 4,500 บาท จ่ายเงินสด', points: '2', lines: [{ account_code: '5260', debit: '4500' }, { account_code: '1110', credit: '4500' }] },
] };
let setA: string, setB: string;
const companyOf = async (assignment: string, owner: string) =>
  (await db.query('select id from acc.companies where assignment_id = $1 and owner_id = $2', [assignment, owner])).rows[0].id as string;
const post = (user: string, co: string, item: (typeof SET_A.items)[number]) =>
  as(user, 'POST', `/companies/${co}/journal`, { date: item.date, description: 'ตามโจทย์', lines: item.lines });
/** นักเรียนเรียงตามรหัสนักเรียน = ลำดับที่ระบบเวียนแจก */
const byCode = async (ids: string[]) =>
  (await db.query('select id from acc.users where id = any($1) order by student_code, id', [ids])).rows.map((r) => r.id as string);

beforeAll(async () => {
  school = await newSchool();
  teacher = await newUser(school, 'teacher');
  for (let i = 0; i < 5; i++) students.push(await newUser(school, 'student'));
  room = await newClassroom(school, teacher, students);
  students = await byCode(students);
  const mk = async (b: unknown) => { const r = await as(teacher, 'POST', '/teacher/exercises', b); expect(r.statusCode, r.body).toBe(201); return r.json().id as string; };
  setA = await mk(SET_A);
  setB = await mk(SET_B);
});

describe('งานเดียวหลายชุดโจทย์', () => {
  let assignment: string;

  it('เวียนตามรหัสนักเรียน: คนที่ 1, 3, 5 ได้ชุด ก · คนที่ 2, 4 ได้ชุด ข · คะแนนเต็มตามชุด (3 / 4)', async () => {
    const r = await as(teacher, 'POST', `/teacher/exercises/${setA}/assign`, { classroomId: room, mode: 'submit', companyName: 'สองชุด', extraSets: [setB] });
    expect(r.statusCode, r.body).toBe(201);
    assignment = r.json().assignmentId;
    const ov = (await as(teacher, 'GET', `/teacher/assignments/${assignment}`)).json();
    expect(ov.sets.map((s: { no: number; title: string; items: unknown[] }) => [s.no, s.title, s.items.length])).toEqual([[1, 'ชุด ก', 2], [2, 'ชุด ข', 2]]);
    expect(ov.assignment.distribution).toBe('rotate');
    const setNo = (id: string) => ov.students.find((s: { studentId: string }) => s.studentId === id).setNo;
    expect(students.map(setNo)).toEqual([1, 2, 1, 2, 1]);
    const max = async (id: string) => (await db.query('select max_score::text m from acc.submissions where company_id = $1', [await companyOf(assignment, id)])).rows[0].m;
    expect([await max(students[0]!), await max(students[1]!)]).toEqual(['3.00', '4.00']);
  });

  it('นักเรียนเห็นโจทย์ของชุดตัวเอง · ตรวจด้วยเฉลยชุดตัวเอง: ลอกคำตอบชุด ก มาลงในชุด ข ได้ 0', async () => {
    const [ka, kb] = [students[0]!, students[1]!];
    const coA = await companyOf(assignment, ka), coB = await companyOf(assignment, kb);
    const vb = (await as(kb, 'GET', `/companies/${coB}/assignment`)).json();
    expect(vb.items.map((i: { narrative: string }) => i.narrative)).toEqual(SET_B.items.map((i) => i.narrative));
    for (const it of SET_A.items) expect((await post(ka, coA, it)).statusCode).toBe(201);
    for (const it of SET_A.items) expect((await post(kb, coB, it)).statusCode).toBe(201); // ลอกชุด ก
    const ov = (await as(teacher, 'GET', `/teacher/assignments/${assignment}`)).json();
    const g = (id: string) => ov.students.find((s: { studentId: string }) => s.studentId === id).grade;
    expect(g(ka)).toMatchObject({ score: '3.00', maxScore: '3.00', correct: 2 });
    expect(g(kb)).toMatchObject({ score: '0.00', maxScore: '4.00', correct: 0, extra: 2 });
    // ทำชุด ข ถูกทั้งชุด: กลับรายการที่ลอก แล้วลงตามโจทย์ตัวเอง
    const ids = (await db.query('select id from acc.journal_entries where company_id = $1', [coB])).rows.map((x) => x.id as string);
    for (const id of ids) expect((await as(kb, 'POST', `/companies/${coB}/journal/${id}/reverse`, { date: '2026-10-01' })).statusCode).toBeLessThan(300);
    for (const it of SET_B.items) expect((await post(kb, coB, it)).statusCode).toBe(201);
    expect((await as(kb, 'GET', `/companies/${coB}/assignment`)).json().result).toMatchObject({ score: '4.00', correct: 2 });
  });

  it('นักเรียนเข้าห้องทีหลัง: ได้ชุดตามลำดับรหัสของตัวเอง · ลบชุดที่ใช้เป็นชุดเพิ่มไม่ได้', async () => {
    const late = await newUser(school, 'student');
    await db.query('insert into acc.enrollments values ($1, $2)', [room, late]);
    expect((await as(teacher, 'POST', `/teacher/assignments/${assignment}/actions`, { action: 'open-companies' })).statusCode).toBe(200);
    const all = await byCode([...students, late]);
    const expected = all.indexOf(late) % 2 === 0 ? 1 : 2;
    const ov = (await as(teacher, 'GET', `/teacher/assignments/${assignment}`)).json();
    expect(ov.students.find((s: { studentId: string }) => s.studentId === late).setNo).toBe(expected);
    const del = await as(teacher, 'POST', `/teacher/exercises/${setB}/delete`);
    expect([del.statusCode, del.json().message]).toEqual([422, 'ชุดโจทย์นี้มอบหมายแล้ว ลบไม่ได้']);
    expect((await as(teacher, 'GET', '/teacher/exercises')).json().sets.find((s: { id: string }) => s.id === setB).assignments).toBe(1);
  });

  it('สุ่ม: ทุกคนได้ชุดใดชุดหนึ่งของงาน · เลือกชุดซ้ำ / ชุดของครูคนอื่น / เกิน 4 ชุด ไม่ได้', async () => {
    const r = await as(teacher, 'POST', `/teacher/exercises/${setA}/assign`, { classroomId: room, mode: 'practice', companyName: 'สุ่มชุด', extraSets: [setB], distribution: 'random' });
    expect(r.statusCode, r.body).toBe(201);
    const ov = (await as(teacher, 'GET', `/teacher/assignments/${r.json().assignmentId}`)).json();
    expect(ov.students.every((s: { setNo: number }) => s.setNo === 1 || s.setNo === 2)).toBe(true);
    const bad = async (extraSets: string[], msg: string) => {
      const x = await as(teacher, 'POST', `/teacher/exercises/${setA}/assign`, { classroomId: room, mode: 'practice', companyName: `ผิด ${randomUUID().slice(0, 4)}`, extraSets });
      expect([[404, 422].includes(x.statusCode), x.json().message]).toEqual([true, msg]);
    };
    await bad([setA], 'เลือกชุดโจทย์ซ้ำกัน');
    const other = await newUser(school, 'teacher');
    const os = await app.inject({ method: 'POST', url: '/teacher/exercises', payload: SET_B, headers: { 'x-dev-user-id': other, 'x-dev-role': 'teacher', 'idempotency-key': randomUUID() } });
    await bad([os.json().id], 'ไม่พบชุดโจทย์บางชุด');
    expect((await as(teacher, 'POST', `/teacher/exercises/${setA}/assign`, { classroomId: room, mode: 'practice', companyName: 'เกิน', extraSets: [setB, setB, setB, setB] })).statusCode).toBe(400);
  });

  it('งานชุดเดียวแบบเดิมยังเหมือนเดิม: ทุกคนชุด 1', async () => {
    const r = await as(teacher, 'POST', `/teacher/exercises/${setB}/assign`, { classroomId: room, mode: 'practice', companyName: 'ชุดเดียว' });
    const ov = (await as(teacher, 'GET', `/teacher/assignments/${r.json().assignmentId}`)).json();
    expect(new Set(ov.students.map((s: { setNo: number }) => s.setNo))).toEqual(new Set([1]));
    expect(ov.sets).toHaveLength(1);
  });
});
