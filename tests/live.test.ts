import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../apps/api/src/app';
import { devAuth } from '../apps/api/src/auth';
import { authConfigFromEnv } from '../apps/api/src/config';
import { createPool } from '../apps/api/src/db';
import { pgListenBus, type RealtimeEvent } from '../apps/api/src/realtime';
import { apiUrl, testUrl } from './global-setup';
import { pool as db, newSchool, newUser, newClassroom } from './helpers';

const apiPool = createPool(apiUrl());
const bus = pgListenBus(testUrl());
const app = buildApp({ pool: apiPool, auth: devAuth(), bus, cfg: { ...authConfigFromEnv({}), allowedOrigins: false } });
let base = '';
afterAll(async () => { await app.close(); await bus.close(); await apiPool.end(); await db.end(); });

const teachers = new Set<string>();
const hdr = (user: string) => ({ 'x-dev-user-id': user, 'x-dev-role': teachers.has(user) ? 'teacher' : 'student', 'idempotency-key': randomUUID() });
const as = (user: string, method: 'GET' | 'POST', url: string, payload?: unknown) => app.inject({ method, url, payload, headers: hdr(user) });
const draft = (lines: [string, string, string][]) => ({ date: '2026-10-07', description: 'ร่าง', lines: lines.map(([account_code, debit, credit]) => ({ account_code, debit, credit })) });

/** เปิด SSE จริงผ่าน HTTP แล้วรอ event แรกที่ตรงเงื่อนไข */
async function sse(user: string, channel: string) {
  const ctrl = new AbortController();
  const res = await fetch(`${base}/realtime?channel=${channel}`, { headers: hdr(user), signal: ctrl.signal });
  const events: RealtimeEvent[] = [];
  const waiters: (() => void)[] = [];
  if (res.ok) void (async () => {
    const reader = res.body!.getReader();
    let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += new TextDecoder().decode(value);
        for (let i; (i = buf.indexOf('\n\n')) >= 0; buf = buf.slice(i + 2)) {
          const data = buf.slice(0, i).split('\n').find((l) => l.startsWith('data: '));
          if (data) { events.push(JSON.parse(data.slice(6))); waiters.splice(0).forEach((w) => w()); }
        }
      }
    } catch { /* ยกเลิก */ }
  })();
  return {
    status: res.status,
    close: () => ctrl.abort(),
    async next(kind: string, ms = 3000) {
      const t0 = Date.now();
      for (;;) {
        const e = events.find((x) => x.k === kind);
        if (e) { events.splice(events.indexOf(e), 1); return e; }
        if (Date.now() - t0 > ms) throw new Error(`ไม่ได้ event ${kind} ภายใน ${ms}ms`);
        await new Promise<void>((r) => { waiters.push(r); setTimeout(r, 100); });
      }
    },
  };
}

let teacher: string, other: string, s1: string, s2: string, room: string, co1: string, co2: string;

beforeAll(async () => {
  base = await app.listen({ port: 0, host: '127.0.0.1' });
  const school = await newSchool();
  teacher = await newUser(school, 'teacher');
  other = await newUser(school, 'teacher');
  teachers.add(teacher).add(other);
  s1 = await newUser(school, 'student');
  s2 = await newUser(school, 'student');
  room = await newClassroom(school, teacher, [s1, s2]);
  await newClassroom(school, other, []);
  await as(teacher, 'POST', `/classrooms/${room}/companies`, { name: 'บริษัท ก. จำกัด', mode: 'practice' });
  co1 = (await as(s1, 'GET', '/me/companies')).json()[0].id;
  co2 = (await as(s2, 'GET', '/me/companies')).json()[0].id;
  await new Promise((r) => setTimeout(r, 300)); // ให้ LISTEN พร้อม
});

describe('ร่างและหน้าที่เปิด (presence)', () => {
  it('ยอดร่างคำนวณที่ DB จากบรรทัด (ไม่เชื่อ client) และเห็นผลต่าง', async () => {
    expect((await as(s1, 'POST', `/companies/${co1}/presence`, { page: 'journal', draft: draft([['1110', '12500', ''], ['4120', '', '12000'], ['', 'abc', '']]) })).statusCode).toBe(200);
    const live = (await as(teacher, 'GET', `/companies/${co1}/live`)).json();
    expect(live.presence).toMatchObject({ page: 'journal', draftDebit: '12500.00', draftCredit: '12000.00', draftLines: 3 });
    expect(live.presence.draft.lines[0]).toEqual({ account_code: '1110', debit: '12500', credit: '' });
  });

  it('รายงานแทนคนอื่นไม่ได้ ร่างใหญ่เกินถูกปฏิเสธ ครูห้องอื่นอ่านไม่ได้', async () => {
    expect((await as(s2, 'POST', `/companies/${co1}/presence`, { page: 'home' })).statusCode).toBe(403);
    expect((await as(teacher, 'POST', `/companies/${co1}/presence`, { page: 'home' })).statusCode).toBe(403);
    const big = draft(Array.from({ length: 201 }, () => ['1110', '1', ''] as [string, string, string]));
    expect((await as(s1, 'POST', `/companies/${co1}/presence`, { page: 'journal', draft: big })).statusCode).toBe(400);
    expect((await as(other, 'GET', `/companies/${co1}/live`)).statusCode).toBe(404);
    expect((await as(s2, 'GET', `/companies/${co1}/live`)).statusCode).toBe(404);
  });

  it('ออกจากหน้าสมุดรายวันแล้วร่างล่าสุดยังอยู่ ล้างได้เมื่อผ่านรายการ', async () => {
    await as(s1, 'POST', `/companies/${co1}/presence`, { page: 'ledger' });
    let p = (await as(teacher, 'GET', `/companies/${co1}/live`)).json().presence;
    expect([p.page, p.draftDebit]).toEqual(['ledger', '12500.00']);
    await as(s1, 'POST', `/companies/${co1}/presence/clear-draft`);
    p = (await as(teacher, 'GET', `/companies/${co1}/live`)).json().presence;
    expect([p.draft, p.draftDebit]).toEqual([null, null]);
  });
});

describe('แดชบอร์ดห้อง', () => {
  it('ครูเห็นนักเรียนทุกคน บริษัทล่าสุด หน้าที่เปิด และยอดร่าง; ห้องอื่นไม่ได้', async () => {
    await as(s1, 'POST', `/companies/${co1}/presence`, { page: 'journal', draft: draft([['1110', '100', ''], ['4120', '', '90']]) });
    const rows = (await as(teacher, 'GET', `/teacher/classrooms/${room}/live`)).json();
    expect(rows).toHaveLength(2);
    const r1 = rows.find((r: { studentId: string }) => r.studentId === s1);
    expect(r1).toMatchObject({ companyId: co1, page: 'journal', draftDebit: '100.00', draftCredit: '90.00' });
    expect(rows.find((r: { studentId: string }) => r.studentId === s2)).toMatchObject({ companyId: co2, page: null });
    expect((await as(other, 'GET', `/teacher/classrooms/${room}/live`)).statusCode).toBe(403);
    expect((await as(s1, 'GET', `/teacher/classrooms/${room}/live`)).statusCode).toBe(403);
  });
});

describe('ดูสดและการแจ้งนักเรียน', () => {
  it('ครูเริ่มดู → บันทึก spectate_log และนักเรียนเห็นชื่อครู; หยุดแล้วหาย; เกิน 45 วินาทีไม่มีสัญญาณก็หาย', async () => {
    const st = await as(teacher, 'POST', `/companies/${co1}/spectate`);
    expect(st.statusCode).toBe(201);
    const id = st.json().id;
    const log = await db.query('select teacher_id, student_id, company_id, ended_at from acc.spectate_log where id=$1', [id]);
    expect(log.rows[0]).toEqual({ teacher_id: teacher, student_id: s1, company_id: co1, ended_at: null });
    const w = (await as(s1, 'GET', '/me/watchers')).json();
    expect(w).toEqual([{ id, teacherName: expect.stringContaining('teacher'), companyId: co1 }]);
    expect((await as(s2, 'GET', '/me/watchers')).json()).toEqual([]);

    await db.query(`update acc.spectate_log set last_ping_at = now() - interval '46 seconds' where id=$1`, [id]);
    expect((await as(s1, 'GET', '/me/watchers')).json()).toEqual([]);
    expect((await as(teacher, 'POST', `/spectate/${id}/ping`)).statusCode).toBe(200);
    expect((await as(s1, 'GET', '/me/watchers')).json()).toHaveLength(1);
    expect((await as(teacher, 'POST', `/spectate/${id}/stop`)).statusCode).toBe(200);
    expect((await as(s1, 'GET', '/me/watchers')).json()).toEqual([]);
    expect((await db.query('select ended_at from acc.spectate_log where id=$1', [id])).rows[0].ended_at).not.toBeNull();
  });

  it('ครูห้องอื่นและนักเรียนเริ่มดูสดไม่ได้; ครูคนอื่น ping/stop ของคนอื่นไม่ได้', async () => {
    expect((await as(other, 'POST', `/companies/${co1}/spectate`)).statusCode).toBe(403);
    expect((await as(s2, 'POST', `/companies/${co1}/spectate`)).statusCode).toBe(403);
    const id = (await as(teacher, 'POST', `/companies/${co1}/spectate`)).json().id;
    expect((await as(other, 'POST', `/spectate/${id}/ping`)).statusCode).toBe(422);
    await as(other, 'POST', `/spectate/${id}/stop`);
    expect((await as(s1, 'GET', '/me/watchers')).json()).toHaveLength(1);
    await as(teacher, 'POST', `/spectate/${id}/stop`);
  });
});

describe('realtime (SSE จริงผ่าน HTTP)', () => {
  it('ครูฟังช่องบริษัท: ได้ event เมื่อนักเรียนพิมพ์ร่างและเมื่อผ่านรายการ (มีแค่สัญญาณ ไม่มีข้อมูลบัญชี)', async () => {
    const s = await sse(teacher, `company:${co1}`);
    expect(s.status).toBe(200);
    await as(s1, 'POST', `/companies/${co1}/presence`, { page: 'journal', draft: draft([['1110', '5', '']]) });
    expect(await s.next('presence')).toEqual({ ch: `company:${co1}`, k: 'presence' });
    await as(s1, 'POST', `/companies/${co1}/journal`, { date: '2026-10-07', lines: [{ account_code: '1110', debit: '5' }, { account_code: '4120', credit: '5' }] });
    expect(await s.next('journal')).toEqual({ ch: `company:${co1}`, k: 'journal' });
    s.close();
  });

  it('นักเรียนฟังช่องตัวเอง: ได้ watch/unwatch พร้อมชื่อครู', async () => {
    const s = await sse(s1, `student:${s1}`);
    const id = (await as(teacher, 'POST', `/companies/${co1}/spectate`)).json().id;
    expect(await s.next('watch')).toMatchObject({ id, company: co1, by: expect.any(String) });
    await as(teacher, 'POST', `/spectate/${id}/stop`);
    expect(await s.next('unwatch')).toMatchObject({ id });
    s.close();
  });

  it('ปิดสตรีมเองตามเวลาที่ตั้ง (บน Vercel ต้องปิดก่อน function ถูกตัด) และบอกให้เบราว์เซอร์ต่อใหม่', async () => {
    const short = buildApp({ pool: apiPool, auth: devAuth(), bus, streamMaxMs: 300, cfg: { ...authConfigFromEnv({}), allowedOrigins: false } });
    const url = await short.listen({ port: 0, host: '127.0.0.1' });
    try {
      const started = Date.now();
      const res = await fetch(`${url}/realtime?channel=student:${s1}`, { headers: hdr(s1) });
      const body = await res.text(); // จบได้เพราะเซิร์ฟเวอร์ปิดเอง
      expect(Date.now() - started).toBeLessThan(5000);
      expect(body).toContain('retry: 3000');
    } finally {
      await short.close();
    }
  });

  it('ฟังช่องที่ไม่มีสิทธิ์ไม่ได้', async () => {
    expect((await sse(s2, `company:${co1}`)).status).toBe(404);
    expect((await sse(s2, `student:${s1}`)).status).toBe(403);
    expect((await sse(other, `company:${co1}`)).status).toBe(404);
    expect((await sse(s1, 'classroom:x')).status).toBe(400);
  });
});
