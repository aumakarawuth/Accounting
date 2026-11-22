import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { curriculumApp } from './curriculum-helpers';
import { pool as db, newSchool, newUser, newClassroom, newCompany } from './helpers';

// เฟส 7 โมดูล 3: เงินเดือนแบบง่าย (docs/phase7-spec.md ข้อ 3) เฉลยคิดมือ เดือน ม.ค. 2570 (เพดาน 17,500)
//   E1 เงินเดือน 20,000 + OT 2,000 → ฐาน 17,500 × 5% = 875 · ภาษี 500
//   E2 12,345 → 617.25 → 617 (เศษต่ำกว่า 50 สตางค์ปัดทิ้ง) · E3 1,500 (ต่ำกว่าฐาน 1,650) → 82.50 → 83 (ปัดขึ้น)
//   E4 30,000 ไม่เป็นผู้ประกันตน → 0 · ภาษี 1,200
//   ค่าจ้างรวม 65,845 · ประกันสังคมลูกจ้าง 1,575 นายจ้าง 1,575 · ภาษี 1,700 · จ่ายสุทธิ 62,570
const { ok, as, close } = curriculumApp();
afterAll(close);

let owner: string, other: string, co: string;
const emp: Record<string, string> = {};
async function linesOf(docNo: string) {
  const r = await db.query(
    `select a.code, l.debit::text d, l.credit::text c, e.entry_date::text dt from acc.journal_lines l
       join acc.journal_entries e on e.company_id = l.company_id and e.id = l.entry_id
       join acc.chart_of_accounts a on a.company_id = l.company_id and a.id = l.account_id
      where e.company_id = $1 and e.doc_no = $2 order by a.code`, [co, docNo]);
  return { date: r.rows[0]?.dt, lines: Object.fromEntries(r.rows.map((x) => [x.code, [x.d, x.c]])) };
}
const LINES = [
  { employee: 'E1', salary: '20000', otherIncome: '2000', wht: '500' },
  { employee: 'E2', salary: '12345' },
  { employee: 'E3', salary: '1500' },
  { employee: 'E4', salary: '30000', wht: '1200' },
];

beforeAll(async () => {
  const school = await newSchool();
  const teacher = await newUser(school, 'teacher');
  owner = await newUser(school, 'student');
  other = await newUser(school, 'student');
  await newClassroom(school, teacher, [owner, other]);
  co = await newCompany(owner, null);
  await ok(owner, 'POST', `/companies/${co}/journal`, { date: '2026-12-01', description: 'ลงทุน', lines: [{ account_code: '1110', debit: '500000' }, { account_code: '3110', credit: '500000' }] });
  for (const [code, name, salary, sso] of [['E1', 'นายหนึ่ง', '20000', true], ['E2', 'นางสาวสอง', '12345', true], ['E3', 'นายสาม', '1500', true], ['e4', 'นายสี่', '30000', false]] as const) {
    emp[code.toUpperCase()] = (await ok(owner, 'POST', `/companies/${co}/employees`, { code, name, salary, sso, position: 'พนักงาน' })).id;
  }
});

describe('เงินสมทบประกันสังคม', () => {
  it('เพดานตามปี ฐานต่ำสุด ปัดเศษตามกฎ สปส.', async () => {
    const s = async (wage: string, month: string) => (await db.query('select acc.sso_contribution($1, $2::date)::text v', [wage, month])).rows[0].v;
    expect(await s('20000', '2025-12-01')).toBe('750.00');   // เพดาน 15,000
    expect(await s('20000', '2026-01-01')).toBe('875.00');   // 17,500
    expect(await s('25000', '2029-01-01')).toBe('1000.00');  // 20,000
    expect(await s('30000', '2032-06-01')).toBe('1150.00');  // 23,000
    expect(await s('12345', '2027-01-01')).toBe('617.00');
    expect(await s('12350', '2027-01-01')).toBe('618.00');
    expect(await s('1000', '2027-01-01')).toBe('83.00');     // ฐานต่ำสุด 1,650 × 5% = 82.50 → 83
    expect(await s('0', '2027-01-01')).toBe('0.00');
  });
});

describe('ลงเงินเดือน → นำส่ง → ยกเลิก', () => {
  let run: { id: string; docNo: string };
  it('ดูการคำนวณรายคน', async () => {
    const p = await ok(owner, 'POST', `/companies/${co}/payroll/preview`, { month: '2027-01', lines: LINES });
    expect(p.map((x: Record<string, unknown>) => [x.employee, x.wage_base, x.sso_employee, x.sso_employer, x.wht, x.net])).toEqual([
      ['E1', 17500, 875, 875, 500, 20625], ['E2', 12345, 617, 617, 0, 11728], ['E3', 1650, 83, 83, 0, 1417], ['E4', 0, 0, 0, 1200, 28800],
    ]);
  });

  it('รายการบัญชีตรงเฉลย · ลงซ้ำเดือนเดียวกันไม่ได้ · ภาษีเกินเงินได้ไม่ได้', async () => {
    const bad = await as(owner, 'POST', `/companies/${co}/payroll`, { month: '2027-01', payDate: '2027-01-31', cashAccount: '1110',
      lines: [{ employee: 'E3', salary: '1500', wht: '1500' }] });
    expect(bad.statusCode).toBe(422);
    run = await ok(owner, 'POST', `/companies/${co}/payroll`, { month: '2027-01', payDate: '2027-01-31', cashAccount: '1120', lines: LINES });
    expect(run).toMatchObject({ wages: '65845.00', ssoEmployee: '1575.00', ssoEmployer: '1575.00', wht: '1700.00', net: '62570.00' });
    expect(await linesOf(run.docNo)).toEqual({ date: '2027-01-31', lines: {
      1120: ['0.00', '62570.00'], 2231: ['0.00', '1700.00'], 2260: ['0.00', '3150.00'], 5210: ['65845.00', '0.00'], 5280: ['1575.00', '0.00'] } });
    expect((await as(owner, 'POST', `/companies/${co}/payroll`, { month: '2027-01', payDate: '2027-01-31', cashAccount: '1110', lines: LINES })).json()).toMatchObject({ code: 'ACC16' });
  });

  it('นำส่ง สปส.1-10 และ ภ.ง.ด.1 · ยกเลิกเงินเดือนไม่ได้เมื่อนำส่งแล้ว', async () => {
    const sso = await ok(owner, 'POST', `/companies/${co}/payroll/remit`, { month: '2027-01', kind: 'sso', date: '2027-02-15', cashAccount: '1110' });
    expect(await linesOf(sso.docNo)).toEqual({ date: '2027-02-15', lines: { 1110: ['0.00', '3150.00'], 2260: ['3150.00', '0.00'] } });
    const pnd = await ok(owner, 'POST', `/companies/${co}/payroll/remit`, { month: '2027-01', kind: 'pnd1', date: '2027-02-07', cashAccount: '1110' });
    expect(await linesOf(pnd.docNo)).toEqual({ date: '2027-02-07', lines: { 1110: ['0.00', '1700.00'], 2231: ['1700.00', '0.00'] } });
    const tb = await ok(owner, 'GET', `/companies/${co}/trial-balance?month=2027-02`);
    expect(tb.rows.filter((r: { code: string }) => ['2231', '2260'].includes(r.code))).toEqual([]);
    expect((await as(owner, 'POST', `/companies/${co}/payroll/run/${run.id}/void`, { date: '2027-02-28', reason: 'ผิด' })).json()).toMatchObject({ code: 'ACC16' });
    // รายการจากหน้าเงินเดือนกลับรายการจากสมุดรายวันไม่ได้
    expect((await as(owner, 'POST', `/companies/${co}/journal/${sso.entryId}/reverse`, { date: '2027-02-28' })).statusCode).toBe(422);
    await ok(owner, 'POST', `/companies/${co}/payroll/remittance/${sso.id}/void`, { date: '2027-02-28', reason: 'นำส่งผิด' });
    await ok(owner, 'POST', `/companies/${co}/payroll/remittance/${pnd.id}/void`, { date: '2027-02-28', reason: 'นำส่งผิด' });
    await ok(owner, 'POST', `/companies/${co}/payroll/run/${run.id}/void`, { date: '2027-02-28', reason: 'คำนวณใหม่' });
  });

  it('รายงาน: เดือนและสรุปทั้งปีรายคน (นับเฉพาะที่ไม่ยกเลิก)', async () => {
    await ok(owner, 'POST', `/companies/${co}/payroll`, { month: '2027-02', payDate: '2027-02-28', cashAccount: '1110', lines: LINES });
    await ok(owner, 'POST', `/companies/${co}/payroll`, { month: '2027-03', payDate: '2027-03-31', cashAccount: '1110', lines: LINES.slice(0, 2) });
    const d = await ok(owner, 'GET', `/companies/${co}/payroll?month=2027-02`);
    expect(d.ceiling).toBe('17500');
    expect(d.lines.map((l: { code: string; net: string }) => [l.code, l.net])).toEqual([['E1', '20625.00'], ['E2', '11728.00'], ['E3', '1417.00'], ['E4', '28800.00']]);
    expect(d.year).toEqual([
      { code: 'E1', name: 'นายหนึ่ง', months: 2, income: '44000.00', sso: '1750.00', wht: '1000.00' },
      { code: 'E2', name: 'นางสาวสอง', months: 2, income: '24690.00', sso: '1234.00', wht: '0.00' },
      { code: 'E3', name: 'นายสาม', months: 1, income: '1500.00', sso: '83.00', wht: '0.00' },
      { code: 'E4', name: 'นายสี่', months: 1, income: '30000.00', sso: '0.00', wht: '1200.00' },
    ]);
    const st = await ok(owner, 'GET', `/companies/${co}/statements?month=2027-03&scope=ytd`);
    expect(st.balanced).toBe(true);
  });

  it('พนักงาน: แก้ข้อมูล/ลาออก · ลาออกแล้วลงเงินเดือนไม่ได้ · รหัสซ้ำไม่ได้', async () => {
    const d = await ok(owner, 'GET', `/companies/${co}/payroll?month=2027-04`);
    const e3 = d.employees.find((e: { code: string }) => e.code === 'E3');
    await ok(owner, 'PUT', `/companies/${co}/employees/${e3.id}`, { code: 'E3', name: 'นายสาม', salary: '1500', active: false, version: e3.version });
    expect((await as(owner, 'POST', `/companies/${co}/payroll/preview`, { month: '2027-04', lines: [{ employee: 'E3', salary: '1500' }] })).statusCode).toBe(400);
    expect((await as(owner, 'POST', `/companies/${co}/employees`, { code: 'E1', name: 'ซ้ำ', salary: '1' })).statusCode).toBe(409);
  });

  it('นักเรียนอื่นอ่าน/เขียนไม่ได้', async () => {
    expect((await as(other, 'GET', `/companies/${co}/payroll`)).statusCode).toBe(404);
    expect((await as(other, 'POST', `/companies/${co}/employees`, { code: 'X', name: 'x', salary: '1' })).statusCode).toBe(404);
  });
});
