import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { buildApp } from '../apps/api/src/app';
import { devAuth, sessionAuth } from '../apps/api/src/auth';
import { authConfigFromEnv } from '../apps/api/src/config';
import { createPool } from '../apps/api/src/db';
import { pgListenBus, type RealtimeEvent } from '../apps/api/src/realtime';
import { MAX_CHANNELS, registerWebSocket } from '../apps/api/src/ws';
import { apiUrl, testUrl } from './global-setup';
import { pool as db, newSchool, newUser, newClassroom } from './helpers';

// ดูสดผ่าน WebSocket (/ws, self-host) เปิด socket จริง ฟัง LISTEN/NOTIFY จริง
const ORIGIN = 'http://web.test';
const apiPool = createPool(apiUrl());
const bus = pgListenBus(testUrl());
const cfg = { ...authConfigFromEnv({}), allowedOrigins: [ORIGIN] };
const timing = { pingMs: 200, sessionCheckMs: 200 };
const ws = (app: Parameters<typeof registerWebSocket>[0], ctx: Parameters<typeof registerWebSocket>[1]) => registerWebSocket(app, ctx, timing);
const app = buildApp({ pool: apiPool, auth: devAuth(), bus, cfg, websocket: ws });
// เซสชันจริง (cookie) ใช้ตรวจการตัดเมื่อออกจากระบบ
const real = buildApp({ pool: apiPool, auth: sessionAuth(apiPool, cfg.cookieName), bus, cfg, websocket: ws });
let base = '';
let realBase = '';
afterAll(async () => { await app.close(); await real.close(); await bus.close(); await apiPool.end(); await db.end(); });

const teachers = new Set<string>();
const hdr = (user: string) => ({ 'x-dev-user-id': user, 'x-dev-role': teachers.has(user) ? 'teacher' : 'student', 'idempotency-key': randomUUID() });
const as = (user: string, method: 'GET' | 'POST', url: string, payload?: unknown) => app.inject({ method, url, payload, headers: { ...hdr(user), origin: ORIGIN } });

type Msg = RealtimeEvent & { op?: string; code?: string };
/** เปิด socket แล้วเก็บข้อความ · status = HTTP status ถ้า upgrade ถูกปฏิเสธ */
function open(url: string, headers: Record<string, string>) {
  const s = new WebSocket(url.replace(/^http/, 'ws') + '/ws', { headers });
  const msgs: Msg[] = [];
  let closed: { code: number } | null = null;
  s.on('message', (d) => msgs.push(JSON.parse(String(d))));
  s.on('close', (code) => { closed = { code }; });
  const ready = new Promise<number>((resolve) => {
    s.on('open', () => resolve(101));
    s.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    s.on('error', () => resolve(0));
  });
  async function wait<T>(fn: () => T | undefined, ms = 3000): Promise<T> {
    const t0 = Date.now();
    for (;;) {
      const v = fn();
      if (v !== undefined) return v;
      if (Date.now() - t0 > ms) throw new Error('หมดเวลารอ');
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  return {
    ready, msgs, socket: s,
    send: (m: unknown) => s.send(typeof m === 'string' ? m : JSON.stringify(m)),
    reply: (op: string, ch: string) => wait(() => msgs.find((m) => m.op === op && m.ch === ch)),
    event: (ch: string, k: string) => wait(() => { const i = msgs.findIndex((m) => !m.op && m.ch === ch && m.k === k); return i < 0 ? undefined : msgs.splice(i, 1)[0]; }),
    closed: () => wait(() => closed ?? undefined),
  };
}
const asWs = (user: string) => open(base, { ...hdr(user), origin: ORIGIN });

let teacher: string, other: string, s1: string, s2: string, co1: string, co2: string;

beforeAll(async () => {
  base = await app.listen({ port: 0, host: '127.0.0.1' });
  realBase = await real.listen({ port: 0, host: '127.0.0.1' });
  const school = await newSchool();
  teacher = await newUser(school, 'teacher');
  other = await newUser(school, 'teacher');
  teachers.add(teacher).add(other);
  s1 = await newUser(school, 'student');
  s2 = await newUser(school, 'student');
  const room = await newClassroom(school, teacher, [s1, s2]);
  await newClassroom(school, other, []);
  await as(teacher, 'POST', `/classrooms/${room}/companies`, { name: 'บริษัท ws จำกัด', mode: 'practice' });
  co1 = (await as(s1, 'GET', '/me/companies')).json()[0].id;
  co2 = (await as(s2, 'GET', '/me/companies')).json()[0].id;
  await new Promise((r) => setTimeout(r, 300)); // ให้ LISTEN พร้อม
});

describe('WebSocket ดูสด: เปิดการเชื่อมต่อ', () => {
  it('ไม่ล็อกอิน = 401, origin อื่น/ไม่มี origin = 403 (กัน Cross-Site WebSocket Hijacking)', async () => {
    expect(await open(base, { origin: ORIGIN }).ready).toBe(401);
    expect(await open(base, { ...hdr(s1), origin: 'https://evil.test' }).ready).toBe(403);
    expect(await open(base, hdr(s1)).ready).toBe(403);
  });

  it('ไม่ได้ส่ง websocket ให้ buildApp (Vercel) = ไม่มี /ws', async () => {
    const plain = buildApp({ pool: apiPool, auth: devAuth(), bus, cfg });
    const url = await plain.listen({ port: 0, host: '127.0.0.1' });
    try { expect(await open(url, { ...hdr(s1), origin: ORIGIN }).ready).toBe(404); } finally { await plain.close(); }
  });
});

describe('WebSocket ดูสด: สมัครช่อง', () => {
  it('ครูฟังบริษัทในห้อง + นักเรียนฟังช่องตัวเองในการเชื่อมต่อเดียวกันได้; ได้ event เมื่อร่าง/ผ่านรายการ', async () => {
    const t = asWs(teacher);
    expect(await t.ready).toBe(101);
    t.send({ op: 'sub', ch: `company:${co1}` });
    t.send({ op: 'sub', ch: `company:${co2}` });
    await t.reply('ok', `company:${co1}`);
    await t.reply('ok', `company:${co2}`);
    await as(s1, 'POST', `/companies/${co1}/presence`, { page: 'journal', draft: { date: '2026-10-07', lines: [{ account_code: '1110', debit: '5', credit: '' }] } });
    expect(await t.event(`company:${co1}`, 'presence')).toEqual({ ch: `company:${co1}`, k: 'presence' });
    await as(s1, 'POST', `/companies/${co1}/journal`, { date: '2026-10-07', lines: [{ account_code: '1110', debit: '5' }, { account_code: '4120', credit: '5' }] });
    expect(await t.event(`company:${co1}`, 'journal')).toEqual({ ch: `company:${co1}`, k: 'journal' });
    // ยกเลิกช่องแล้วไม่ได้ event ของช่องนั้นอีก
    t.send({ op: 'unsub', ch: `company:${co1}` });
    await new Promise((r) => setTimeout(r, 100));
    await as(s1, 'POST', `/companies/${co1}/presence`, { page: 'ledger' });
    await as(s2, 'POST', `/companies/${co2}/presence`, { page: 'ledger' });
    await t.event(`company:${co2}`, 'presence');
    expect(t.msgs.some((m) => !m.op && m.ch === `company:${co1}`)).toBe(false);
    t.socket.close();
  });

  it('ฟังช่องของคนอื่นไม่ได้: นักเรียนคนอื่น 403, บริษัทของคนอื่น/ห้องอื่น 404 และไม่ได้ event', async () => {
    const s = asWs(s2);
    await s.ready;
    s.send({ op: 'sub', ch: `student:${s1}` });
    s.send({ op: 'sub', ch: `company:${co1}` });
    expect((await s.reply('err', `student:${s1}`)).code).toBe('forbidden');
    expect((await s.reply('err', `company:${co1}`)).code).toBe('not_found');
    const o = asWs(other);
    await o.ready;
    o.send({ op: 'sub', ch: `company:${co1}` });
    expect((await o.reply('err', `company:${co1}`)).code).toBe('not_found');
    await as(s1, 'POST', `/companies/${co1}/presence`, { page: 'menu' });
    await new Promise((r) => setTimeout(r, 300));
    expect([...s.msgs, ...o.msgs].filter((m) => !m.op)).toEqual([]);
    s.socket.close(); o.socket.close();
  });

  it('นักเรียนได้ watch/unwatch ในช่องตัวเอง', async () => {
    const s = asWs(s1);
    await s.ready;
    s.send({ op: 'sub', ch: `student:${s1}` });
    await s.reply('ok', `student:${s1}`);
    const id = (await as(teacher, 'POST', `/companies/${co1}/spectate`)).json().id;
    expect(await s.event(`student:${s1}`, 'watch')).toMatchObject({ id, by: expect.stringContaining('teacher') });
    await as(teacher, 'POST', `/spectate/${id}/stop`);
    expect(await s.event(`student:${s1}`, 'unwatch')).toMatchObject({ id });
    s.socket.close();
  });

  it('ข้อความผิดรูปแบบ: ช่อง/คำสั่งไม่ถูก = err, ไม่ใช่ JSON = ตัด (4400), เกิน 1 KB = ตัด, เกิน 20 ช่อง = too_many', async () => {
    const s = asWs(s1);
    await s.ready;
    s.send({ op: 'sub', ch: 'company:../../x' });
    s.send({ op: 'drop', ch: `student:${s1}` });
    await new Promise((r) => setTimeout(r, 100));
    expect(s.msgs.filter((m) => m.op === 'err').map((m) => m.code)).toEqual(['invalid', 'invalid']);
    // สมัครช่องเดิมซ้ำ = ok ไม่นับเพิ่ม (เพดานช่องอยู่ในเทสต์ถัดไป)
    for (let i = 0; i < MAX_CHANNELS; i++) s.send({ op: 'sub', ch: `student:${s1}` });
    await s.reply('ok', `student:${s1}`);
    s.send('not json');
    expect((await s.closed()).code).toBe(4400);

    const big = asWs(s1);
    await big.ready;
    big.send({ op: 'sub', ch: `student:${s1}`, pad: 'x'.repeat(2000) });
    expect((await big.closed()).code).toBe(1009);
  });

  it('เพดานช่องต่อการเชื่อมต่อ', async () => {
    // ครูที่มีบริษัทเกินเพดาน: สร้างบริษัทของนักเรียนในห้องเพิ่ม
    const school = await newSchool();
    const t = await newUser(school, 'teacher');
    teachers.add(t);
    const kids = await Promise.all(Array.from({ length: MAX_CHANNELS + 1 }, () => newUser(school, 'student')));
    const room = await newClassroom(school, t, kids);
    await as(t, 'POST', `/classrooms/${room}/companies`, { name: 'เพดาน', mode: 'practice' });
    const cos = (await db.query('select id from acc.companies where classroom_id = $1', [room])).rows.map((r) => r.id as string);
    expect(cos.length).toBe(MAX_CHANNELS + 1);
    const s = asWs(t);
    await s.ready;
    for (const c of cos) s.send({ op: 'sub', ch: `company:${c}` });
    expect((await s.reply('err', `company:${cos[MAX_CHANNELS]}`)).code).toBe('too_many');
    expect(s.msgs.filter((m) => m.op === 'ok')).toHaveLength(MAX_CHANNELS);
    s.socket.close();
  });
});

describe('WebSocket ดูสด: เซสชันจริง', () => {
  it('ออกจากระบบแล้ว socket ที่เปิดอยู่ถูกตัด (4401) ภายในรอบตรวจเซสชัน', async () => {
    const school = await newSchool();
    const u = await newUser(school, 'student');
    const pw = `ws-${randomUUID()}`;
    const { hashPassword } = await import('../apps/api/src/passwords');
    await db.query('insert into acc.credentials (user_id, password_hash, must_change) values ($1, $2, false)', [u, await hashPassword(pw)]);
    const code = (await db.query('select student_code from acc.users where id=$1', [u])).rows[0].student_code;
    const login = await real.inject({ method: 'POST', url: '/auth/login', headers: { origin: ORIGIN }, payload: { kind: 'student', identifier: code, password: pw } });
    expect(login.statusCode).toBe(200);
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    const s = open(realBase, { cookie, origin: ORIGIN });
    expect(await s.ready).toBe(101);
    s.send({ op: 'sub', ch: `student:${u}` });
    await s.reply('ok', `student:${u}`);
    expect((await real.inject({ method: 'POST', url: '/auth/logout', headers: { cookie, origin: ORIGIN } })).statusCode).toBeLessThan(300);
    expect((await s.closed()).code).toBe(4401);
  });
});
