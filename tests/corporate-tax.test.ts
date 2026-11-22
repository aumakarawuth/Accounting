import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { curriculumApp } from './curriculum-helpers';
import { pool as db, newSchool, newUser, newClassroom, newCompany, asUser } from './helpers';

// เฟส 7 โมดูล 2: ภาษีเงินได้นิติบุคคล ภ.ง.ด.51 / ภ.ง.ด.50 (docs/phase7-spec.md ข้อ 2) เฉลยคิดมือ
// บริษัท SME ทุนชำระแล้ว 1,000,000 ปี 2569:
//   6 เดือนแรก รายได้ 1,500,000 (ลูกค้าหัก ณ ที่จ่าย 15,000) ค่าใช้จ่าย 900,000 → กำไร 600,000
//   ภ.ง.ด.51 ประมาณการทั้งปี 1,200,000 → (1,200,000 − 300,000) × 15% = 135,000 ÷ 2 = 67,500 · เครดิตภาษีถูกหัก 15,000 · จ่ายเงิน 52,500
//   ทั้งปี รายได้ 3,500,000 ค่าใช้จ่าย 1,500,000 → กำไร 2,000,000 → ภาษี (2,000,000 − 300,000) × 15% = 255,000
//   ภ.ง.ด.50 = 255,000 หักภาษีจ่ายล่วงหน้า 67,500 → ค้างจ่าย 187,500 · กำไรสุทธิ 1,745,000
const { ok, as, close } = curriculumApp();
afterAll(close);

let owner: string, other: string, co: string;
const jv = (date: string, lines: { account_code: string; debit?: string; credit?: string }[], c = co) =>
  ok(owner, 'POST', `/companies/${c}/journal`, { date, description: 'รายการค้า', lines });
async function linesOf(docNo: string) {
  const r = await db.query(
    `select a.code, l.debit::text d, l.credit::text c, e.entry_date::text dt from acc.journal_lines l
       join acc.journal_entries e on e.company_id = l.company_id and e.id = l.entry_id
       join acc.chart_of_accounts a on a.company_id = l.company_id and a.id = l.account_id
      where e.company_id = $1 and e.doc_no = $2 order by a.code`, [co, docNo]);
  return { date: r.rows[0]?.dt, lines: Object.fromEntries(r.rows.map((x) => [x.code, [x.d, x.c]])) };
}
async function companyOf(type: 'company' | 'sole') {
  const c = await newCompany(owner, null);
  const e = await ok(owner, 'GET', `/companies/${c}/entity`);
  if (type === 'company') await ok(owner, 'PUT', `/companies/${c}/entity`, { entity: { type: 'company', parValue: '10' }, version: e.version });
  return c;
}

beforeAll(async () => {
  const school = await newSchool();
  const teacher = await newUser(school, 'teacher');
  owner = await newUser(school, 'student');
  other = await newUser(school, 'student');
  await newClassroom(school, teacher, [owner, other]);
  co = await companyOf('company');
  await jv('2026-01-02', [{ account_code: '1110', debit: '1000000' }, { account_code: '3110', credit: '1000000' }]);
  await jv('2026-03-10', [{ account_code: '1110', debit: '1000000' }, { account_code: '4120', credit: '1000000' }]);
  await jv('2026-04-30', [{ account_code: '5220', debit: '900000' }, { account_code: '1110', credit: '900000' }]);
  await jv('2026-05-20', [{ account_code: '1110', debit: '485000' }, { account_code: '1420', debit: '15000' }, { account_code: '4120', credit: '500000' }]);
});

describe('อัตราภาษี', () => {
  it('SME ขั้นบันไดทุกช่วง และอัตราทั่วไป', async () => {
    const t = async (p: string, sme: boolean) => (await db.query('select acc.cit_tax($1, $2)::text v', [p, sme])).rows[0].v;
    expect(await t('-50000', true)).toBe('0.00');
    expect(await t('300000', true)).toBe('0.00');
    expect(await t('300001', true)).toBe('0.15');
    expect(await t('3000000', true)).toBe('405000.00');
    expect(await t('3500000', true)).toBe('505000.00');
    expect(await t('1000000', false)).toBe('200000.00');
    expect(await t('0', false)).toBe('0.00');
  });
});

describe('ภ.ง.ด.51 → ภ.ง.ด.50 → ชำระ → ปิดบัญชี', () => {
  let f51: { id: string; docNo: string }, f50: { id: string; docNo: string; payable: string };
  it('หน้าภาษี: ตัวเลขตั้งต้นของ ภ.ง.ด.51', async () => {
    const p = await ok(owner, 'GET', `/companies/${co}/income-tax?yearEnd=2026-12-31`);
    expect(p.yearEnd).toBe('2026-12-31');
    expect(p.preview51).toMatchObject({ periodEnd: '2026-06-30', actualProfit: '600000.00', actualRevenue: '1500000.00', profit: '1200000.00',
      revenue: '3000000.00', paidUp: '1000000.00', sme: true, taxFull: '135000.00', tax: '67500.00' });
  });

  it('ภ.ง.ด.51 ก่อนสิ้นเดือนที่ 6 ไม่ได้ · ยื่นพร้อมเครดิตภาษีถูกหัก ณ ที่จ่าย', async () => {
    const early = await as(owner, 'POST', `/companies/${co}/income-tax`, { form: '51', yearEnd: '2026-12-31', date: '2026-06-30', useWht: true, cashAccount: '1110' });
    expect(early.statusCode).toBe(400);
    f51 = await ok(owner, 'POST', `/companies/${co}/income-tax`, { form: '51', yearEnd: '2026-12-31', date: '2026-08-20', useWht: true, cashAccount: '1110' });
    expect(f51).toMatchObject({ tax: '67500.00', creditWht: '15000.00', payable: '52500.00' });
    expect(await linesOf(f51.docNo)).toEqual({ date: '2026-08-20', lines: { 1110: ['0.00', '52500.00'], 1420: ['0.00', '15000.00'], 1440: ['67500.00', '0.00'] } });
    const dup = await as(owner, 'POST', `/companies/${co}/income-tax`, { form: '51', yearEnd: '2026-12-31', date: '2026-08-21', cashAccount: '1110' });
    expect(dup.json()).toMatchObject({ code: 'ACC16' });
  });

  it('ภ.ง.ด.50 สิ้นปี: ภาษีจริง หักภาษีจ่ายล่วงหน้า ค้างจ่ายส่วนที่เหลือ', async () => {
    await jv('2026-09-15', [{ account_code: '1110', debit: '2000000' }, { account_code: '4120', credit: '2000000' }]);
    await jv('2026-10-15', [{ account_code: '5220', debit: '600000' }, { account_code: '1110', credit: '600000' }]);
    f50 = await ok(owner, 'POST', `/companies/${co}/income-tax`, { form: '50', yearEnd: '2026-12-31', useWht: true });
    expect(f50).toMatchObject({ profit: '2000000.00', revenue: '3500000.00', sme: true, tax: '255000.00', creditPrepaid: '67500.00', creditWht: '0.00', payable: '187500.00' });
    expect(await linesOf(f50.docNo)).toEqual({ date: '2026-12-31', lines: { 1440: ['0.00', '67500.00'], 2250: ['0.00', '187500.00'], 5910: ['255000.00', '0.00'] } });
    const st = await ok(owner, 'GET', `/companies/${co}/statements?month=2026-12&scope=ytd`);
    expect(st.multiStep).toMatchObject({ profitBeforeTax: '2000000.00', totalIncomeTax: '255000.00', netIncome: '1745000.00' });
    expect(st.balanced).toBe(true);
    const tb = await ok(owner, 'GET', `/companies/${co}/trial-balance?month=2026-12`);
    expect(tb.rows.find((r: { code: string }) => r.code === '1440')).toBeUndefined(); // 67,500 − 67,500 = 0
  });

  it('ภ.ง.ด.51 ยกเลิกไม่ได้เมื่อ ภ.ง.ด.50 ใช้เครดิต · ชำระ ภ.ง.ด.50 · ยกเลิกตามลำดับ', async () => {
    expect((await as(owner, 'POST', `/companies/${co}/income-tax/${f51.id}/void`, { what: 'filing', date: '2026-12-31', reason: 'ผิด' })).json()).toMatchObject({ code: 'ACC16' });
    const paid = await ok(owner, 'POST', `/companies/${co}/income-tax/${f50.id}/pay`, { date: '2027-05-30', cashAccount: '1110' });
    expect(await linesOf(paid.payDocNo)).toEqual({ date: '2027-05-30', lines: { 1110: ['0.00', '187500.00'], 2250: ['187500.00', '0.00'] } });
    expect((await as(owner, 'POST', `/companies/${co}/income-tax/${f50.id}/void`, { what: 'filing', date: '2027-05-31', reason: 'ผิด' })).json()).toMatchObject({ code: 'ACC16' });
    await ok(owner, 'POST', `/companies/${co}/income-tax/${f50.id}/void`, { what: 'payment', date: '2027-05-31', reason: 'จ่ายผิด' });
    await ok(owner, 'POST', `/companies/${co}/income-tax/${f50.id}/void`, { what: 'filing', date: '2026-12-31', reason: 'คำนวณใหม่' }); // กลับรายการในปีเดียวกัน
    // ยื่นใหม่ได้หลังยกเลิก (ลง AJ วันสิ้นปีอีกครั้ง) แล้วปิดบัญชี
    const again = await ok(owner, 'POST', `/companies/${co}/income-tax`, { form: '50', yearEnd: '2026-12-31' });
    expect(again).toMatchObject({ tax: '255000.00', payable: '187500.00' });
    const cl = await ok(owner, 'POST', `/companies/${co}/fiscal-years/2026-12-31/close`, {});
    expect(cl.netIncome).toBe('1745000.00');
    const r = await db.query(`select l.credit::text c from acc.journal_lines l join acc.journal_entries e on e.company_id = l.company_id and e.id = l.entry_id
      join acc.chart_of_accounts a on a.company_id = l.company_id and a.id = l.account_id where e.company_id = $1 and e.doc_no = $2 and a.code = '5910'`, [co, cl.docNo]);
    expect(r.rows[0].c).toBe('255000.00');
  });
});

describe('กรณีอื่น', () => {
  it('ทุนชำระแล้วเกิน 5 ล้าน = อัตราทั่วไป 20% · ขาดทุน = 0 ไม่มีรายการ', async () => {
    const c = await companyOf('company');
    await jv('2026-01-02', [{ account_code: '1110', debit: '6000000' }, { account_code: '3110', credit: '6000000' }], c);
    await jv('2026-02-01', [{ account_code: '1110', debit: '1000000' }, { account_code: '4120', credit: '1000000' }], c);
    const p = (await ok(owner, 'POST', `/companies/${c}/income-tax/preview`, { form: '50', yearEnd: '2026-12-31' }));
    expect(p).toMatchObject({ sme: false, profit: '1000000.00', tax: '200000.00' });
    const loss = await companyOf('company');
    await jv('2026-01-02', [{ account_code: '1110', debit: '100000' }, { account_code: '3110', credit: '100000' }], loss);
    await jv('2026-02-01', [{ account_code: '5220', debit: '30000' }, { account_code: '1110', credit: '30000' }], loss);
    const f = await ok(owner, 'POST', `/companies/${loss}/income-tax`, { form: '50', yearEnd: '2026-12-31' });
    expect(f).toMatchObject({ tax: '0.00', payable: '0.00', docNo: null });
    // ประมาณการเองได้ (ภ.ง.ด.51)
    const est = await ok(owner, 'POST', `/companies/${c}/income-tax/preview`, { form: '51', yearEnd: '2026-12-31', estimatedProfit: '500000', estimatedRevenue: '2000000' });
    expect(est).toMatchObject({ profit: '500000.00', sme: false, taxFull: '100000.00', tax: '50000.00' });
  });

  it('เจ้าของคนเดียวใช้ไม่ได้ · นักเรียนอื่นอ่านไม่ได้', async () => {
    const s = await companyOf('sole');
    expect((await ok(owner, 'GET', `/companies/${s}/income-tax`)).entityType).toBe('sole');
    expect((await as(owner, 'POST', `/companies/${s}/income-tax`, { form: '50', yearEnd: '2026-12-31' })).statusCode).toBe(400);
    expect((await as(other, 'GET', `/companies/${co}/income-tax`)).statusCode).toBe(404);
    expect(await asUser(other, async (c) => (await c.query('select count(*)::int n from acc.income_tax_filings where company_id = $1', [co])).rows[0].n)).toBe(0);
  });
});
