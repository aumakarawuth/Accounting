import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { curriculumApp } from './curriculum-helpers';
import { pool as db, newSchool, newUser, newClassroom, newCompany, asUser } from './helpers';

// เฟส 7 โมดูล 1: ประเภทกิจการ (docs/phase7-spec.md ข้อ 1) เฉลยคิดมือ
// ห้างหุ้นส่วน ก (อัตราส่วน 3 ดอกเบี้ยทุน 10% เงินเดือน 2,000) ข (2, 10%, 1,000) ปี 2569:
//   ทุน ก 100,000 ม.ค. · ทุน ข 60,000 ม.ค. + 12,000 ก.ค. · รายได้ 80,000 ค่าเช่า 20,000 → กำไร 60,000
//   เงินเดือน ก 24,000 ข 12,000 · ดอกเบี้ย ก 100,000×12×10%/12 = 10,000 · ข (60,000×6 + 72,000×6)×10%/12 = 6,600
//   ที่เหลือ 60,000 − 36,000 − 16,600 = 7,400 → ก 4,440 ข 2,960 · รวม ก 38,440 ข 21,560
//   ถอนใช้ ก 5,000 ข 3,000 → CL: กระแสทุน ก 33,440 ข 18,560
const { app, ok, as, close } = curriculumApp();
afterAll(close);

let school: string, teacher: string, owner: string, other: string, room: string;
const asTeacher = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) =>
  app.inject({ method, url, payload, headers: { 'x-dev-user-id': teacher, 'x-dev-role': 'teacher', 'idempotency-key': randomUUID() } });
const jv = (co: string, date: string, lines: { account_code: string; debit?: string; credit?: string }[]) =>
  ok(owner, 'POST', `/companies/${co}/journal`, { date, description: 'รายการค้า', lines });
const coa = async (co: string, from = '3', to = '4') => Object.fromEntries((await db.query(
  `select code, name, active from acc.chart_of_accounts where company_id = $1 and (code >= $2 and code < $3 or code = '2320') order by code`,
  [co, from, to])).rows.map((r) => [r.code, r.active ? r.name : `(ปิด) ${r.name}`]));
async function linesOf(co: string, docNo: string) {
  const r = await db.query(
    `select a.code, l.debit::text d, l.credit::text c from acc.journal_lines l
       join acc.journal_entries e on e.company_id = l.company_id and e.id = l.entry_id
       join acc.chart_of_accounts a on a.company_id = l.company_id and a.id = l.account_id
      where e.company_id = $1 and e.doc_no = $2 order by a.code`, [co, docNo]);
  return Object.fromEntries(r.rows.map((x) => [x.code, [x.d, x.c]]));
}
const PARTNERS = [
  { name: 'นายเอก', ratio: '3', interestRate: '10', salary: '2000' },
  { name: 'นายโท', ratio: '2', interestRate: '10', salary: '1000' },
];

beforeAll(async () => {
  school = await newSchool();
  teacher = await newUser(school, 'teacher');
  owner = await newUser(school, 'student');
  other = await newUser(school, 'student');
  room = await newClassroom(school, teacher, [owner, other]);
});

describe('ประเภทกิจการ', () => {
  it('บริษัทเดิม/สร้างเอง = เจ้าของคนเดียว ผังเหมือนเดิม', async () => {
    const co = await newCompany(owner, room);
    expect((await ok(owner, 'GET', `/companies/${co}`)).entityType).toBe('sole');
    expect(await coa(co)).toEqual({ 3110: 'ทุน', 3210: 'กำไรสะสม', 3310: 'ถอนใช้ส่วนตัว' });
  });

  it('ครูเปิดบริษัทให้ห้อง: ห้างหุ้นส่วน (ผังรายหุ้นส่วน) และบริษัทจำกัด', async () => {
    let r = await asTeacher('POST', `/classrooms/${room}/companies`, { name: 'ห้างหุ้นส่วนสามัญ เอกโท', mode: 'practice', entity: { type: 'partnership', partners: PARTNERS } });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({ created: 2, existing: 0 });
    const pco = (await db.query(`select id from acc.companies where owner_id = $1 and name = 'ห้างหุ้นส่วนสามัญ เอกโท'`, [owner])).rows[0].id;
    expect(await coa(pco)).toEqual({
      3110: 'ทุน – นายเอก', 3120: 'ทุน – นายโท', 3210: 'กระแสทุน – นายเอก', 3220: 'กระแสทุน – นายโท', 3310: 'ถอนใช้ – นายเอก', 3320: 'ถอนใช้ – นายโท',
    });
    const e = await ok(owner, 'GET', `/companies/${pco}/entity`);
    expect(e).toMatchObject({ type: 'partnership', canChangeType: true, partners: [
      { no: 1, name: 'นายเอก', ratio: '3', interestRate: '10', salary: '2000.00' }, { no: 2, name: 'นายโท', ratio: '2', interestRate: '10', salary: '1000.00' }] });

    r = await asTeacher('POST', `/classrooms/${room}/companies`, { name: 'บริษัท ทดลอง จำกัด', mode: 'practice', entity: { type: 'company', parValue: '10', registeredShares: '100000' } });
    expect(r.json()).toEqual({ created: 2, existing: 0 });
    const cco = (await db.query(`select id from acc.companies where owner_id = $1 and name = 'บริษัท ทดลอง จำกัด'`, [owner])).rows[0].id;
    expect(await coa(cco)).toEqual({
      2320: 'เงินปันผลค้างจ่าย', 3110: 'ทุนเรือนหุ้นสามัญ', 3120: 'ส่วนเกินมูลค่าหุ้นสามัญ', 3210: 'กำไรสะสม – ยังไม่ได้จัดสรร',
      3220: 'กำไรสะสม – จัดสรรเป็นทุนสำรองตามกฎหมาย', 3310: '(ปิด) ถอนใช้ส่วนตัว',
    });
    expect(await ok(owner, 'GET', `/companies/${cco}/entity`)).toMatchObject({ type: 'company', parValue: '10.00', registeredShares: '100000' });
    // ข้อมูลไม่ครบ
    r = await asTeacher('POST', `/classrooms/${room}/companies`, { name: 'หจก. คนเดียว', mode: 'practice', entity: { type: 'partnership', partners: [PARTNERS[0]] } });
    expect(r.statusCode).toBe(400);
  });

  it('เปลี่ยนประเภทได้เมื่อยังไม่มีรายการ · มีรายการแล้วเปลี่ยนไม่ได้ · คนอื่นเปลี่ยนไม่ได้', async () => {
    const co = await newCompany(owner, null);
    let e = await ok(owner, 'GET', `/companies/${co}/entity`);
    expect((await as(other, 'PUT', `/companies/${co}/entity`, { entity: { type: 'company' }, version: e.version })).statusCode).toBe(404);
    e = await ok(owner, 'PUT', `/companies/${co}/entity`, { entity: { type: 'company' }, version: e.version });
    expect(e.type).toBe('company');
    await ok(owner, 'PUT', `/companies/${co}/entity`, { entity: { type: 'sole' }, version: e.version });
    expect(await coa(co)).toEqual({ 3110: 'ทุน', 3120: '(ปิด) ส่วนเกินมูลค่าหุ้นสามัญ', 3210: 'กำไรสะสม', 3220: '(ปิด) กำไรสะสม – จัดสรรเป็นทุนสำรองตามกฎหมาย', 3310: 'ถอนใช้ส่วนตัว', 2320: '(ปิด) เงินปันผลค้างจ่าย' });
    await jv(co, '2026-01-02', [{ account_code: '1110', debit: '1000' }, { account_code: '3110', credit: '1000' }]);
    e = await ok(owner, 'GET', `/companies/${co}/entity`);
    expect(e.canChangeType).toBe(false);
    const r = await as(owner, 'PUT', `/companies/${co}/entity`, { entity: { type: 'company' }, version: e.version });
    expect(r.json()).toMatchObject({ code: 'ACC07' });
  });
});

describe('ห้างหุ้นส่วน: แบ่งกำไรตามสัญญา งบส่วนของผู้เป็นหุ้นส่วน ปิดบัญชี', () => {
  let co: string;
  beforeAll(async () => {
    co = await newCompany(owner, null);
    const e = await ok(owner, 'GET', `/companies/${co}/entity`);
    await ok(owner, 'PUT', `/companies/${co}/entity`, { entity: { type: 'partnership', partners: PARTNERS }, version: e.version });
    await jv(co, '2026-01-01', [{ account_code: '1110', debit: '160000' }, { account_code: '3110', credit: '100000' }, { account_code: '3120', credit: '60000' }]);
    await jv(co, '2026-01-15', [{ account_code: '1110', debit: '80000' }, { account_code: '4120', credit: '80000' }]);
    await jv(co, '2026-03-01', [{ account_code: '5220', debit: '20000' }, { account_code: '1110', credit: '20000' }]);
    await jv(co, '2026-06-30', [{ account_code: '3310', debit: '5000' }, { account_code: '1110', credit: '5000' }]);
    await jv(co, '2026-07-01', [{ account_code: '1110', debit: '12000' }, { account_code: '3120', credit: '12000' }]);
    await jv(co, '2026-08-10', [{ account_code: '3320', debit: '3000' }, { account_code: '1110', credit: '3000' }]);
  });

  it('งบการเงินทั้งปี: การแบ่งกำไรตรงเฉลย', async () => {
    const st = await ok(owner, 'GET', `/companies/${co}/statements?month=2026-12&scope=ytd`);
    expect(st.entityType).toBe('partnership');
    expect(st.netIncome).toBe('60000.00');
    expect(st.allocation).toEqual([
      { no: 1, name: 'นายเอก', salary: '24000.00', interest: '10000.00', share: '4440.00', total: '38440.00' },
      { no: 2, name: 'นายโท', salary: '12000.00', interest: '6600.00', share: '2960.00', total: '21560.00' },
    ]);
  });

  it('ขาดทุน: ที่เหลือติดลบแบ่งตามอัตราส่วน', async () => {
    const r = await asUser(owner, async (c) => (await c.query(`select no, salary::text, interest::text, share::text, total::text from acc.partnership_allocation($1, '2026-01-01', '2026-12-01', -10000) order by no`, [co])).rows);
    // ที่เหลือ −10,000 − 52,600 = −62,600 → ก −37,560 ข −25,040
    expect(r).toEqual([
      { no: 1, salary: '24000.00', interest: '10000.00', share: '-37560.00', total: '-3560.00' },
      { no: 2, salary: '12000.00', interest: '6600.00', share: '-25040.00', total: '-6440.00' },
    ]);
  });

  it('งบแสดงการเปลี่ยนแปลงส่วนของผู้เป็นหุ้นส่วน: คอลัมน์รายหุ้นส่วน ตรงงบฐานะ', async () => {
    const e = await ok(owner, 'GET', `/companies/${co}/equity-changes?month=2026-12&scope=ytd`);
    expect(e.columns.map((c: { key: string; partner?: string }) => [c.key, c.partner])).toEqual([['p1', 'นายเอก'], ['p2', 'นายโท']]);
    const row = (k: string) => e.rows.find((r: { key: string }) => r.key === k);
    expect(e.rows.map((r: { key: string }) => r.key)).toEqual(['opening', 'contribution', 'salary', 'interest', 'ratioShare', 'drawings', 'closing']);
    expect(row('contribution').values).toEqual({ p1: '100000.00', p2: '72000.00' });
    expect(row('salary').values).toEqual({ p1: '24000.00', p2: '12000.00' });
    expect(row('interest').values).toEqual({ p1: '10000.00', p2: '6600.00' });
    expect(row('ratioShare').values).toEqual({ p1: '4440.00', p2: '2960.00' });
    expect(row('drawings').values).toEqual({ p1: '-5000.00', p2: '-3000.00' });
    expect(row('closing')).toEqual({ key: 'closing', values: { p1: '133440.00', p2: '90560.00' }, total: '224000.00' });
    expect(e).toMatchObject({ positionEquity: '224000.00', matches: true });
    // เดือนเดียว (ก.ค.): ยอดต้นงวดรวมส่วนแบ่ง ม.ค.–มิ.ย. ตามสัญญา ก็ยังตรงงบฐานะ
    const m = await ok(owner, 'GET', `/companies/${co}/equity-changes?month=2026-07&scope=month`);
    expect(m.matches).toBe(true);
  });

  it('ปิดบัญชีสิ้นปี: ส่วนแบ่งเข้ากระแสทุน ปิดถอนใช้เข้ากระแสทุน', async () => {
    const pv = await ok(owner, 'GET', `/companies/${co}/fiscal-years/2026-12-31/preview`);
    expect(pv.netIncome).toBe('60000.00');
    expect(pv.allocation.map((a: { total: string }) => a.total)).toEqual(['38440.00', '21560.00']);
    const r = await ok(owner, 'POST', `/companies/${co}/fiscal-years/2026-12-31/close`, {});
    expect(r.netIncome).toBe('60000.00');
    expect(await linesOf(co, r.docNo)).toEqual({
      3210: ['0.00', '33440.00'], 3220: ['0.00', '18560.00'], 3310: ['0.00', '5000.00'], 3320: ['0.00', '3000.00'],
      4120: ['80000.00', '0.00'], 5220: ['0.00', '20000.00'],
    });
    // ปีถัดไป: ยอดยกมาต่อหุ้นส่วนเท่าปลายปีก่อน
    const e = await ok(owner, 'GET', `/companies/${co}/equity-changes?month=2027-01&scope=month`);
    expect(e.rows.find((x: { key: string }) => x.key === 'opening').values).toEqual({ p1: '133440.00', p2: '90560.00' });
    expect(e.matches).toBe(true);
  });

  it('แก้สัญญา/เพิ่มหุ้นส่วนได้ ลดไม่ได้ · ชื่อบัญชีเปลี่ยนตาม', async () => {
    let e = await ok(owner, 'GET', `/companies/${co}/entity`);
    e = await ok(owner, 'PATCH', `/companies/${co}/entity`, { version: e.version, partners: [...PARTNERS, { name: 'นางตรี', ratio: '1', interestRate: '0', salary: '0' }] });
    expect(e.partners).toHaveLength(3);
    expect((await coa(co))['3330']).toBe('ถอนใช้ – นางตรี');
    const r = await as(owner, 'PATCH', `/companies/${co}/entity`, { version: e.version, partners: PARTNERS });
    expect(r.statusCode).toBe(400);
  });
});

describe('บริษัทจำกัด: ออกหุ้น ปันผล ทุนสำรองตามกฎหมาย', () => {
  let co: string;
  beforeAll(async () => {
    co = await newCompany(owner, null);
    const e = await ok(owner, 'GET', `/companies/${co}/entity`);
    await ok(owner, 'PUT', `/companies/${co}/entity`, { entity: { type: 'company', parValue: '10', registeredShares: '100000' }, version: e.version });
    // ออกหุ้น 50,000 หุ้น ราคา 12 บาท (มูลค่า 10)
    await jv(co, '2026-01-02', [{ account_code: '1110', debit: '600000' }, { account_code: '3110', credit: '500000' }, { account_code: '3120', credit: '100000' }]);
    await jv(co, '2026-05-01', [{ account_code: '1110', debit: '200000' }, { account_code: '4120', credit: '200000' }]);
    await jv(co, '2026-06-01', [{ account_code: '5220', debit: '80000' }, { account_code: '1110', credit: '80000' }]);
    await ok(owner, 'POST', `/companies/${co}/fiscal-years/2026-12-31/close`, {});
  });

  it('ข้อมูลประกอบ: กำไรสะสม 120,000 · หุ้น 50,000 · ทุนสำรองขั้นต่ำ 5% = 6,000', async () => {
    const d = await ok(owner, 'GET', `/companies/${co}/dividends?date=2027-03-15`);
    expect(d.preview).toMatchObject({ retained: '120000.00', reserve: '0.00', shareCapital: '500000.00', shares: '50000', registeredCapital: '1000000.00', lastYearProfit: '120000.00', minReserve: '6000.00' });
  });

  it('ประกาศจ่ายหุ้นละ 1 บาท + ทุนสำรอง 6,000 → จ่าย · เกินกำไรสะสมไม่ได้ · ยกเลิกตามลำดับ', async () => {
    const over = await as(owner, 'POST', `/companies/${co}/dividends`, { date: '2027-03-15', amount: '200000', reserve: '0' });
    expect(over.statusCode).toBe(422);
    const key = randomUUID();
    const d = await ok(owner, 'POST', `/companies/${co}/dividends`, { date: '2027-03-15', perShare: '1', reserve: '6000' }, key);
    expect((await ok(owner, 'POST', `/companies/${co}/dividends`, { date: '2027-03-15', perShare: '1', reserve: '6000' }, key)).id).toBe(d.id);
    expect(d).toMatchObject({ amount: '50000.00', reserve: '6000.00', shares: '50000' });
    expect(await linesOf(co, d.docNo)).toEqual({ 2320: ['0.00', '50000.00'], 3210: ['56000.00', '0.00'], 3220: ['0.00', '6000.00'] });
    const p = await ok(owner, 'POST', `/companies/${co}/dividends/${d.id}/pay`, { date: '2027-04-10', cashAccount: '1110' });
    expect(await linesOf(co, p.payDocNo)).toEqual({ 1110: ['0.00', '50000.00'], 2320: ['50000.00', '0.00'] });
    // รายการจากหน้าเงินปันผล กลับรายการจากสมุดรายวันไม่ได้
    expect((await as(owner, 'POST', `/companies/${co}/journal/${p.payEntryId}/reverse`, { date: '2027-04-11' })).statusCode).toBe(422);

    const e = await ok(owner, 'GET', `/companies/${co}/equity-changes?month=2027-04&scope=ytd`);
    const row = (k: string) => e.rows.find((r: { key: string }) => r.key === k);
    expect(e.columns.map((c: { key: string }) => c.key)).toEqual(['capital', 'premium', 'reserve', 'retained']);
    expect(row('opening').values).toEqual({ capital: '500000.00', premium: '100000.00', reserve: '0.00', retained: '120000.00' });
    expect(row('reserve').values).toEqual({ capital: '0.00', premium: '0.00', reserve: '6000.00', retained: '-6000.00' });
    expect(row('dividends').values).toEqual({ capital: '0.00', premium: '0.00', reserve: '0.00', retained: '-50000.00' });
    expect(row('closing')).toMatchObject({ values: { capital: '500000.00', premium: '100000.00', reserve: '6000.00', retained: '64000.00' }, total: '670000.00' });
    expect(e).toMatchObject({ positionEquity: '670000.00', matches: true });
    const y = await ok(owner, 'GET', `/companies/${co}/equity-changes?month=2026-12&scope=ytd`);
    expect(y.rows.find((r: { key: string }) => r.key === 'shareIssue').values).toMatchObject({ capital: '500000.00', premium: '100000.00' });
    expect(y.matches).toBe(true);

    const bad = await as(owner, 'POST', `/companies/${co}/dividends/${d.id}/void`, { what: 'declaration', date: '2027-04-30', reason: 'ผิด' });
    expect(bad.json()).toMatchObject({ code: 'ACC16' });
    await ok(owner, 'POST', `/companies/${co}/dividends/${d.id}/void`, { what: 'payment', date: '2027-04-30', reason: 'จ่ายผิดบัญชี' });
    await ok(owner, 'POST', `/companies/${co}/dividends/${d.id}/void`, { what: 'declaration', date: '2027-04-30', reason: 'ยกเลิกมติ' });
    const after = await ok(owner, 'GET', `/companies/${co}/dividends?date=2027-04-30`);
    expect(after.preview).toMatchObject({ retained: '120000.00', reserve: '0.00' });
    expect(after.dividends[0]).toMatchObject({ voided: true, paidOn: null });
  });

  it('นักเรียนอื่นอ่าน/เขียนเงินปันผลไม่ได้', async () => {
    expect((await as(other, 'GET', `/companies/${co}/dividends`)).statusCode).toBe(404);
    expect((await as(other, 'POST', `/companies/${co}/dividends`, { date: '2027-03-15', amount: '10', reserve: '0' })).statusCode).toBeGreaterThanOrEqual(403);
  });

  it('เจ้าของคนเดียวประกาศปันผลไม่ได้', async () => {
    const s = await newCompany(owner, null);
    expect((await as(owner, 'POST', `/companies/${s}/dividends`, { date: '2027-03-15', amount: '10', reserve: '0' })).statusCode).toBe(400);
  });
});

describe('ชุดโจทย์กำหนดประเภทกิจการ', () => {
  it('เฉลยใช้บัญชีของหุ้นส่วนได้ · บริษัทที่เปิดจากงานได้ผังห้างหุ้นส่วน', async () => {
    const set = { title: 'ห้างหุ้นส่วน', companyName: 'หจก. ทดสอบ', description: '', entity: { type: 'partnership', partners: PARTNERS },
      items: [{ date: '2026-10-01', narrative: 'นายโทนำเงินมาลงทุน', points: '1', lines: [{ account_code: '1110', debit: '1000' }, { account_code: '3120', credit: '1000' }] }] };
    const bad = await asTeacher('POST', '/teacher/exercises', { ...set, entity: undefined });
    expect(bad.json()).toMatchObject({ code: 'ACC19' });
    const r = await asTeacher('POST', '/teacher/exercises', set);
    expect(r.statusCode, r.body).toBe(201);
    const id = r.json().id;
    expect((await asTeacher('GET', `/teacher/exercises/${id}`)).json().entity).toMatchObject({ type: 'partnership' });
    const a = await asTeacher('POST', `/teacher/exercises/${id}/assign`, { classroomId: room, mode: 'practice', companyName: 'หจก. ทดสอบ' });
    expect(a.statusCode, a.body).toBe(201);
    const c = (await db.query('select id, entity_type from acc.companies where assignment_id = $1 and owner_id = $2', [a.json().assignmentId, owner])).rows[0];
    expect(c.entity_type).toBe('partnership');
    expect((await coa(c.id))['3220']).toBe('กระแสทุน – นายโท');
  });
});

it('ตั้งผังตามประเภทตอน commit: สร้างบริษัทผ่านฟังก์ชันเดิมพร้อมค่าที่ส่งต่อ', async () => {
  const id = await asUser(owner, async (c) => {
    await c.query(`select set_config('acc.new_company_entity', $1, true)`, [JSON.stringify({ type: 'company' })]);
    return (await c.query(`select acc.create_company('บริษัท ส่งต่อ จำกัด', null) id`)).rows[0].id as string;
  });
  expect((await coa(id))['3110']).toBe('ทุนเรือนหุ้นสามัญ');
});
