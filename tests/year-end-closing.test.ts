import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../apps/api/src/app';
import { devAuth } from '../apps/api/src/auth';
import { authConfigFromEnv } from '../apps/api/src/config';
import { createPool } from '../apps/api/src/db';
import { apiUrl } from './global-setup';
import { pool as db, asUser, newSchool, newUser, newClassroom, newCompany, sqlstate } from './helpers';

// ปิดบัญชีสิ้นปี + รอบปีบัญชี (docs/phase5-spec.md ข้อ 1)
// เฉลยคิดด้วยมือล่วงหน้า เทียบรายบัญชีรายบรรทัด
const apiPool = createPool(apiUrl());
const app = buildApp({ pool: apiPool, auth: devAuth(), cfg: { ...authConfigFromEnv({}), allowedOrigins: false } });
afterAll(async () => { await app.close(); await apiPool.end(); await db.end(); });

type Method = 'GET' | 'POST' | 'PUT';
let owner: string, teacher: string, other: string;
const call = (who: string, role: string, method: Method, url: string, payload?: unknown, key = randomUUID()) =>
  app.inject({ method, url, payload: payload as object, headers: { 'x-dev-user-id': who, 'x-dev-role': role, 'idempotency-key': key } });
async function ok(method: Method, url: string, payload?: unknown, key?: string) {
  const r = await call(owner, 'student', method, url, payload, key);
  if (r.statusCode >= 300) throw new Error(`${method} ${url} → ${r.statusCode} ${r.body}`);
  return r.json();
}
const jv = (co: string, date: string, dr: string, cr: string, amount: string, adjusting = false) =>
  ok('POST', `/companies/${co}/journal`, { date, description: 'ทดสอบ', adjusting, lines: [
    { account_code: dr, debit: amount }, { account_code: cr, credit: amount }] });

type Row = { code: string; debit: string; credit: string };
/** งบทดลอง → { รหัส: [เดบิต, เครดิต] } */
async function tb(co: string, month: string, stage = 'before') {
  const t = await ok('GET', `/companies/${co}/trial-balance?month=${month}&stage=${stage}`);
  expect(t.totalDebit).toBe(t.totalCredit);
  return { t, rows: Object.fromEntries((t.rows as Row[]).map((r) => [r.code, [r.debit, r.credit]])) };
}
async function entryLines(co: string, docNo: string) {
  const r = await db.query(
    `select a.code, l.debit::text d, l.credit::text c from acc.journal_lines l
       join acc.journal_entries e on e.company_id = l.company_id and e.id = l.entry_id
       join acc.chart_of_accounts a on a.company_id = l.company_id and a.id = l.account_id
      where e.company_id = $1 and e.doc_no = $2 order by l.line_no`, [co, docNo]);
  return r.rows.map((x) => [x.code, x.d, x.c]);
}

let co: string;
beforeAll(async () => {
  const school = await newSchool();
  teacher = await newUser(school, 'teacher');
  owner = await newUser(school, 'student');
  other = await newUser(school, 'student');
  const room = await newClassroom(school, teacher, [owner, other]);
  co = await newCompany(owner, room);
  // ปี 2568 (2025) ปีปฏิทิน
  await jv(co, '2025-01-02', '1110', '3110', '100000');
  await jv(co, '2025-03-10', '1110', '4120', '30000');
  await jv(co, '2025-06-15', '5220', '1110', '12000');
  await jv(co, '2025-09-01', '1210', '4110', '8500');
  await jv(co, '2025-11-30', '1120', '4310', '145.25');
  await jv(co, '2025-12-20', '3310', '1110', '2000');
  await jv(co, '2025-12-31', '5250', '1631', '1250', true);
  await jv(co, '2025-12-31', '5230', '2310', '730.55', true);
  // ปีใหม่ลงก่อนปิดบัญชีปีเก่า
  await jv(co, '2026-01-05', '1110', '4120', '5000');
});

describe('ปิดบัญชีสิ้นปี (ปีปฏิทิน กำไร)', () => {
  it('ก่อนปิด: ปีใหม่เตือนว่าปีก่อนยังไม่ปิด งบการเงินแยกกำไรปีนี้กับปีก่อน', async () => {
    const { t, rows } = await tb(co, '2026-01');
    expect(t.priorYearUnclosed).toBe(true);
    expect(rows['4120']).toEqual(['0.00', '35000.00']); // ยังไม่ปิด = รวมปีก่อน
    const st = await ok('GET', `/companies/${co}/statements?month=2026-01&scope=ytd`);
    expect([st.from, st.totalRevenue, st.netIncome, st.yearProfit, st.priorUnclosedProfit, st.balanced])
      .toEqual(['2026-01', '5000.00', '5000.00', '5000.00', '24664.70', true]);
  });

  it('ปิดปีใหม่ก่อนปีเก่าไม่ได้', async () => {
    const r = await call(owner, 'student', 'POST', `/companies/${co}/fiscal-years/2026-12-31/close`);
    expect(r.statusCode).toBe(422);
    expect(r.json().message).toContain('ต้องปิดบัญชีปีบัญชี 01/01/2568 – 31/12/2568 ก่อน');
    const bad = await call(owner, 'student', 'POST', `/companies/${co}/fiscal-years/2025-06-30/close`);
    expect(bad.statusCode).toBe(400);
  });

  it('ตัวอย่างรายการปิดบัญชี = เฉลย: รายได้ 38,645.25 ค่าใช้จ่าย 13,980.55 กำไร 24,664.70', async () => {
    const p = await ok('GET', `/companies/${co}/fiscal-years/2025-12-31/preview`);
    expect(p.lines.map((l: Row) => [l.code, l.debit, l.credit])).toEqual([
      ['4110', '8500.00', '0.00'], ['4120', '30000.00', '0.00'], ['4310', '145.25', '0.00'],
      ['5220', '0.00', '12000.00'], ['5230', '0.00', '730.55'], ['5250', '0.00', '1250.00'],
      ['3210', '0.00', '24664.70'],
    ]);
    expect([p.netIncome, p.totalDebit]).toEqual(['24664.70', '38645.25']);
  });

  it('ปิดบัญชี: CL-0001 วันสิ้นปี ตรงเฉลย · กดซ้ำได้ผลเดิม · งวดของปีปิดหมด', async () => {
    const key = randomUUID();
    const c1 = await ok('POST', `/companies/${co}/fiscal-years/2025-12-31/close`, undefined, key);
    expect(c1).toEqual({ yearEnd: '2025-12-31', netIncome: '24664.70', docNo: 'CL-0001' });
    expect(await ok('POST', `/companies/${co}/fiscal-years/2025-12-31/close`, undefined, key)).toEqual(c1);
    expect((await db.query(`select count(*)::int n from acc.journal_entries where company_id = $1 and doc_prefix = 'CL'`, [co])).rows[0].n).toBe(1);
    expect(await entryLines(co, 'CL-0001')).toEqual([
      ['4110', '8500.00', '0.00'], ['4120', '30000.00', '0.00'], ['4310', '145.25', '0.00'],
      ['5220', '0.00', '12000.00'], ['5230', '0.00', '730.55'], ['5250', '0.00', '1250.00'], ['3210', '0.00', '24664.70'],
    ]);
    const e = (await db.query(`select entry_date::text d from acc.journal_entries where company_id = $1 and doc_no = 'CL-0001'`, [co])).rows[0];
    expect(e.d).toBe('2025-12-31');
    const periods = await ok('GET', `/companies/${co}/periods`);
    expect(periods.periods.map((p: { month: string; closed: boolean }) => [p.month, p.closed])).toEqual([
      ['2025-01', true], ['2025-03', true], ['2025-06', true], ['2025-09', true], ['2025-11', true], ['2025-12', true], ['2026-01', false]]);
    const again = await call(owner, 'student', 'POST', `/companies/${co}/fiscal-years/2025-12-31/close`);
    expect([again.statusCode, again.json().code]).toEqual([409, 'ACC21']);
  });

  it('งบทดลองธันวาคม: ก่อนปิดบัญชี vs หลังปิดบัญชี', async () => {
    const before = await tb(co, '2025-12');
    expect(before.rows).toEqual({
      1110: ['116000.00', '0.00'], 1120: ['145.25', '0.00'], 1210: ['8500.00', '0.00'], 1631: ['0.00', '1250.00'],
      2310: ['0.00', '730.55'], 3110: ['0.00', '100000.00'], 3310: ['2000.00', '0.00'],
      4110: ['0.00', '8500.00'], 4120: ['0.00', '30000.00'], 4310: ['0.00', '145.25'],
      5220: ['12000.00', '0.00'], 5230: ['730.55', '0.00'], 5250: ['1250.00', '0.00'],
    });
    expect([before.t.totalDebit, before.t.closingDocNos]).toEqual(['140625.80', ['CL-0001']]);
    const after = await tb(co, '2025-12', 'after');
    expect(after.rows).toEqual({
      1110: ['116000.00', '0.00'], 1120: ['145.25', '0.00'], 1210: ['8500.00', '0.00'], 1631: ['0.00', '1250.00'],
      2310: ['0.00', '730.55'], 3110: ['0.00', '100000.00'], 3210: ['0.00', '24664.70'], 3310: ['2000.00', '0.00'],
    });
    expect(after.t.totalDebit).toBe('126645.25');
  });

  it('ปีใหม่: งบทดลอง กระดาษทำการ งบการเงิน ไม่มีรายได้/ค่าใช้จ่ายปีก่อน', async () => {
    const { t, rows } = await tb(co, '2026-01');
    expect(t.priorYearUnclosed).toBe(false);
    expect(t.fiscalYear).toEqual({ start: '2026-01-01', end: '2026-12-31' });
    expect(rows).toEqual({
      1110: ['121000.00', '0.00'], 1120: ['145.25', '0.00'], 1210: ['8500.00', '0.00'], 1631: ['0.00', '1250.00'],
      2310: ['0.00', '730.55'], 3110: ['0.00', '100000.00'], 3210: ['0.00', '24664.70'], 3310: ['2000.00', '0.00'],
      4120: ['0.00', '5000.00'],
    });
    expect(t.totalDebit).toBe('131645.25');

    const ws = await ok('GET', `/companies/${co}/worksheet?month=2026-01&format=10`);
    expect(ws.priorYearUnclosed).toBe(false);
    expect(ws.rows.filter((r: { is: unknown }) => r.is).map((r: { code: string; is: { credit: string } }) => [r.code, r.is.credit])).toEqual([['4120', '5000.00']]);
    expect(ws.netIncome).toBe('5000.00');

    const st = await ok('GET', `/companies/${co}/statements?month=2026-01&scope=ytd`);
    expect(st.revenue).toEqual([{ code: '4120', name: 'รายได้จากการบริการ', amount: '5000.00' }]);
    expect(st.expense).toEqual([]);
    expect(st.equity.map((l: { code: string; amount: string }) => [l.code, l.amount])).toEqual([['3110', '100000.00'], ['3210', '24664.70'], ['3310', '-2000.00']]);
    expect([st.yearProfit, st.priorUnclosedProfit, st.totalAssets, st.totalLiabilities, st.totalEquity, st.balanced])
      .toEqual(['5000.00', '0.00', '128395.25', '730.55', '127664.70', true]);

    const led = await ok('GET', `/companies/${co}/ledger?month=2026-01&account=4120`);
    expect([led.opening, led.closing]).toEqual(['0.00', '5000.00']);
  });

  it('ปีที่ปิดแล้ว: กระดาษทำการและงบการเงินธันวาคมเป็นยอดก่อนปิดบัญชี', async () => {
    const ws = await ok('GET', `/companies/${co}/worksheet?month=2025-12&format=10`);
    expect(ws.rows.map((r: { code: string }) => r.code)).not.toContain('3210');
    expect(ws.totals.adj).toEqual({ debit: '1980.55', credit: '1980.55' });
    expect(ws.netIncome).toBe('24664.70');
    const st = await ok('GET', `/companies/${co}/statements?month=2025-12&scope=ytd`);
    expect([st.from, st.totalRevenue, st.totalExpense, st.netIncome, st.yearProfit, st.totalAssets, st.totalEquity, st.balanced])
      .toEqual(['2025-01', '38645.25', '13980.55', '24664.70', '24664.70', '123395.25', '122664.70', true]);
    const led = await ok('GET', `/companies/${co}/ledger?month=2025-12&account=3210`);
    expect(led.lines.map((l: { docNo: string; credit: string }) => [l.docNo, l.credit])).toEqual([['CL-0001', '24664.70']]);
  });

  it('ลงรายการในปีที่ปิดแล้วไม่ได้ (รวมเดือนที่ไม่มีงวด) · CL ลง/กลับเองไม่ได้ · เปลี่ยนรอบปีไม่ได้', async () => {
    const r = await call(owner, 'student', 'POST', `/companies/${co}/journal`, { date: '2025-02-10', description: 'ย้อนปี', lines: [
      { account_code: '1110', debit: '1' }, { account_code: '4320', credit: '1' }] });
    expect(r.statusCode).toBe(422);
    expect(r.json().message).toContain('ปิดบัญชีปีบัญชี 01/01/2568 – 31/12/2568 แล้ว');
    await expect(asUser(owner, (c) => c.query(`select acc.post_journal($1,'2026-01-31','ปลอม','[{"account_code":"4120","debit":"1"},{"account_code":"3210","credit":"1"}]'::jsonb,$2,'CL')`, [co, randomUUID()])))
      .rejects.toMatchObject({ code: 'ACC21' });
    const cl = (await db.query(`select id from acc.journal_entries where company_id = $1 and doc_no = 'CL-0001'`, [co])).rows[0].id;
    await expect(asUser(owner, (c) => c.query(`select acc.reverse_journal($1,$2,'2026-01-31',$3)`, [co, cl, randomUUID()])))
      .rejects.toMatchObject({ code: 'ACC21' });
    const viaApi = await call(owner, 'student', 'POST', `/companies/${co}/journal/${cl}/reverse`, { date: '2026-01-31' });
    expect(viaApi.statusCode).toBe(422);
    const fy = await ok('GET', `/companies/${co}/fiscal-years`);
    const ch = await call(owner, 'student', 'PUT', `/companies/${co}/fiscal-year-start`, { month: 4, version: fy.version });
    expect([ch.statusCode, ch.json().code]).toEqual([409, 'ACC21']);
  });

  it('คนอื่นอ่าน/ปิดบัญชีบริษัทนี้ไม่ได้', async () => {
    expect((await call(other, 'student', 'GET', `/companies/${co}/fiscal-years`)).statusCode).toBeGreaterThanOrEqual(403);
    expect((await call(other, 'student', 'POST', `/companies/${co}/fiscal-years/2026-12-31/close`)).statusCode).toBe(403);
    expect((await call(teacher, 'teacher', 'POST', `/companies/${co}/fiscal-years/2026-12-31/close`)).statusCode).toBe(403);
    await expect(asUser(other, (c) => c.query('select count(*)::int n from acc.fiscal_year_closings where company_id = $1', [co])))
      .resolves.toMatchObject({ rows: [{ n: 0 }] });
  });

  it('ครูเปิดงวดสิ้นปีคืน → ลงรายการปรับปรุงเพิ่ม → ปิดใหม่ลง CL เฉพาะส่วนต่าง', async () => {
    const st = await call(owner, 'student', 'POST', `/companies/${co}/periods/2025-12/reopen`);
    expect(st.statusCode).toBe(403);
    const t = await call(teacher, 'teacher', 'POST', `/companies/${co}/periods/2025-12/reopen`);
    expect(t.statusCode).toBe(200);
    await jv(co, '2025-12-31', '5260', '2310', '300', true);
    const c2 = await ok('POST', `/companies/${co}/fiscal-years/2025-12-31/close`);
    expect(c2).toEqual({ yearEnd: '2025-12-31', netIncome: '-300.00', docNo: 'CL-0002' });
    expect(await entryLines(co, 'CL-0002')).toEqual([['5260', '0.00', '300.00'], ['3210', '300.00', '0.00']]);
    const fy = await ok('GET', `/companies/${co}/fiscal-years`);
    expect(fy.canChangeStart).toBe(false);
    expect(fy.years.map((y: { start: string; end: string; closing: { netIncome: string; docNo: string } | null; reopened: unknown[] }) =>
      [y.start, y.end, y.closing?.docNo ?? null, y.closing?.netIncome ?? null, y.reopened.length])).toEqual([
      ['2025-01-01', '2025-12-31', 'CL-0002', '-300.00', 1], ['2026-01-01', '2026-12-31', null, null, 0]]);
    const { rows } = await tb(co, '2026-01');
    expect(rows['3210']).toEqual(['0.00', '24364.70']);
    expect(rows['5260']).toBeUndefined();
    const after = await tb(co, '2025-12', 'after');
    expect(after.t.closingDocNos).toEqual(['CL-0001', 'CL-0002']);
    expect(after.rows['3210']).toEqual(['0.00', '24364.70']);
    const s = await ok('GET', `/companies/${co}/statements?month=2025-12&scope=ytd`);
    expect([s.totalExpense, s.netIncome, s.balanced]).toEqual(['14280.55', '24364.70', true]);
  });
});

describe('รอบปีบัญชี 1 เม.ย. – 31 มี.ค. (ขาดทุน)', () => {
  let c2: string;
  beforeAll(async () => {
    c2 = await asUser(owner, async (c) => (await c.query('select acc.create_company($1) as id', ['บริษัท ข. จำกัด'])).rows[0].id as string);
    const fy = await ok('GET', `/companies/${c2}/fiscal-years`);
    expect([fy.startMonth, fy.canChangeStart]).toEqual([1, true]);
    expect(await ok('PUT', `/companies/${c2}/fiscal-year-start`, { month: 4, version: fy.version })).toMatchObject({ startMonth: 4 });
    await jv(c2, '2026-04-01', '1110', '3110', '50000');
    await jv(c2, '2026-05-10', '5210', '1110', '20000');
    await jv(c2, '2027-02-01', '1110', '4120', '6000');
    await jv(c2, '2027-03-31', '5250', '1631', '500', true);
    await jv(c2, '2027-04-03', '1110', '4120', '1000');
  });

  it('งบการเงิน "ตั้งแต่ต้นปี" เริ่มเดือนเมษายน', async () => {
    const st = await ok('GET', `/companies/${c2}/statements?month=2027-03&scope=ytd`);
    expect([st.from, st.fiscalYear, st.totalRevenue, st.totalExpense, st.netIncome])
      .toEqual(['2026-04', { start: '2026-04-01', end: '2027-03-31' }, '6000.00', '20500.00', '-14500.00']);
    const fy = await ok('GET', `/companies/${c2}/fiscal-years`);
    expect(fy.years.map((y: { start: string; end: string; entries: number }) => [y.start, y.end, y.entries]))
      .toEqual([['2026-04-01', '2027-03-31', 4], ['2027-04-01', '2028-03-31', 1]]);
  });

  it('ปิดบัญชี 31 มี.ค. 2570: ขาดทุน 14,500 เดบิต 3210 · ปีใหม่เริ่ม เม.ย.', async () => {
    const wrong = await call(owner, 'student', 'POST', `/companies/${c2}/fiscal-years/2026-12-31/close`);
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().message).toContain('ไม่ใช่วันสิ้นปีบัญชี (ปีบัญชีนี้สิ้นสุด 31/03/2570)');
    const r = await ok('POST', `/companies/${c2}/fiscal-years/2027-03-31/close`);
    expect(r).toEqual({ yearEnd: '2027-03-31', netIncome: '-14500.00', docNo: 'CL-0001' });
    expect(await entryLines(c2, 'CL-0001')).toEqual([
      ['4120', '6000.00', '0.00'], ['5210', '0.00', '20000.00'], ['5250', '0.00', '500.00'], ['3210', '14500.00', '0.00']]);
    const { rows } = await tb(c2, '2027-04');
    expect(rows).toEqual({
      1110: ['37000.00', '0.00'], 1631: ['0.00', '500.00'], 3110: ['0.00', '50000.00'], 3210: ['14500.00', '0.00'], 4120: ['0.00', '1000.00'],
    });
    const st = await ok('GET', `/companies/${c2}/statements?month=2027-04&scope=ytd`);
    expect([st.from, st.totalRevenue, st.yearProfit, st.priorUnclosedProfit, st.totalAssets, st.totalEquity, st.balanced])
      .toEqual(['2027-04', '1000.00', '1000.00', '0.00', '36500.00', '36500.00', true]);
    expect(st.equity.map((l: { code: string; amount: string }) => [l.code, l.amount])).toEqual([['3110', '50000.00'], ['3210', '-14500.00']]);
  });

  it('ลงย้อนเข้าปีที่ปิดแล้วไม่ได้ แม้เดือนนั้นไม่มีงวด', async () => {
    const r = await call(owner, 'student', 'POST', `/companies/${c2}/journal`, { date: '2026-08-08', description: 'ย้อน', lines: [
      { account_code: '1110', debit: '1' }, { account_code: '4320', credit: '1' }] });
    expect(r.statusCode).toBe(422);
    expect(sqlstate({ code: r.json().code })).toBe('ACC02');
  });
});
