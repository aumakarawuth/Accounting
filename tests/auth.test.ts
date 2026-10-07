import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp } from '../apps/api/src/app';
import { sessionAuth } from '../apps/api/src/auth';
import { authConfigFromEnv, type AuthConfig } from '../apps/api/src/config';
import { createPool } from '../apps/api/src/db';
import { hashPassword, checkPassword, temporaryPassword } from '../apps/api/src/passwords';
import { apiUrl } from './global-setup';
import { pool as admin, newSchool, newUser, newClassroom, newCompany } from './helpers';

const ORIGIN = 'http://localhost:3000';
const cfg: AuthConfig = { ...authConfigFromEnv({}), cookieSecure: true, cookieName: '__Host-sid', ipMaxFailures: 8, allowedOrigins: [ORIGIN] };
const apiPool = createPool(apiUrl());
const app = buildApp({ pool: apiPool, auth: sessionAuth(apiPool, cfg.cookieName), cfg });

let ipSeq = 1;
const freshIp = () => `10.9.${Math.floor(ipSeq / 250)}.${ipSeq++ % 250}`;

let teacher: string, teacherEmail: string, otherTeacher: string, a: string, aCode: string, b: string, coA: string;

async function setPassword(user: string, pw: string, mustChange = false) {
  await admin.query(
    `insert into acc.credentials (user_id, password_hash, must_change) values ($1,$2,$3)
     on conflict (user_id) do update set password_hash = excluded.password_hash, must_change = excluded.must_change`,
    [user, await hashPassword(pw), mustChange]);
}

function login(kind: 'student' | 'staff', identifier: string, password: string, ip = freshIp()) {
  return app.inject({ method: 'POST', url: '/auth/login', remoteAddress: ip, headers: { origin: ORIGIN }, payload: { kind, identifier, password } });
}
function sid(res: { cookies: { name: string; value: string }[] }) {
  const c = res.cookies.find((x) => x.name === cfg.cookieName);
  return c ? `${cfg.cookieName}=${c.value}` : '';
}
const as = (cookie: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, payload, headers: { cookie, origin: ORIGIN } });

beforeAll(async () => {
  const school = await newSchool();
  teacher = await newUser(school, 'teacher');
  otherTeacher = await newUser(school, 'teacher');
  a = await newUser(school, 'student');
  b = await newUser(school, 'student');
  await newClassroom(school, teacher, [a]);
  await newClassroom(school, otherTeacher, [b]);
  coA = await newCompany(a);
  aCode = (await admin.query('select student_code from acc.users where id=$1', [a])).rows[0].student_code;
  teacherEmail = (await admin.query('select email from acc.users where id=$1', [teacher])).rows[0].email;
  await setPassword(a, 'ลงบัญชีทุกวัน');
  await setPassword(b, 'ปิดงบสิ้นเดือน');
  await setPassword(teacher, 'ครูบัญชีห้องห้า');
});
afterAll(async () => { await app.close(); await apiPool.end(); await admin.end(); });

describe('ล็อกอินและเซสชัน', () => {
  it('นักเรียนเข้าด้วยรหัสนักเรียน ได้ cookie HttpOnly Secure SameSite=Lax และใช้งาน API ได้', async () => {
    const r = await login('student', aCode, 'ลงบัญชีทุกวัน');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ role: 'student', mustChange: false });
    const c = r.cookies.find((x) => x.name === '__Host-sid')!;
    expect(c).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax', path: '/' });
    expect(c.value.length).toBeGreaterThanOrEqual(40);
    // DB เก็บเฉพาะแฮชของ token
    const raw = await admin.query('select count(*)::int n from acc.sessions where token_hash = $1', [c.value]);
    expect(raw.rows[0].n).toBe(0);
    const me = await as(sid(r), 'GET', '/auth/me');
    expect(me.json()).toMatchObject({ id: a, role: 'student', studentCode: aCode, mustChange: false });
    const cos = await as(sid(r), 'GET', '/me/companies');
    expect(cos.json().map((x: { id: string }) => x.id)).toEqual([coA]);
  });

  it('ครูเข้าด้วยอีเมล (ไม่สนตัวพิมพ์ใหญ่เล็ก) และไม่มี 2FA', async () => {
    const r = await login('staff', teacherEmail.toUpperCase(), 'ครูบัญชีห้องห้า');
    expect(r.statusCode).toBe(200);
    expect(r.json().role).toBe('teacher');
  });

  it('ไม่มี cookie หรือ cookie ปลอม ได้ 401', async () => {
    expect((await app.inject({ method: 'GET', url: '/auth/me' })).statusCode).toBe(401);
    expect((await as(`${cfg.cookieName}=forged`, 'GET', `/companies/${coA}`)).statusCode).toBe(401);
  });

  it('รหัสผ่านถูกเก็บเป็น Argon2id และไม่หลุดเข้า audit_log', async () => {
    const h = await admin.query('select password_hash from acc.credentials where user_id=$1', [a]);
    expect(h.rows[0].password_hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    const leak = await admin.query(`select count(*)::int n from acc.audit_log where old_row::text like '%argon2%' or new_row::text like '%argon2%'`);
    expect(leak.rows[0].n).toBe(0);
  });

  it('ออกจากระบบแล้ว cookie เดิมใช้ไม่ได้', async () => {
    const c = sid(await login('student', aCode, 'ลงบัญชีทุกวัน'));
    expect((await as(c, 'POST', '/auth/logout')).statusCode).toBe(200);
    expect((await as(c, 'GET', '/auth/me')).statusCode).toBe(401);
  });

  it('ไม่ใช้งานเกิน 8 ชม. เซสชันหมดอายุ', async () => {
    const c = sid(await login('student', aCode, 'ลงบัญชีทุกวัน'));
    await admin.query(`update acc.sessions set last_seen_at = now() - interval '8 hours 1 minute'
                        where user_id = $1 and revoked_at is null`, [a]);
    expect((await as(c, 'GET', '/auth/me')).statusCode).toBe(401);
  });

  it('CSRF: POST จาก origin อื่นหรือไม่มี origin ถูกปฏิเสธ', async () => {
    const c = sid(await login('student', aCode, 'ลงบัญชีทุกวัน'));
    const evil = await app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie: c, origin: 'https://evil.example' } });
    expect(evil.statusCode).toBe(403);
    expect(evil.json().code).toBe('csrf');
    const none = await app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie: c } });
    expect(none.statusCode).toBe(403);
    expect((await as(c, 'GET', '/auth/me')).statusCode).toBe(200);
  });
});

describe('ล็อกชั่วคราว', () => {
  it('ผิด 5 ครั้งล็อก 15 นาที (รหัสถูกก็เข้าไม่ได้) และครูประจำห้องได้รับแจ้ง', async () => {
    const lefts: number[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await login('student', aCode, 'ผิดแน่นอน');
      expect(r.statusCode).toBe(401);
      lefts.push(r.json().left);
    }
    expect(lefts).toEqual([4, 3, 2, 1]);
    const fifth = await login('student', aCode, 'ผิดแน่นอน');
    expect(fifth.statusCode).toBe(423);
    expect(fifth.json()).toMatchObject({ code: 'locked', minutes: 15 });
    expect((await login('student', aCode, 'ลงบัญชีทุกวัน')).statusCode).toBe(423);

    const tc = sid(await login('staff', teacherEmail, 'ครูบัญชีห้องห้า'));
    const alerts = (await as(tc, 'GET', '/teacher/alerts')).json();
    expect(alerts[0]).toMatchObject({ kind: 'locked', studentCode: aCode });

    // ครบ 15 นาทีแล้วปลดล็อกเอง
    await admin.query(`update acc.login_attempts set at = at - interval '16 minutes' where identifier = $1`, [aCode]);
    expect((await login('student', aCode, 'ลงบัญชีทุกวัน')).statusCode).toBe(200);
  });

  it('รหัสนักเรียนที่ไม่มีอยู่จริงตอบแบบเดียวกัน (เดาไม่ได้ว่ารหัสไหนมีอยู่)', async () => {
    const r = await login('student', 'NOPE999', 'อะไรก็ได้');
    expect(r.statusCode).toBe(401);
    expect(r.json()).toEqual({ code: 'bad_credentials', message: 'ข้อมูลเข้าใช้งานไม่ถูกต้อง', left: 4, lockMinutes: 15 });
  });

  it('ต่อ IP: ผิดเกินเพดานจาก IP เดียวได้ 429 แต่ IP อื่นยังเข้าได้', async () => {
    const ip = freshIp();
    for (let i = 0; i < 8; i++) await login('student', `X${i}`, 'ผิด', ip);
    const r = await login('student', aCode, 'ลงบัญชีทุกวัน', ip);
    expect(r.statusCode).toBe(429);
    expect(r.headers['retry-after']).toBeDefined();
    expect((await login('student', aCode, 'ลงบัญชีทุกวัน')).statusCode).toBe(200);
  });
});

describe('รหัสผ่านและการรีเซ็ตโดยครู', () => {
  it('กติการหัสผ่าน: ≥ 8 ตัว, ไม่ใช่รหัสนักเรียน, ไม่อยู่ในรายการยอดแย่, ไม่บังคับสัญลักษณ์', () => {
    expect(checkPassword('ลงบัญ', {})).toBe('length');
    expect(checkPassword('abc65012xyz', { studentCode: '65012' })).toBe('student_code');
    expect(checkPassword('password', {})).toBe('common');
    expect(checkPassword('12345678', {})).toBe('common');
    expect(checkPassword('aaaaaaaa', {})).toBe('common');
    expect(checkPassword('ลงบัญชีทุกวัน', { studentCode: '65012' })).toBeNull();
    expect(checkPassword('kitchen table lamp', {})).toBeNull();
    expect(temporaryPassword()).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
  });

  it('ครูรีเซ็ต: ได้รหัสชั่วคราว, เตะทุกอุปกรณ์, บังคับเปลี่ยนรหัสก่อนใช้งาน', async () => {
    const studentCookie = sid(await login('student', aCode, 'ลงบัญชีทุกวัน'));
    const tc = sid(await login('staff', teacherEmail, 'ครูบัญชีห้องห้า'));
    const reset = await as(tc, 'POST', `/teacher/students/${a}/reset-password`);
    expect(reset.statusCode).toBe(200);
    const temp = reset.json().tempPassword as string;
    expect((await as(studentCookie, 'GET', '/auth/me')).statusCode).toBe(401); // ถูกเตะ

    const r = await login('student', aCode, temp);
    expect(r.json()).toEqual({ role: 'student', mustChange: true });
    const c = sid(r);
    const blocked = await as(c, 'GET', `/companies/${coA}`);
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().code).toBe('must_change_password');

    for (const [pw, reason] of [['สั้น', 'length'], [`x${aCode}yz`, 'student_code'], ['qwerty123', 'common'], [temp, 'same']] as const) {
      const w = await as(c, 'POST', '/auth/change-password', { newPassword: pw });
      expect(w.statusCode, pw).toBe(422);
      expect(w.json().reason, pw).toBe(reason);
    }
    expect((await as(c, 'POST', '/auth/change-password', { newPassword: 'ลงบัญชีทุกวัน2' })).statusCode).toBe(200);
    expect((await as(c, 'GET', `/companies/${coA}`)).statusCode).toBe(200);
    expect((await login('student', aCode, 'ลงบัญชีทุกวัน2')).json().mustChange).toBe(false);
  });

  it('เปลี่ยนรหัสครั้งต่อไปต้องใส่รหัสเดิม และเซสชันอื่นถูกเพิกถอน', async () => {
    const c1 = sid(await login('student', aCode, 'ลงบัญชีทุกวัน2'));
    const c2 = sid(await login('student', aCode, 'ลงบัญชีทุกวัน2'));
    expect((await as(c1, 'POST', '/auth/change-password', { newPassword: 'งบดุลต้องดุลเสมอ' })).statusCode).toBe(403);
    expect((await as(c1, 'POST', '/auth/change-password', { currentPassword: 'ลงบัญชีทุกวัน2', newPassword: 'งบดุลต้องดุลเสมอ' })).statusCode).toBe(200);
    expect((await as(c1, 'GET', '/auth/me')).statusCode).toBe(200);
    expect((await as(c2, 'GET', '/auth/me')).statusCode).toBe(401);
  });

  it('ครูรีเซ็ต/เตะนักเรียนห้องอื่นไม่ได้ และนักเรียนเรียก API ครูไม่ได้', async () => {
    const tc = sid(await login('staff', teacherEmail, 'ครูบัญชีห้องห้า'));
    expect((await as(tc, 'POST', `/teacher/students/${b}/reset-password`)).statusCode).toBe(403);
    expect((await as(tc, 'POST', `/teacher/students/${b}/revoke-sessions`)).statusCode).toBe(403);
    expect((await login('student', (await admin.query('select student_code from acc.users where id=$1', [b])).rows[0].student_code, 'ปิดงบสิ้นเดือน')).statusCode).toBe(200);
    const sc = sid(await login('student', aCode, 'งบดุลต้องดุลเสมอ'));
    expect((await as(sc, 'GET', '/teacher/classrooms')).statusCode).toBe(403);
    const roomsRes = await as(tc, 'GET', '/teacher/classrooms');
    expect(roomsRes.statusCode, roomsRes.body).toBe(200);
    const rooms = roomsRes.json();
    expect(rooms[0].students.map((s: { id: string }) => s.id)).toEqual([a]);
  });

  it('ครูเตะอุปกรณ์ของนักเรียนในห้องได้', async () => {
    const sc = sid(await login('student', aCode, 'งบดุลต้องดุลเสมอ'));
    const tc = sid(await login('staff', teacherEmail, 'ครูบัญชีห้องห้า'));
    const r = await as(tc, 'POST', `/teacher/students/${a}/revoke-sessions`);
    expect(r.json().revoked).toBeGreaterThanOrEqual(1);
    expect((await as(sc, 'GET', '/auth/me')).statusCode).toBe(401);
  });
});
