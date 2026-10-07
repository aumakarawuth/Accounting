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
const as = (user: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, payload, headers: {
    'x-dev-user-id': user, 'x-dev-role': teachers.has(user) ? 'teacher' : 'student', 'idempotency-key': randomUUID() } });
const post = (user: string, company: string, date: string, lines: object[]) =>
  as(user, 'POST', `/companies/${company}/journal`, { date, description: 'ทดสอบ', lines });
const act = (user: string, company: string, action: string, expected: string, extra: object = {}) =>
  as(user, 'POST', `/companies/${company}/submission`, { action, expected, ...extra });

let teacher: string, other: string, s1: string, s2: string, room: string, practice: string, work: string, work2: string;

beforeAll(async () => {
  const school = await newSchool();
  teacher = await newUser(school, 'teacher');
  other = await newUser(school, 'teacher');
  teachers.add(teacher).add(other);
  s1 = await newUser(school, 'student');
  s2 = await newUser(school, 'student');
  room = await newClassroom(school, teacher, [s1, s2]);
  expect((await as(teacher, 'POST', `/classrooms/${room}/companies`, { name: 'ฝึกหัด', mode: 'practice' })).json()).toEqual({ created: 2, existing: 0 });
  expect((await as(teacher, 'POST', `/classrooms/${room}/companies`, { name: 'โจทย์ 1', mode: 'submit' })).json()).toEqual({ created: 2, existing: 0 });
  const mine = async (u: string) => (await as(u, 'GET', '/me/companies')).json() as { id: string; name: string }[];
  const c1 = await mine(s1);
  practice = c1.find((c) => c.name === 'ฝึกหัด')!.id;
  work = c1.find((c) => c.name === 'โจทย์ 1')!.id;
  work2 = (await mine(s2)).find((c) => c.name === 'โจทย์ 1')!.id;
});

describe('งบการเงิน', () => {
  beforeAll(async () => {
    for (const [date, lines] of [
      ['2026-01-02', [{ account_code: '1110', debit: '200000' }, { account_code: '3110', credit: '200000' }]],
      ['2026-01-10', [{ account_code: '1630', debit: '30000' }, { account_code: '1110', credit: '30000' }]],
      ['2026-09-05', [{ account_code: '1110', debit: '40000' }, { account_code: '4120', credit: '40000' }]],
      ['2026-10-05', [{ account_code: '1210', debit: '21400' }, { account_code: '4110', credit: '20000' }, { account_code: '2210', credit: '1400' }]],
      ['2026-10-10', [{ account_code: '5210', debit: '15000' }, { account_code: '1110', credit: '15000' }]],
      ['2026-10-31', [{ account_code: '5250', debit: '500' }, { account_code: '1631', credit: '500' }]],
      ['2026-10-31', [{ account_code: '3310', debit: '3000' }, { account_code: '1110', credit: '3000' }]],
    ] as const) expect((await post(s1, practice, date, [...lines])).statusCode).toBe(201);
  });

  it('งบกำไรขาดทุนเดือนเดียว และตั้งแต่ต้นปี', async () => {
    const m = (await as(s1, 'GET', `/companies/${practice}/statements?month=2026-10&scope=month`)).json();
    expect(m.revenue).toEqual([{ code: '4110', name: 'รายได้จากการขาย', amount: '20000.00' }]);
    expect(m.expense.map((x: { code: string; amount: string }) => [x.code, x.amount])).toEqual([['5210', '15000.00'], ['5250', '500.00']]);
    expect([m.totalRevenue, m.totalExpense, m.netIncome]).toEqual(['20000.00', '15500.00', '4500.00']);
    const y = (await as(s1, 'GET', `/companies/${practice}/statements?month=2026-10`)).json();
    expect([y.scope, y.from, y.totalRevenue, y.netIncome]).toEqual(['ytd', '2026-01', '60000.00', '44500.00']);
  });

  it('งบแสดงฐานะการเงิน: บัญชีปรับลดติดลบ, กำไรที่ยังไม่ปิดบัญชีอยู่ในทุน, สินทรัพย์ = หนี้สิน + ทุน', async () => {
    const b = (await as(s1, 'GET', `/companies/${practice}/statements?month=2026-10`)).json();
    expect(b.assets.map((x: { code: string; amount: string }) => [x.code, x.amount])).toEqual([
      ['1110', '192000.00'], ['1210', '21400.00'], ['1630', '30000.00'], ['1631', '-500.00'],
    ]);
    expect(b.equity.map((x: { code: string; amount: string }) => [x.code, x.amount])).toEqual([['3110', '200000.00'], ['3310', '-3000.00']]);
    expect([b.totalAssets, b.totalLiabilities, b.unclosedProfit, b.totalEquity, b.totalLiabilitiesEquity, b.balanced])
      .toEqual(['242900.00', '1400.00', '44500.00', '241500.00', '242900.00', true]);
    // ฐานะการเงิน ณ ก.ย. ไม่รวมรายการ ต.ค.
    const sep = (await as(s1, 'GET', `/companies/${practice}/statements?month=2026-09`)).json();
    expect([sep.totalAssets, sep.unclosedProfit, sep.balanced]).toEqual(['240000.00', '40000.00', true]); // เงินสด 210,000 + อุปกรณ์ 30,000
  });
});

describe('โหมดส่งงาน', () => {
  it('บริษัทโหมดฝึกหัดไม่มีการส่งงาน; ส่งตรวจโดยยังไม่มีรายการไม่ได้', async () => {
    const p = await act(s1, practice, 'submit', 'draft');
    expect([p.statusCode, p.json().code]).toEqual([422, 'ACC11']);
    const e = await act(s1, work, 'submit', 'draft');
    expect(e.json().message).toBe('ยังไม่มีรายการในสมุดรายวัน ส่งตรวจไม่ได้');
  });

  it('ส่งตรวจแล้วล็อกทุกเส้นทางที่เขียน (API และเขียนตรงที่ DB) และเก็บ snapshot งบทดลอง', async () => {
    const first = await post(s1, work, '2026-10-01', [{ account_code: '1110', debit: '5000' }, { account_code: '3110', credit: '5000' }]);
    expect((await act(s1, work, 'submit', 'draft')).json()).toEqual({ status: 'submitted' });
    const locked = await post(s1, work, '2026-10-02', [{ account_code: '1110', debit: '1' }, { account_code: '3110', credit: '1' }]);
    expect([locked.statusCode, locked.json().code]).toEqual([409, 'ACC10']);
    expect((await as(s1, 'POST', `/companies/${work}/journal/${first.json().id}/reverse`, { date: '2026-10-02' })).json().code).toBe('ACC10');
    await expect(db.query(`update acc.chart_of_accounts set name='x', version=version+1 where company_id=$1 and code='1110'`, [work]))
      .rejects.toMatchObject({ code: 'ACC10' });
    await expect(db.query(`update acc.periods set closed = true where company_id=$1`, [work])).rejects.toMatchObject({ code: 'ACC10' });
    const snap = await db.query(`select snapshot from acc.submission_events where company_id=$1 and action='submit'`, [work]);
    expect(snap.rows[0].snapshot).toMatchObject({ entries: 1, last_doc_no: 'JV-0001' });
    expect(snap.rows[0].snapshot.trial_balance).toHaveLength(2);
    const co = (await as(s1, 'GET', `/companies/${work}`)).json();
    expect([co.mode, co.status, co.locked]).toEqual(['submit', 'submitted', true]);
  });

  it('สิทธิ์: นักเรียนตรวจ/ให้ผ่านเองไม่ได้, ครูห้องอื่นทำอะไรไม่ได้, สถานะไม่ตรงได้ 409', async () => {
    expect((await act(s1, work, 'pass', 'submitted', { score: '10' })).statusCode).toBe(403);
    expect((await act(other, work, 'review', 'submitted')).statusCode).toBe(422); // อ่านไม่ได้ = ไม่พบ
    expect((await act(s2, work, 'review', 'submitted')).statusCode).toBe(422);
    const stale = await act(teacher, work, 'review', 'draft');
    expect([stale.statusCode, stale.json().code]).toEqual([409, '40001']);
  });

  it('ครูตรวจ → ส่งกลับ (ต้องมีเหตุผล) → นักเรียนแก้แล้วส่งรอบ 2 → ให้ผ่าน (คะแนนในช่วง) → ปิด', async () => {
    expect((await act(teacher, work, 'review', 'submitted')).json()).toEqual({ status: 'reviewing' });
    expect((await act(teacher, work, 'return', 'reviewing', { note: '  ' })).statusCode).toBe(422);
    expect((await act(teacher, work, 'return', 'reviewing', { note: 'ยังไม่ได้บันทึกรายได้' })).json()).toEqual({ status: 'returned' });
    expect((await post(s1, work, '2026-10-03', [{ account_code: '1110', debit: '800' }, { account_code: '4120', credit: '800' }])).statusCode).toBe(201);
    expect((await act(s1, work, 'submit', 'returned')).json()).toEqual({ status: 'submitted' });
    expect((await act(teacher, work, 'pass', 'submitted', { score: '11' })).statusCode).toBe(422);
    expect((await act(teacher, work, 'pass', 'submitted', { score: '9.5' })).json()).toEqual({ status: 'passed' });
    expect((await post(s1, work, '2026-10-04', [{ account_code: '1110', debit: '1' }, { account_code: '4120', credit: '1' }])).statusCode).toBe(409);
    expect((await act(teacher, work, 'close', 'passed')).json()).toEqual({ status: 'closed' });

    const sub = (await as(s1, 'GET', `/companies/${work}/submission`)).json();
    expect([sub.status, sub.round, sub.score, sub.maxScore]).toEqual(['closed', 2, '9.50', '10.00']);
    expect(sub.events.map((e: { action: string; to: string; round: number }) => `${e.action}:${e.to}:${e.round}`)).toEqual([
      'submit:submitted:1', 'review:reviewing:1', 'return:returned:1', 'submit:submitted:2', 'pass:passed:2', 'close:closed:2',
    ]);
    expect(sub.events[2].note).toBe('ยังไม่ได้บันทึกรายได้');
    // นักเรียนไม่เห็นชื่อครู (RLS) แต่รู้ว่าใครทำจาก byOwner
    expect(sub.events.map((e: { byOwner: boolean; actorName: string | null }) => [e.byOwner, e.actorName === null])).toEqual([
      [true, false], [false, true], [false, true], [true, false], [false, true], [false, true]]);
    await expect(db.query(`update acc.submission_events set note='x' where company_id=$1`, [work])).rejects.toMatchObject({ code: 'ACC06' });
  });

  it('รายการงานของครูเรียงงานที่รอตรวจก่อน และการเปิดดูของครูถูกบันทึก (ของนักเรียนเองไม่บันทึก)', async () => {
    expect((await post(s2, work2, '2026-10-01', [{ account_code: '1110', debit: '100' }, { account_code: '3110', credit: '100' }])).statusCode).toBe(201);
    expect((await act(s2, work2, 'submit', 'draft')).statusCode).toBe(200);
    const list = (await as(teacher, 'GET', '/teacher/submissions')).json();
    expect(list.map((x: { companyId: string; status: string }) => [x.companyId, x.status])).toEqual([[work2, 'submitted'], [work, 'closed']]);
    expect((await as(other, 'GET', '/teacher/submissions')).json()).toEqual([]);

    const count = async () => (await db.query(`select count(*)::int n from acc.audit_log where company_id=$1 and op='VIEW'`, [work2])).rows[0].n;
    const before = await count();
    await as(s2, 'GET', `/companies/${work2}/submission`);
    expect(await count()).toBe(before);
    await as(teacher, 'GET', `/companies/${work2}/submission`);
    expect(await count()).toBe(before + 1);
  });
});
