import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../apps/api/src/app';
import { sessionAuth } from '../apps/api/src/auth';
import { authConfigFromEnv, type AuthConfig } from '../apps/api/src/config';
import { createPool } from '../apps/api/src/db';
import { hashPassword } from '../apps/api/src/passwords';
import { apiUrl } from './global-setup';
import { pool as db, newSchool, newUser, newClassroom } from './helpers';

const ORIGIN = 'http://localhost:3000';
const cfg: AuthConfig = { ...authConfigFromEnv({}), cookieSecure: false, cookieName: 'sid', allowedOrigins: [ORIGIN] };
const apiPool = createPool(apiUrl());
const app = buildApp({ pool: apiPool, auth: sessionAuth(apiPool, cfg.cookieName), cfg });
let ip = 1;

async function setPw(user: string, pw: string) {
  await db.query(`insert into acc.credentials (user_id, password_hash, must_change) values ($1,$2,false)
                  on conflict (user_id) do update set password_hash = excluded.password_hash, must_change = false`, [user, await hashPassword(pw)]);
}
async function login(kind: 'student' | 'staff', identifier: string, password: string) {
  const r = await app.inject({ method: 'POST', url: '/auth/login', remoteAddress: `10.7.0.${ip++ % 250}`, headers: { origin: ORIGIN }, payload: { kind, identifier, password } });
  const c = r.cookies.find((x) => x.name === 'sid');
  return { res: r, cookie: c ? `sid=${c.value}` : '' };
}
const call = (cookie: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, payload, headers: { cookie, origin: ORIGIN } });
const emailOf = async (id: string) => (await db.query('select email from acc.users where id=$1', [id])).rows[0].email as string;

let school: string, adminC: string, adminId: string, teacherId: string, teacherC: string, otherTeacherC: string, room: string, otherRoom: string;

beforeAll(async () => {
  school = await newSchool();
  adminId = await newUser(school, 'admin');
  teacherId = await newUser(school, 'teacher');
  const other = await newUser(school, 'teacher');
  await Promise.all([setPw(adminId, 'ผู้ดูแลระบบโรงเรียน'), setPw(teacherId, 'ครูบัญชีห้องห้า'), setPw(other, 'ครูอีกห้องหนึ่ง')]);
  room = await newClassroom(school, teacherId, []);
  otherRoom = await newClassroom(school, other, []);
  adminC = (await login('staff', await emailOf(adminId), 'ผู้ดูแลระบบโรงเรียน')).cookie;
  teacherC = (await login('staff', await emailOf(teacherId), 'ครูบัญชีห้องห้า')).cookie;
  otherTeacherC = (await login('staff', await emailOf(other), 'ครูอีกห้องหนึ่ง')).cookie;
});
afterAll(async () => { await app.close(); await apiPool.end(); await db.end(); });

describe('นำเข้านักเรียนจาก CSV', () => {
  const tag = randomUUID().slice(0, 6).replace(/[^0-9a-z]/g, 'x');
  const rows = [
    { studentCode: `${tag}-01`, name: 'กมลชนก ใจดี' },
    { studentCode: `${tag}-02`, name: 'เขมินท์ รักเรียน' },
  ];

  it('ครูนำเข้าห้องตัวเอง: สร้างบัญชี ได้รหัสชั่วคราวเฉพาะคนใหม่ และเข้าใช้ได้แบบต้องเปลี่ยนรหัส', async () => {
    const r = await call(teacherC, 'POST', `/classrooms/${room}/import`, { rows });
    expect(r.statusCode).toBe(200);
    const res = r.json().results;
    expect(res.map((x: { status: string }) => x.status)).toEqual(['created', 'created']);
    expect(res[0].tempPassword).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
    const l = await login('student', rows[0].studentCode, res[0].tempPassword);
    expect(l.res.json()).toEqual({ role: 'student', mustChange: true });
    // ไม่เก็บรหัสชั่วคราวเป็นข้อความธรรมดาที่ไหน
    const leak = await db.query(`select count(*)::int n from acc.audit_log where new_row::text like $1`, [`%${res[0].tempPassword}%`]);
    expect(leak.rows[0].n).toBe(0);
    const rooms = (await call(teacherC, 'GET', '/teacher/classrooms')).json();
    expect(rooms.find((x: { id: string }) => x.id === room).students).toHaveLength(2);
  });

  it('นำเข้าซ้ำ: คนที่อยู่ห้องนี้แล้วไม่เปลี่ยน ไม่ออกรหัสใหม่; ผู้ดูแลเพิ่มคนเดิมเข้าห้องอื่นได้', async () => {
    const again = (await call(teacherC, 'POST', `/classrooms/${room}/import`, { rows })).json().results;
    expect(again.map((x: { status: string; tempPassword?: string }) => [x.status, x.tempPassword])).toEqual([['already', undefined], ['already', undefined]]);
    const moved = (await call(adminC, 'POST', `/classrooms/${otherRoom}/import`, { rows: [rows[0]] })).json().results;
    expect(moved[0].status).toBe('enrolled');
    expect(moved[0].tempPassword).toBeUndefined();
  });

  it('ห้องของครูคนอื่นนำเข้าไม่ได้ และข้อมูลผิดรูปแบบถูกปฏิเสธทั้งชุด', async () => {
    expect((await call(otherTeacherC, 'POST', `/classrooms/${room}/import`, { rows })).statusCode).toBe(403);
    const bad = [
      { rows: [{ studentCode: 'ก123', name: 'x' }] },
      { rows: [{ studentCode: 'A1', name: '' }] },
      { rows: [rows[0], rows[0]] },
      { rows: [{ ...rows[0], citizenId: '1234567890123' }] }, // PDPA: ไม่รับเลขบัตรประชาชน
      { rows: [] },
    ];
    for (const b of bad) expect((await call(teacherC, 'POST', `/classrooms/${room}/import`, b)).statusCode, JSON.stringify(b)).toBe(400);
  });

  it('รหัสที่เป็นบัญชีครูอยู่แล้วนำเข้าเป็นนักเรียนไม่ได้', async () => {
    await db.query(`update acc.users set student_code = 'T-CONFLICT' where id = $1`, [teacherId]).catch(() => {});
    const r = await call(teacherC, 'POST', `/classrooms/${room}/import`, { rows: [{ studentCode: 'T-CONFLICT', name: 'x' }] });
    expect(r.statusCode).toBe(409);
    await db.query(`update acc.users set student_code = null where id = $1`, [teacherId]);
  });
});

describe('หน้าผู้ดูแล: ครูและห้อง', () => {
  let newTeacher: string, temp: string;
  const email = `new-${randomUUID().slice(0, 8)}@school.test`;

  it('สร้างครู ได้รหัสชั่วคราว ล็อกอินได้แบบต้องเปลี่ยนรหัส; อีเมลซ้ำได้ 409', async () => {
    const r = await call(adminC, 'POST', '/admin/staff', { email: email.toUpperCase(), name: 'ครูใหม่' });
    expect(r.statusCode).toBe(201);
    ({ id: newTeacher, tempPassword: temp } = r.json());
    expect((await login('staff', email, temp)).res.json()).toEqual({ role: 'teacher', mustChange: true });
    const dup = await call(adminC, 'POST', '/admin/staff', { email, name: 'ซ้ำ' });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().code).toBe('ACC08');
  });

  it('สร้างห้อง กำหนดครู ย้ายครู และเห็นจำนวนนักเรียน', async () => {
    const c = await call(adminC, 'POST', '/admin/classrooms', { name: 'ม.6/1 บัญชี', teacherId });
    expect(c.statusCode).toBe(201);
    const id = c.json().id;
    expect((await call(adminC, 'POST', `/admin/classrooms/${id}/teacher`, { teacherId: newTeacher })).statusCode).toBe(200);
    const list = (await call(adminC, 'GET', '/admin/classrooms')).json();
    expect(list.find((x: { id: string }) => x.id === id)).toMatchObject({ teacherId: newTeacher, students: 0 });
    expect(list.find((x: { id: string }) => x.id === room).students).toBe(2);
    // กำหนดผู้ดูแลเป็นครูประจำห้องไม่ได้
    expect((await call(adminC, 'POST', `/admin/classrooms/${id}/teacher`, { teacherId: adminId })).statusCode).toBe(422);
  });

  it('รีเซ็ตรหัสครูและปิดบัญชี: ถูกเตะทันทีและล็อกอินไม่ได้; ปิดบัญชีตัวเองไม่ได้', async () => {
    const t = await login('staff', email, temp);
    const reset = (await call(adminC, 'POST', `/admin/users/${newTeacher}/reset-password`)).json().tempPassword;
    expect((await call(t.cookie, 'GET', '/auth/me')).statusCode).toBe(401);
    const t2 = await login('staff', email, reset);
    expect(t2.res.statusCode).toBe(200);
    expect((await call(adminC, 'POST', `/admin/users/${newTeacher}/active`, { active: false })).statusCode).toBe(200);
    expect((await call(t2.cookie, 'GET', '/auth/me')).statusCode).toBe(401);
    expect((await login('staff', email, reset)).res.statusCode).toBe(401);
    expect((await call(adminC, 'POST', `/admin/users/${adminId}/active`, { active: false })).statusCode).toBe(409);
    const staff = (await call(adminC, 'GET', '/admin/staff')).json();
    expect(staff.find((x: { id: string }) => x.id === newTeacher).active).toBe(false);
  });

  it('audit log: ผู้ดูแลเห็น การนำเข้า/รีเซ็ตรหัส/การแก้ ไม่มีแฮชรหัสผ่าน; ครูเรียกไม่ได้', async () => {
    const r = await call(adminC, 'GET', '/admin/audit');
    expect(r.statusCode).toBe(200);
    const ops = r.json().map((x: { op: string }) => x.op);
    expect(ops).toEqual(expect.arrayContaining(['IMPORT_STUDENTS', 'PASSWORD_RESET', 'UPDATE', 'INSERT']));
    expect(r.body).not.toContain('argon2');
    const upd = r.json().find((x: { op: string; table: string }) => x.op === 'UPDATE' && x.table === 'users');
    expect(upd.changed).toEqual(['active']);
    expect(upd.target).toBe('ครูใหม่');
    const imp = r.json().find((x: { op: string }) => x.op === 'IMPORT_STUDENTS');
    expect(imp.target).toBeTruthy();
    for (const path of ['/admin/audit', '/admin/staff', '/admin/classrooms']) {
      expect((await call(teacherC, 'GET', path)).statusCode, path).toBe(403);
    }
  });

  it('ผู้ดูแลโรงเรียนอื่นไม่เห็นและแก้อะไรของโรงเรียนนี้ไม่ได้', async () => {
    const s2 = await newSchool();
    const a2 = await newUser(s2, 'admin');
    await setPw(a2, 'ผู้ดูแลโรงเรียนอื่น');
    const c2 = (await login('staff', await emailOf(a2), 'ผู้ดูแลโรงเรียนอื่น')).cookie;
    expect((await call(c2, 'GET', '/admin/classrooms')).json()).toEqual([]);
    expect((await call(c2, 'GET', '/admin/staff')).json().map((x: { id: string }) => x.id)).toEqual([a2]);
    const audit = (await call(c2, 'GET', '/admin/audit')).json();
    expect(audit.every((x: { userName: string | null }) => x.userName === null || x.userName.includes(a2.slice(0, 8)))).toBe(true);
    expect((await call(c2, 'POST', `/admin/users/${teacherId}/reset-password`)).statusCode).toBe(422);
    expect((await call(c2, 'POST', `/admin/users/${teacherId}/active`, { active: false })).statusCode).toBe(422);
    expect((await call(c2, 'POST', `/admin/classrooms/${room}/teacher`, { teacherId: a2 })).statusCode).toBe(422);
    expect((await call(c2, 'POST', `/classrooms/${room}/import`, { rows: [{ studentCode: 'X1', name: 'x' }] })).statusCode).toBe(403);
  });
});
