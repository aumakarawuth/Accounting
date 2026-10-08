import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../apps/api/src/app';
import { devAuth } from '../apps/api/src/auth';
import { authConfigFromEnv } from '../apps/api/src/config';
import { createPool } from '../apps/api/src/db';
import { apiUrl } from './global-setup';
import { pool as db, asUser, newSchool, newUser, newClassroom, newCompany } from './helpers';

// รหัสห้อง/QR และคอมเมนต์ปากกาแดง (ผ่าน API จริงบน Postgres จริง)
const apiPool = createPool(apiUrl());
const app = buildApp({ pool: apiPool, auth: devAuth(), cfg: { ...authConfigFromEnv({}), allowedOrigins: false } });
afterAll(async () => { await app.close(); await apiPool.end(); await db.end(); });

const roles = new Map<string, string>();
const as = (user: string, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url, payload, headers: {
    'x-dev-user-id': user, 'x-dev-role': roles.get(user) ?? 'student', 'idempotency-key': randomUUID() } });
const user = async (school: string, role: 'student' | 'teacher' | 'admin') => {
  const id = await newUser(school, role);
  roles.set(id, role);
  return id;
};

let school: string, teacher: string, other: string, admin: string, s1: string, s2: string, room: string, room2: string;

beforeAll(async () => {
  school = await newSchool();
  teacher = await user(school, 'teacher');
  other = await user(school, 'teacher');
  admin = await user(school, 'admin');
  s1 = await user(school, 'student');
  s2 = await user(school, 'student');
  room = await newClassroom(school, teacher, [s1]);
  room2 = await newClassroom(school, other, []);
});

describe('รหัสห้อง', () => {
  const setCode = (u: string, r: string, enabled: boolean) => as(u, 'POST', `/classrooms/${r}/join-code`, { enabled });
  const join = (u: string, code: string) => as(u, 'POST', '/classrooms/join', { code });
  const enrolled = async (r: string, u: string) =>
    (await db.query('select 1 from acc.enrollments where classroom_id = $1 and user_id = $2', [r, u])).rowCount === 1;

  it('ครูสร้างรหัส 6 ตัวที่อ่านไม่สับสน ครูห้องอื่นและนักเรียนสร้างไม่ได้', async () => {
    const r = await setCode(teacher, room, true);
    expect(r.statusCode).toBe(200);
    expect(r.json().joinCode).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    expect((await as(teacher, 'GET', '/teacher/classrooms')).json().find((x: { id: string }) => x.id === room).joinCode).toBe(r.json().joinCode);
    expect((await setCode(other, room, true)).statusCode).toBe(403);
    expect((await setCode(s1, room, true)).statusCode).toBe(403);
    expect((await setCode(admin, room2, true)).statusCode).toBe(200); // ผู้ดูแลโรงเรียนเดียวกันตั้งให้ได้
  });

  it('นักเรียนเข้าห้องด้วยรหัส (ตัวเล็ก/เว้นวรรคได้) เข้าซ้ำไม่เป็นไร', async () => {
    const code = (await setCode(teacher, room, true)).json().joinCode as string;
    const r = await join(s2, ` ${code.toLowerCase()} `);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ classroomId: room, name: 'ห้อง ๑', already: false });
    expect(await enrolled(room, s2)).toBe(true);
    expect((await join(s2, code)).json().already).toBe(true);
    // ครูเห็นนักเรียนคนใหม่ในห้อง และบันทึกใน audit log
    const students = (await as(teacher, 'GET', '/teacher/classrooms')).json().find((x: { id: string }) => x.id === room).students;
    expect(students.map((s: { id: string }) => s.id)).toContain(s2);
    const audit = await db.query(`select 1 from acc.audit_log where op = 'JOIN_BY_CODE' and user_id = $1`, [s2]);
    expect(audit.rowCount).toBe(1);
  });

  it('รหัสเก่าใช้ไม่ได้ทันทีเมื่อสร้างใหม่หรือปิดรหัส รหัสผิดรูปแบบได้ 400', async () => {
    const old = (await setCode(teacher, room, true)).json().joinCode as string;
    const fresh = (await setCode(teacher, room, true)).json().joinCode as string;
    expect(fresh).not.toBe(old);
    const s3 = await user(school, 'student');
    const bad = await join(s3, old);
    expect([bad.statusCode, bad.json().code]).toEqual([422, 'ACC04']);
    expect((await setCode(teacher, room, false)).json()).toEqual({ joinCode: null });
    expect((await join(s3, fresh)).statusCode).toBe(422);
    expect((await join(s3, 'ABC10O')).statusCode).toBe(400);
    expect(await enrolled(room, s3)).toBe(false);
  });

  it('ครูใช้รหัสเข้าห้องไม่ได้ นักเรียนโรงเรียนอื่นใช้รหัสไม่ได้', async () => {
    const code = (await setCode(teacher, room, true)).json().joinCode as string;
    expect((await as(other, 'POST', '/classrooms/join', { code })).statusCode).toBe(403);
    const school2 = await newSchool();
    const outsider = await user(school2, 'student');
    expect((await join(outsider, code)).statusCode).toBe(422);
    expect(await enrolled(room, outsider)).toBe(false);
  });

  it('เดารหัสได้ไม่เกิน 20 ครั้งต่อ 15 นาที', async () => {
    const s4 = await user(school, 'student');
    const codes = await Promise.all(Array.from({ length: 21 }, () => join(s4, 'ZZZZZZ')));
    expect(codes.filter((r) => r.statusCode === 429)).toHaveLength(1);
  });
});

describe('คอมเมนต์ปากกาแดง', () => {
  let co: string, entry: string;
  type C = { id: string; lineNo: number | null; body: string; authorName: string | null; mine: boolean };
  const comments = async (u: string) => (await as(u, 'GET', `/companies/${co}/journal/${entry}`)).json().comments as C[];
  const add = (u: string, lineNo: number | null, body: string, e = entry) =>
    as(u, 'POST', `/companies/${co}/journal/${e}/comments`, { lineNo, body });

  beforeAll(async () => {
    co = await newCompany(s1, room);
    const r = await as(s1, 'POST', `/companies/${co}/journal`, { date: '2026-10-05', description: 'ขายสด', lines: [
      { account_code: '1110', debit: '1000' }, { account_code: '4110', credit: '1000' }] });
    entry = r.json().id;
  });

  it('ครูประจำห้องคอมเมนต์ที่บรรทัดและทั้งรายการ นักเรียนเห็นแต่ไม่เห็นชื่อครู', async () => {
    expect((await add(teacher, 2, '  รายได้จากการขายใช้ 4110 ถูกแล้ว แต่ควรมีภาษีขาย  ')).statusCode).toBe(201);
    expect((await add(teacher, null, 'ดีมาก')).statusCode).toBe(201);
    const t = await comments(teacher);
    expect(t.map((c) => [c.lineNo, c.body, c.mine])).toEqual([
      [2, 'รายได้จากการขายใช้ 4110 ถูกแล้ว แต่ควรมีภาษีขาย', true], [null, 'ดีมาก', true]]);
    expect(t[0]!.authorName).toMatch(/^teacher /);
    const s = await comments(s1);
    expect(s.map((c) => [c.lineNo, c.authorName, c.mine])).toEqual([[2, null, false], [null, null, false]]);
    const list = (await as(s1, 'GET', `/companies/${co}/journal`)).json() as { id: string; comments: number }[];
    expect(list.find((e) => e.id === entry)!.comments).toBe(2);
  });

  it('นักเรียน ครูห้องอื่น คอมเมนต์ไม่ได้ บรรทัดที่ไม่มีหรือข้อความว่างถูกปฏิเสธ', async () => {
    expect((await add(s1, 1, 'เขียนเอง')).statusCode).toBe(403);
    expect((await add(other, 1, 'ห้องอื่น')).statusCode).toBe(404);
    const noLine = await add(teacher, 9, 'ไม่มีบรรทัดนี้');
    expect([noLine.statusCode, noLine.json().message]).toEqual([422, 'ไม่พบบรรทัดที่ 9 ในรายการนี้']);
    expect((await add(teacher, 1, '   ')).statusCode).toBe(400);
    expect((await add(teacher, 1, 'x', randomUUID())).statusCode).toBe(422);
  });

  it('คอมเมนต์ได้แม้งานถูกล็อกระหว่างตรวจ', async () => {
    const work = await asUser(s1, async (c) => (await c.query(`select acc.create_company('โจทย์ล็อก', $1) id`, [room])).rows[0].id as string);
    await db.query(`update acc.companies set mode = 'submit', version = version + 1 where id = $1`, [work]);
    const e = (await as(s1, 'POST', `/companies/${work}/journal`, { date: '2026-10-05', lines: [
      { account_code: '1110', debit: '5' }, { account_code: '4110', credit: '5' }] })).json().id;
    expect((await as(s1, 'POST', `/companies/${work}/submission`, { action: 'submit', expected: 'draft' })).statusCode).toBe(200);
    expect((await as(teacher, 'POST', `/companies/${work}/journal/${e}/comments`, { lineNo: 1, body: 'ตรวจแล้ว' })).statusCode).toBe(201);
  });

  it('ลบได้เฉพาะคอมเมนต์ของตัวเอง ลบแล้วหายจากทุกคนแต่ยังอยู่ใน audit log', async () => {
    const id = (await add(teacher, 1, 'จะลบ')).json().id as string;
    expect((await as(s1, 'DELETE', `/companies/${co}/comments/${id}`)).statusCode).toBe(422);
    expect((await as(teacher, 'DELETE', `/companies/${co}/comments/${id}`)).json()).toEqual({ deleted: true });
    expect((await comments(s1)).some((c) => c.id === id)).toBe(false);
    expect((await comments(teacher)).some((c) => c.id === id)).toBe(false);
    expect((await as(teacher, 'DELETE', `/companies/${co}/comments/${id}`)).statusCode).toBe(422);
    const audit = await db.query(`select op from acc.audit_log where table_name = 'comments' and row_pk = $1 order by id`, [id]);
    expect(audit.rows.map((r) => r.op)).toEqual(['INSERT', 'UPDATE']);
  });

  it('ครูเปิดดูรายการถูกบันทึก', async () => {
    const before = (await db.query(`select count(*)::int n from acc.audit_log where op = 'VIEW' and user_id = $1`, [teacher])).rows[0].n;
    await comments(teacher);
    await comments(s1);
    const after = (await db.query(`select count(*)::int n from acc.audit_log where op = 'VIEW' and user_id = $1`, [teacher])).rows[0].n;
    expect(after).toBe(before + 1);
  });
});
