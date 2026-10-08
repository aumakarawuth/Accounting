import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../apps/api/src/app';
import { devAuth } from '../apps/api/src/auth';
import { authConfigFromEnv } from '../apps/api/src/config';
import { createPool } from '../apps/api/src/db';
import { apiUrl } from './global-setup';
import { pool as db, asUser, newSchool, newUser, newClassroom, newCompany } from './helpers';

// หน้าดูรายการ + กลับรายการ, ผังบัญชี, ปิดงวด (ผ่าน API จริงบน Postgres จริง)
const apiPool = createPool(apiUrl());
const app = buildApp({ pool: apiPool, auth: devAuth(), cfg: { ...authConfigFromEnv({}), allowedOrigins: false } });
afterAll(async () => { await app.close(); await apiPool.end(); await db.end(); });

const teachers = new Set<string>();
const as = (user: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown, key = randomUUID()) =>
  app.inject({ method, url, payload, headers: {
    'x-dev-user-id': user, 'x-dev-role': teachers.has(user) ? 'teacher' : 'student', 'idempotency-key': key } });
const post = (user: string, company: string, date: string, lines: object[]) =>
  as(user, 'POST', `/companies/${company}/journal`, { date, description: 'ทดสอบ', lines });
const sale = (amount: string) => [{ account_code: '1110', debit: amount }, { account_code: '4110', credit: amount }];

let school: string, room: string, teacher: string, otherTeacher: string, s1: string, s2: string, co1: string, co2: string;

beforeAll(async () => {
  school = await newSchool();
  teacher = await newUser(school, 'teacher');
  otherTeacher = await newUser(school, 'teacher');
  teachers.add(teacher).add(otherTeacher);
  s1 = await newUser(school, 'student');
  s2 = await newUser(school, 'student');
  room = await newClassroom(school, teacher, [s1, s2]);
  co1 = await newCompany(s1, room);
  co2 = await newCompany(s2, room);
});

describe('ดูรายการและกลับรายการ', () => {
  it('ดูรายการเดียว: บรรทัดพร้อมชื่อบัญชี และลิงก์ไปรายการที่กลับ', async () => {
    const e = (await post(s1, co1, '2026-10-03', [
      { account_code: '1110', debit: '1070', memo: 'รับเงินสด' },
      { account_code: '4110', credit: '1000' }, { account_code: '2210', credit: '70' },
    ])).json();
    const r = await as(s1, 'GET', `/companies/${co1}/journal/${e.id}`);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({
      id: e.id, docNo: e.docNo, date: '2026-10-03', description: 'ทดสอบ', total: '1070.00',
      periodClosed: false, reverses: null, reversedBy: null,
      lines: [
        { lineNo: 1, code: '1110', name: 'เงินสด', debit: '1070.00', credit: '0.00', memo: 'รับเงินสด' },
        { lineNo: 2, code: '4110', name: 'รายได้จากการขาย', debit: '0.00', credit: '1000.00', memo: '' },
        { lineNo: 3, code: '2210', name: 'ภาษีขาย', debit: '0.00', credit: '70.00', memo: '' },
      ],
    });

    const rv = (await as(s1, 'POST', `/companies/${co1}/journal/${e.id}/reverse`, { date: '2026-10-04' })).json();
    expect((await as(s1, 'GET', `/companies/${co1}/journal/${e.id}`)).json().reversedBy).toEqual({ id: rv.id, docNo: rv.docNo });
    const back = (await as(s1, 'GET', `/companies/${co1}/journal/${rv.id}`)).json();
    expect(back.reverses).toEqual({ id: e.id, docNo: e.docNo });
    expect(back.lines.map((l: { debit: string; credit: string }) => [l.debit, l.credit]))
      .toEqual([['0.00', '1070.00'], ['1000.00', '0.00'], ['70.00', '0.00']]);
  });

  it('รายการของคนอื่น หรือ id ที่ไม่มี ได้ 404 เหมือนกัน', async () => {
    const e = (await post(s1, co1, '2026-10-03', sale('10'))).json();
    expect((await as(s2, 'GET', `/companies/${co1}/journal/${e.id}`)).statusCode).toBe(404);
    expect((await as(s2, 'GET', `/companies/${co2}/journal/${e.id}`)).statusCode).toBe(404);
    expect((await as(s1, 'GET', `/companies/${co1}/journal/${randomUUID()}`)).statusCode).toBe(404);
  });

  it('กลับรายการได้ครั้งเดียว และกลับรายการที่เป็นการกลับรายการไม่ได้ ข้อความบอกเลขที่', async () => {
    const e = (await post(s1, co1, '2026-10-05', sale('500'))).json();
    const rv = await as(s1, 'POST', `/companies/${co1}/journal/${e.id}/reverse`, { date: '2026-10-05' });
    expect(rv.statusCode).toBe(201);
    const again = await as(s1, 'POST', `/companies/${co1}/journal/${e.id}/reverse`, { date: '2026-10-05' });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: 'ACC12', message: `รายการ ${e.docNo} ถูกกลับรายการแล้วด้วย ${rv.json().docNo}` });
    const ofRv = await as(s1, 'POST', `/companies/${co1}/journal/${rv.json().id}/reverse`, { date: '2026-10-05' });
    expect(ofRv.json().code).toBe('ACC12');
  });

  it('ส่งคำขอกลับรายการซ้ำด้วย key เดิม (เน็ตหลุด) ได้รายการเดิม ไม่ใช่ error', async () => {
    const e = (await post(s1, co1, '2026-10-06', sale('20'))).json();
    const key = randomUUID();
    const a = await as(s1, 'POST', `/companies/${co1}/journal/${e.id}/reverse`, { date: '2026-10-06' }, key);
    const b = await as(s1, 'POST', `/companies/${co1}/journal/${e.id}/reverse`, { date: '2026-10-06' }, key);
    expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
    expect(b.json().id).toBe(a.json().id);
  });

  it('กดกลับรายการพร้อมกันหลายที่ ได้รายการกลับเพียงรายการเดียว', async () => {
    const e = (await post(s1, co1, '2026-10-07', sale('30'))).json();
    const rs = await Promise.all(Array.from({ length: 6 }, () =>
      as(s1, 'POST', `/companies/${co1}/journal/${e.id}/reverse`, { date: '2026-10-07' })));
    expect(rs.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(rs.filter((r) => r.statusCode !== 201).every((r) => r.json().code === 'ACC12')).toBe(true);
  });
});

describe('ผังบัญชี', () => {
  type Row = { code: string; name: string; type: string; active: boolean; version: number; used: boolean };
  const chart = async (u = s1, co = co1) => (await as(u, 'GET', `/companies/${co}/chart`)).json() as Row[];

  it('ดูผังบัญชีพร้อมสถานะว่ามีรายการแล้ว', async () => {
    const rows = await chart();
    expect(rows.find((r) => r.code === '1110')).toMatchObject({ name: 'เงินสด', type: 'asset', active: true, used: true });
    expect(rows.find((r) => r.code === '5220')).toMatchObject({ used: false });
  });

  it('เพิ่มบัญชีใหม่ ใช้ลงรายการได้ทันที รหัสซ้ำหรือผิดรูปแบบถูกปฏิเสธ', async () => {
    const r = await as(s1, 'POST', `/companies/${co1}/accounts`, { code: '5290', name: '  ค่าโฆษณา ', type: 'expense' });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ code: '5290', name: 'ค่าโฆษณา', normalSide: 'debit', active: true, version: 1, used: false });
    expect((await post(s1, co1, '2026-10-08', [{ account_code: '5290', debit: '300' }, { account_code: '1110', credit: '300' }])).statusCode).toBe(201);
    const dup = await as(s1, 'POST', `/companies/${co1}/accounts`, { code: '5290', name: 'ซ้ำ', type: 'expense' });
    expect([dup.statusCode, dup.json().code, dup.json().message]).toEqual([409, 'duplicate', 'มีรหัสบัญชี 5290 อยู่แล้ว']);
    for (const bad of [{ code: '52A0', name: 'x', type: 'expense' }, { code: '12', name: 'x', type: 'asset' },
      { code: '5291', name: '   ', type: 'expense' }, { code: '5292', name: 'x', type: 'cost' }]) {
      expect((await as(s1, 'POST', `/companies/${co1}/accounts`, bad)).statusCode).toBe(400);
    }
  });

  it('แก้ชื่อต้องส่ง version ล่าสุด ส่ง version เก่าได้ 409', async () => {
    const before = (await chart()).find((r) => r.code === '5230')!;
    const ok = await as(s1, 'PATCH', `/companies/${co1}/accounts/5230`, { name: 'ค่าน้ำประปา', version: before.version });
    expect(ok.json()).toMatchObject({ code: '5230', name: 'ค่าน้ำประปา', version: before.version + 1 });
    const stale = await as(s1, 'PATCH', `/companies/${co1}/accounts/5230`, { name: 'ทับ', version: before.version });
    expect([stale.statusCode, stale.json().code]).toEqual([409, '40001']);
    expect((await as(s1, 'PATCH', `/companies/${co1}/accounts/9999`, { name: 'x', version: 1 })).statusCode).toBe(404);
  });

  it('ปิดใช้ได้เฉพาะบัญชีที่ยังไม่มีรายการ บัญชีที่ปิดใช้หายจากตัวเลือกและลงรายการไม่ได้', async () => {
    const used = (await chart()).find((r) => r.code === '1110')!;
    const no = await as(s1, 'PATCH', `/companies/${co1}/accounts/1110`, { active: false, version: used.version });
    expect([no.statusCode, no.json().code]).toEqual([409, 'ACC07']);

    const free = (await chart()).find((r) => r.code === '5220')!;
    const off = await as(s1, 'PATCH', `/companies/${co1}/accounts/5220`, { active: false, version: free.version });
    expect(off.json()).toMatchObject({ active: false });
    const picker = (await as(s1, 'GET', `/companies/${co1}/accounts`)).json() as { code: string }[];
    expect(picker.some((a) => a.code === '5220')).toBe(false);
    const p = await post(s1, co1, '2026-10-09', [{ account_code: '5220', debit: '1' }, { account_code: '1110', credit: '1' }]);
    expect(p.json().code).toBe('ACC04');
    const on = await as(s1, 'PATCH', `/companies/${co1}/accounts/5220`, { active: true, version: off.json().version });
    expect(on.json()).toMatchObject({ active: true });
  });

  it('คนอื่นแก้ผังบัญชีไม่ได้ ครูดูได้แต่แก้ไม่ได้', async () => {
    expect((await as(s2, 'POST', `/companies/${co1}/accounts`, { code: '5295', name: 'x', type: 'expense' })).statusCode).toBe(404);
    expect((await chart(teacher)).length).toBeGreaterThan(30);
    const t = await as(teacher, 'POST', `/companies/${co1}/accounts`, { code: '5295', name: 'x', type: 'expense' });
    expect(t.statusCode).toBe(403);
    const v = (await chart()).find((r) => r.code === '5230')!.version;
    expect((await as(teacher, 'PATCH', `/companies/${co1}/accounts/5230`, { name: 'ครูแก้', version: v })).statusCode).toBe(403);
    expect((await chart()).find((r) => r.code === '5230')!.name).toBe('ค่าน้ำประปา');
  });
});

describe('ปิดงวด', () => {
  let co: string;
  type Periods = { canClose: boolean; canReopen: boolean; locked: boolean; periods: { month: string; closed: boolean; entries: number }[] };
  const periods = async (u: string) => (await as(u, 'GET', `/companies/${co}/periods`)).json() as Periods;
  const close = (u: string, m: string) => as(u, 'POST', `/companies/${co}/periods/${m}/close`);
  const reopen = (u: string, m: string) => as(u, 'POST', `/companies/${co}/periods/${m}/reopen`);

  beforeAll(async () => {
    co = await asUser(s1, async (c) => (await c.query('select acc.create_company($1,$2) as id', ['บริษัท ปิดงวด จำกัด', room])).rows[0].id as string);
    for (const d of ['2026-07-10', '2026-08-10', '2026-08-20', '2026-09-10']) {
      expect((await post(s1, co, d, sale('100'))).statusCode).toBe(201);
    }
  });

  it('รายการงวดพร้อมจำนวนรายการ และสิทธิ์ของผู้ดู', async () => {
    const p = await periods(s1);
    expect(p.periods.map((x) => [x.month, x.closed, x.entries])).toEqual([['2026-07', false, 1], ['2026-08', false, 2], ['2026-09', false, 1]]);
    expect([p.canClose, p.canReopen]).toEqual([true, false]);
    expect([(await periods(teacher)).canClose, (await periods(teacher)).canReopen]).toEqual([false, true]);
    expect((await as(otherTeacher, 'GET', `/companies/${co}/periods`)).statusCode).toBe(404);
  });

  it('ปิดงวดเรียงจากเดือนเก่า ปิดข้ามเดือนไม่ได้ เดือนที่ไม่มีรายการไม่ต้องปิด', async () => {
    const skip = await close(s1, '2026-08');
    expect([skip.statusCode, skip.json().code, skip.json().message]).toEqual([422, 'ACC13', 'ต้องปิดงวด 2026-07 ก่อน ปิดงวดเรียงจากเดือนเก่าไปใหม่']);
    expect((await close(s1, '2026-07')).statusCode).toBe(200);
    expect((await close(s1, '2026-07')).statusCode).toBe(200); // ปิดซ้ำไม่เป็นไร
    expect((await close(s1, '2026-08')).statusCode).toBe(200);
    const empty = await close(s1, '2026-11');
    expect([empty.statusCode, empty.json().code]).toEqual([422, 'ACC04']);
    expect((await post(s1, co, '2026-08-31', sale('1'))).json().code).toBe('ACC02');
    expect((await post(s1, co, '2026-09-30', sale('1'))).statusCode).toBe(201);
  });

  it('นักเรียนและครูห้องอื่นเปิดงวดคืนไม่ได้ ครูประจำห้องเปิดคืนได้ทีละเดือนจากล่าสุด', async () => {
    expect((await reopen(s1, '2026-08')).statusCode).toBe(403);
    expect((await reopen(otherTeacher, '2026-08')).statusCode).toBe(403);
    expect((await close(teacher, '2026-09')).statusCode).toBe(403);
    const order = await reopen(teacher, '2026-07');
    expect([order.statusCode, order.json().code]).toEqual([422, 'ACC13']);
    expect((await reopen(teacher, '2026-08')).statusCode).toBe(200);
    expect((await periods(s1)).periods.map((x) => x.closed)).toEqual([true, false, false]);
    expect((await post(s1, co, '2026-08-31', sale('1'))).statusCode).toBe(201);
  });

  it('เดือนผิดรูปแบบได้ 400', async () => {
    expect((await close(s1, '2026-13')).statusCode).toBe(400);
    expect((await close(s1, '202608')).statusCode).toBe(400);
  });
});
