import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { curriculumApp } from './curriculum-helpers';
import { pool as db } from './helpers';

// เฟส 6 โมดูล 5: รายการปรับปรุง ค้างรับ/ค้างจ่าย/รับล่วงหน้า/จ่ายล่วงหน้า + กลับรายการอัตโนมัติ (docs/phase6-spec.md ข้อ 5)
// เฉลยคิดมือทั้ง 6 แบบ · กลับรายการวันที่ 1 เดือนถัดไป ยอดตรงข้าม · กระดาษทำการเดือนถัดไปไม่นับเป็นรายการปรับปรุง
const { ok, as, close, setup } = curriculumApp();
afterAll(close);

let owner: string, other: string, co: string;
const adj: Record<string, { id: string; docNo: string; entryId: string; reversalDocNo: string | null; date: string; reversalDate: string | null }> = {};
type Lines = Record<string, [string, string]>;
async function linesOf(docNo: string): Promise<{ date: string; prefix: string; lines: Lines }> {
  const e = (await db.query('select id, entry_date::text d, doc_prefix p from acc.journal_entries where company_id = $1 and doc_no = $2', [co, docNo])).rows[0];
  const r = await db.query(
    `select a.code, sum(l.debit)::numeric(18,2)::text d, sum(l.credit)::numeric(18,2)::text c
       from acc.journal_lines l join acc.chart_of_accounts a on a.company_id = l.company_id and a.id = l.account_id
      where l.entry_id = $1 group by a.code order by a.code`, [e.id]);
  return { date: e.d, prefix: e.p, lines: Object.fromEntries(r.rows.map((x) => [x.code, [x.d, x.c]])) };
}
const jv = (date: string, dr: string, cr: string, amount: string) =>
  ok(owner, 'POST', `/companies/${co}/journal`, { date, description: 'รับ/จ่ายเงินล่วงหน้า', lines: [{ account_code: dr, debit: amount }, { account_code: cr, credit: amount }] });
const post = (body: object, key?: string) => ok(owner, 'POST', `/companies/${co}/adjustments`, { month: '2026-03', ...body }, key);

beforeAll(async () => {
  ({ owner, other, co } = await setup({ vat: false }));
  await jv('2026-03-01', '1110', '3110', '100000');
  await jv('2026-03-01', '1510', '1110', '12000');  // ค่าเช่าจ่ายล่วงหน้า 12 เดือน บันทึกเป็นสินทรัพย์
  await jv('2026-03-02', '5240', '1110', '6000');   // ค่าอินเทอร์เน็ตจ่ายล่วงหน้า บันทึกเป็นค่าใช้จ่าย
  await jv('2026-03-03', '1110', '2410', '9000');   // รับค่าบริการล่วงหน้า บันทึกเป็นหนี้สิน
  await jv('2026-03-04', '1110', '4120', '6000');   // รับค่าบริการล่วงหน้า บันทึกเป็นรายได้
});

describe('รายการปรับปรุง 6 แบบ: ตรงเฉลยคิดมือ', () => {
  it('ค่าใช้จ่ายค้างจ่าย 800 + กลับรายการ 1 เม.ย.', async () => {
    adj.ae = await post({ kind: 'accrued_expense', plAccount: '5230', amount: '800', autoReverse: true });
    expect(await linesOf(adj.ae.docNo)).toEqual({ date: '2026-03-31', prefix: 'AJ', lines: { 2310: ['0.00', '800.00'], 5230: ['800.00', '0.00'] } });
    expect(await linesOf(adj.ae.reversalDocNo!)).toEqual({ date: '2026-04-01', prefix: 'JV', lines: { 2310: ['800.00', '0.00'], 5230: ['0.00', '800.00'] } });
  });

  it('รายได้ค้างรับ 500 (สร้างบัญชี 1230 ให้) + กลับรายการ', async () => {
    adj.ar = await post({ kind: 'accrued_revenue', plAccount: '4310', amount: '500', autoReverse: true });
    expect((await linesOf(adj.ar.docNo)).lines).toEqual({ 1230: ['500.00', '0.00'], 4310: ['0.00', '500.00'] });
    expect((await linesOf(adj.ar.reversalDocNo!)).lines).toEqual({ 1230: ['0.00', '500.00'], 4310: ['500.00', '0.00'] });
    expect((await db.query(`select name, type from acc.chart_of_accounts where company_id = $1 and code = '1230'`, [co])).rows[0]).toEqual({ name: 'รายได้ค้างรับ', type: 'asset' });
  });

  it('จ่ายล่วงหน้า บันทึกเป็นสินทรัพย์: ส่วนที่ใช้ไป 1,000 Dr 5220 / Cr 1510 · กลับรายการไม่ได้', async () => {
    const bad = await as(owner, 'POST', `/companies/${co}/adjustments`, { month: '2026-03', kind: 'prepaid_expense', method: 'asset', plAccount: '5220', amount: '1000', autoReverse: true });
    expect(bad.statusCode).toBe(400);
    adj.pa = await post({ kind: 'prepaid_expense', method: 'asset', plAccount: '5220', amount: '1000' });
    expect((await linesOf(adj.pa.docNo)).lines).toEqual({ 1510: ['0.00', '1000.00'], 5220: ['1000.00', '0.00'] });
    expect(adj.pa.reversalDocNo).toBeNull();
  });

  it('จ่ายล่วงหน้า บันทึกเป็นค่าใช้จ่าย: ยังไม่ใช้ 4,000 Dr 1510 / Cr 5240 + กลับรายการ', async () => {
    adj.pe = await post({ kind: 'prepaid_expense', method: 'expense', plAccount: '5240', amount: '4000', autoReverse: true });
    expect((await linesOf(adj.pe.docNo)).lines).toEqual({ 1510: ['4000.00', '0.00'], 5240: ['0.00', '4000.00'] });
    expect((await linesOf(adj.pe.reversalDocNo!)).lines).toEqual({ 1510: ['0.00', '4000.00'], 5240: ['4000.00', '0.00'] });
  });

  it('รับล่วงหน้า บันทึกเป็นหนี้สิน: ได้รับแล้ว 3,000 Dr 2410 / Cr 4120', async () => {
    adj.ul = await post({ kind: 'unearned_revenue', method: 'liability', plAccount: '4120', amount: '3000' });
    expect((await linesOf(adj.ul.docNo)).lines).toEqual({ 2410: ['3000.00', '0.00'], 4120: ['0.00', '3000.00'] });
  });

  it('รับล่วงหน้า บันทึกเป็นรายได้: ยังไม่ได้รับ 2,000 Dr 4120 / Cr 2410 + กลับรายการ', async () => {
    adj.ur = await post({ kind: 'unearned_revenue', method: 'revenue', plAccount: '4120', amount: '2000', autoReverse: true });
    expect((await linesOf(adj.ur.docNo)).lines).toEqual({ 2410: ['0.00', '2000.00'], 4120: ['2000.00', '0.00'] });
    expect((await linesOf(adj.ur.reversalDocNo!)).lines).toEqual({ 2410: ['2000.00', '0.00'], 4120: ['0.00', '2000.00'] });
  });
});

describe('ผลต่องบและกระดาษทำการ', () => {
  it('กระดาษทำการ มี.ค.: ช่องปรับปรุง 11,300 ดุล · เม.ย.: กลับรายการอยู่ช่องงบทดลอง ไม่ใช่ปรับปรุง', async () => {
    const mar = (await db.query('select code, unadjusted::text u, adj_debit::text d, adj_credit::text c from acc.worksheet($1, $2)', [co, '2026-03-01'])).rows;
    const sum = (k: 'd' | 'c') => mar.reduce((a, r) => a + Number(r[k]), 0);
    expect([sum('d'), sum('c')]).toEqual([11300, 11300]);
    const apr = (await db.query('select code, unadjusted::text u, adj_debit::text d, adj_credit::text c from acc.worksheet($1, $2)', [co, '2026-04-01'])).rows;
    expect(apr.every((r) => r.d === '0' && r.c === '0')).toBe(true);
    const u = Object.fromEntries(apr.map((r) => [r.code, r.u]));
    // หลังกลับรายการ: ค้างจ่าย/ค้างรับเป็นศูนย์ · 1510 = 12,000 − 1,000 = 11,000 · 2410 = 9,000 − 3,000 = 6,000
    expect([u['2310'], u['1230'], u['1510'], u['2410']]).toEqual(['0.00', '0.00', '11000.00', '-6000.00']);
    // ยอดสะสมตั้งแต่ต้นปี: ค้างจ่าย/ค้างรับกลับหมด · 5240 = 6,000 − 4,000 + 4,000 · 4120 = 6,000 + 3,000 − 2,000 + 2,000
    expect([u['5230'], u['4310'], u['5240'], u['4120']]).toEqual(['0.00', '0.00', '6000.00', '-9000.00']);
  });

  it('งบกำไรขาดทุน มี.ค. รวมรายการปรับปรุงแล้ว', async () => {
    const st = await ok(owner, 'GET', `/companies/${co}/statements?month=2026-03&scope=month`);
    // รายได้ 4120: 6,000 + 3,000 − 2,000 = 7,000 · 4310: 500 · ค่าใช้จ่าย 5230 800 + 5220 1,000 + 5240 6,000 − 4,000 = 3,800
    expect([st.totalRevenue, st.totalExpense, st.netIncome]).toEqual(['7500.00', '3800.00', '3700.00']);
  });
});

describe('กติกา', () => {
  it('คีย์ซ้ำได้ผลเดิม · บัญชีผิดประเภท = 422 · ไม่เลือกวิธี = 400', async () => {
    const key = randomUUID();
    const a = await post({ kind: 'accrued_expense', plAccount: '5230', amount: '1' }, key);
    const b = await post({ kind: 'accrued_expense', plAccount: '5230', amount: '1' }, key);
    expect(b.id).toBe(a.id);
    expect((await as(owner, 'POST', `/companies/${co}/adjustments`, { month: '2026-03', kind: 'accrued_expense', plAccount: '4120', amount: '1' })).statusCode).toBe(422);
    expect((await as(owner, 'POST', `/companies/${co}/adjustments`, { month: '2026-03', kind: 'prepaid_expense', plAccount: '5220', amount: '1' })).statusCode).toBe(400);
    await ok(owner, 'POST', `/companies/${co}/adjustments/${a.id}/void`, { date: '2026-03-31', reason: 'ทดสอบ' });
  });

  it('กลับรายการ/แก้จากสมุดรายวันไม่ได้ ต้องยกเลิกที่หน้ารายการปรับปรุง (ยกเลิก = กลับทั้ง AJ และรายการกลับอัตโนมัติ)', async () => {
    const r = await as(owner, 'POST', `/companies/${co}/journal/${adj.ae.entryId}/reverse`, { date: '2026-04-02' });
    expect(r.statusCode).toBe(422);
    const v = await ok(owner, 'POST', `/companies/${co}/adjustments/${adj.ae.id}/void`, { date: '2026-04-05', reason: 'คิดผิด' });
    expect(v.voided).toBe(true);
    expect(v.voidDocNo).toMatch(/^RV-\d{4}$/);
    const tb = await ok(owner, 'GET', `/companies/${co}/trial-balance?month=2026-04&all=1`);
    const row = (code: string) => tb.rows.find((x: { code: string }) => x.code === code);
    // AJ 800 + กลับอัตโนมัติ −800 + ยกเลิก AJ −800 + ยกเลิกการกลับ +800 = 0 (5230 และ 2310 เป็นศูนย์)
    expect([row('2310').debit, row('2310').credit, row('5230').debit, row('5230').credit]).toEqual(['0.00', '0.00', '0.00', '0.00']);
    expect((await as(owner, 'POST', `/companies/${co}/adjustments/${adj.ae.id}/void`, { date: '2026-04-05', reason: 'ซ้ำ' })).statusCode).toBe(409);
  });

  it('งวดปิดแล้วลงไม่ได้ทั้งชุด · นักเรียนอื่นอ่าน/ลงไม่ได้', async () => {
    await ok(owner, 'POST', `/companies/${co}/periods/2026-03/close`);
    const before = (await db.query('select count(*)::int n from acc.journal_entries where company_id = $1', [co])).rows[0].n;
    expect((await as(owner, 'POST', `/companies/${co}/adjustments`, { month: '2026-03', kind: 'accrued_expense', plAccount: '5230', amount: '5', autoReverse: true })).statusCode).toBe(422);
    expect((await db.query('select count(*)::int n from acc.journal_entries where company_id = $1', [co])).rows[0].n).toBe(before);
    expect([403, 404]).toContain((await as(other, 'GET', `/companies/${co}/adjustments`)).statusCode);
    expect([403, 404]).toContain((await as(other, 'POST', `/companies/${co}/adjustments`, { month: '2026-04', kind: 'accrued_expense', plAccount: '5230', amount: '5' })).statusCode);
  });
});
