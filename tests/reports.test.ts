import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../apps/api/src/app';
import { devAuth } from '../apps/api/src/auth';
import { authConfigFromEnv } from '../apps/api/src/config';
import { createPool } from '../apps/api/src/db';
import { apiUrl } from './global-setup';
import { pool as db, newSchool, newUser, newClassroom } from './helpers';

const apiPool = createPool(apiUrl());
const app = buildApp({ pool: apiPool, auth: devAuth(), cfg: { ...authConfigFromEnv({}), allowedOrigins: false } });
afterAll(async () => { await app.close(); await apiPool.end(); await db.end(); });

const teachers = new Set<string>();
const as = (user: string, method: 'GET' | 'POST', url: string, payload?: unknown, key = randomUUID()) =>
  app.inject({ method, url, payload, headers: {
    'x-dev-user-id': user, 'x-dev-role': teachers.has(user) ? 'teacher' : 'student', 'idempotency-key': key } });

let teacher: string, other: string, s1: string, s2: string, room: string, co1: string, co2: string;

async function post(user: string, company: string, date: string, lines: object[]) {
  const r = await as(user, 'POST', `/companies/${company}/journal`, { date, description: 'ทดสอบ', lines });
  expect(r.statusCode, r.body).toBe(201);
  return r.json() as { id: string; docNo: string };
}

beforeAll(async () => {
  const school = await newSchool();
  teacher = await newUser(school, 'teacher');
  other = await newUser(school, 'teacher');
  teachers.add(teacher).add(other);
  s1 = await newUser(school, 'student');
  s2 = await newUser(school, 'student');
  room = await newClassroom(school, teacher, [s1, s2]);
});

describe('เปิดบริษัทจำลองทั้งห้อง', () => {
  it('ครูเปิดให้ทุกคนในห้อง ได้ผังบัญชีครบคนละชุด; กดซ้ำไม่สร้างซ้ำ', async () => {
    const r = await as(teacher, 'POST', `/classrooms/${room}/companies`, { name: 'บริษัท ก. จำกัด' });
    expect(r.json()).toEqual({ created: 2, existing: 0 });
    expect((await as(teacher, 'POST', `/classrooms/${room}/companies`, { name: 'บริษัท ก. จำกัด' })).json()).toEqual({ created: 0, existing: 2 });
    co1 = (await as(s1, 'GET', '/me/companies')).json()[0].id;
    co2 = (await as(s2, 'GET', '/me/companies')).json()[0].id;
    expect(co1).not.toBe(co2);
    const n = await db.query('select company_id, count(*)::int n from acc.chart_of_accounts where company_id = any($1) group by 1', [[co1, co2]]);
    expect(n.rows.map((x) => x.n)).toEqual([42, 42]);
    const rooms = (await as(teacher, 'GET', '/teacher/classrooms')).json();
    expect(rooms[0].students.map((x: { companies: number }) => x.companies)).toEqual([1, 1]);
  });

  it('ครูห้องอื่น/นักเรียนเปิดให้ห้องนี้ไม่ได้ และนักเรียนคนหนึ่งไม่เห็นบริษัทของอีกคน', async () => {
    expect((await as(other, 'POST', `/classrooms/${room}/companies`, { name: 'x' })).statusCode).toBe(403);
    expect((await as(s1, 'POST', `/classrooms/${room}/companies`, { name: 'x' })).statusCode).toBe(403);
    expect((await as(s1, 'GET', `/companies/${co2}/trial-balance?month=2026-10`)).statusCode).toBe(404);
  });
});

describe('งบทดลองและแยกประเภท', () => {
  beforeAll(async () => {
    // ก.ย.: ลงทุน 100,000 / ต.ค.: รับค่าบริการ 12,500, จ่ายค่าเช่า 4,800 แล้วกลับรายการค่าเช่า
    await post(s1, co1, '2026-09-01', [{ account_code: '1110', debit: '100000' }, { account_code: '3110', credit: '100000' }]);
    await post(s1, co1, '2026-10-05', [{ account_code: '1110', debit: '12500' }, { account_code: '4120', credit: '12500' }]);
    const rent = await post(s1, co1, '2026-10-12', [{ account_code: '5220', debit: '4800' }, { account_code: '1110', credit: '4800' }]);
    const rv = await as(s1, 'POST', `/companies/${co1}/journal/${rent.id}/reverse`, { date: '2026-10-13' });
    expect(rv.statusCode).toBe(201);
  });

  it('งบทดลองสะสมถึงสิ้นเดือน ยอดสุทธิลงช่องเดียว และดุล', async () => {
    const sep = (await as(s1, 'GET', `/companies/${co1}/trial-balance?month=2026-09`)).json();
    expect(sep.rows.map((r: { code: string; debit: string; credit: string }) => [r.code, r.debit, r.credit])).toEqual([
      ['1110', '100000.00', '0.00'], ['3110', '0.00', '100000.00'],
    ]);
    const oct = (await as(s1, 'GET', `/companies/${co1}/trial-balance?month=2026-10`)).json();
    expect(oct.rows.map((r: { code: string; debit: string; credit: string }) => [r.code, r.debit, r.credit])).toEqual([
      ['1110', '112500.00', '0.00'], ['3110', '0.00', '100000.00'], ['4120', '0.00', '12500.00'],
    ]); // 5220 กลับรายการจนเป็นศูนย์ จึงไม่แสดง
    expect([oct.totalDebit, oct.totalCredit]).toEqual(['112500.00', '112500.00']);
    const all = (await as(s1, 'GET', `/companies/${co1}/trial-balance?month=2026-10&all=1`)).json();
    expect(all.rows).toHaveLength(42);
    const empty = (await as(s1, 'GET', `/companies/${co1}/trial-balance?month=2026-08`)).json();
    expect(empty).toEqual({ month: '2026-08', rows: [], totalDebit: '0.00', totalCredit: '0.00' });
  });

  it('รายการบัญชีที่เคลื่อนไหวในเดือน: ยอดยกมา/เดบิต/เครดิต/ยอดยกไป หันตามด้านปกติ', async () => {
    const r = (await as(s1, 'GET', `/companies/${co1}/ledger-accounts?month=2026-10`)).json();
    expect(r).toEqual([
      { code: '1110', name: 'เงินสด', normalSide: 'debit', opening: '100000.00', debit: '17300.00', credit: '4800.00', closing: '112500.00' },
      { code: '3110', name: 'ทุน', normalSide: 'credit', opening: '100000.00', debit: '0.00', credit: '0.00', closing: '100000.00' },
      { code: '4120', name: 'รายได้จากการบริการ', normalSide: 'credit', opening: '0.00', debit: '0.00', credit: '12500.00', closing: '12500.00' },
      { code: '5220', name: 'ค่าเช่า', normalSide: 'debit', opening: '0.00', debit: '4800.00', credit: '4800.00', closing: '0.00' },
    ]);
  });

  it('แยกประเภทเงินสด ต.ค.: ยอดยกมา, ยอดคงเหลือต่อเนื่อง, ยอดยกไปตรงกับงบทดลอง', async () => {
    const r = (await as(s1, 'GET', `/companies/${co1}/ledger?month=2026-10&account=1110`)).json();
    expect(r.account).toEqual({ code: '1110', name: 'เงินสด', type: 'asset', normalSide: 'debit' });
    expect(r.opening).toBe('100000.00');
    expect(r.lines.map((l: { date: string; docNo: string; debit: string; credit: string; balance: string; reversal: boolean }) =>
      [l.date, l.docNo, l.debit, l.credit, l.balance, l.reversal])).toEqual([
      ['2026-10-05', 'JV-0002', '12500.00', '0.00', '112500.00', false],
      ['2026-10-12', 'JV-0003', '0.00', '4800.00', '107700.00', false],
      ['2026-10-13', 'RV-0001', '4800.00', '0.00', '112500.00', true],
    ]);
    expect([r.totalDebit, r.totalCredit, r.closing]).toEqual(['17300.00', '4800.00', '112500.00']);
  });

  it('บัญชีด้านเครดิต: ยอดเป็นบวกเมื่ออยู่ด้านปกติ; ไม่มีรายการได้ยอดยกมาอย่างเดียว; รหัสไม่มีได้ 404', async () => {
    const rev = (await as(s1, 'GET', `/companies/${co1}/ledger?month=2026-10&account=4120`)).json();
    expect(rev.lines.map((l: { balance: string }) => l.balance)).toEqual(['12500.00']);
    const cap = (await as(s1, 'GET', `/companies/${co1}/ledger?month=2026-10&account=3110`)).json();
    expect([cap.opening, cap.lines, cap.closing]).toEqual(['100000.00', [], '100000.00']);
    expect((await as(s1, 'GET', `/companies/${co1}/ledger?month=2026-10&account=9999`)).statusCode).toBe(404);
    expect((await as(s1, 'GET', `/companies/${co1}/ledger?month=2026-13&account=1110`)).statusCode).toBe(400);
  });

  it('ยอดติดลบ (กลับด้านปกติ) แสดงเป็นค่าลบ', async () => {
    await post(s1, co1, '2026-11-01', [{ account_code: '5220', debit: '200000' }, { account_code: '1110', credit: '200000' }]);
    const cash = (await as(s1, 'GET', `/companies/${co1}/ledger?month=2026-11&account=1110`)).json();
    expect(cash.closing).toBe('-87500.00');
    const tb = (await as(s1, 'GET', `/companies/${co1}/trial-balance?month=2026-11`)).json();
    expect(tb.rows.find((r: { code: string }) => r.code === '1110')).toMatchObject({ debit: '0.00', credit: '87500.00' });
    expect(tb.totalDebit).toBe(tb.totalCredit);
  });

  it('ครูประจำห้องอ่านงบทดลอง/แยกประเภทของนักเรียนได้ ครูห้องอื่นไม่ได้', async () => {
    expect((await as(teacher, 'GET', `/companies/${co1}/trial-balance?month=2026-10`)).statusCode).toBe(200);
    expect((await as(other, 'GET', `/companies/${co1}/ledger?month=2026-10&account=1110`)).statusCode).toBe(404);
  });
});
