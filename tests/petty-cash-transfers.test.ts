import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../apps/api/src/app';
import { devAuth } from '../apps/api/src/auth';
import { authConfigFromEnv } from '../apps/api/src/config';
import { createPool } from '../apps/api/src/db';
import { apiUrl } from './global-setup';
import { pool as db, newSchool, newUser, newClassroom, newCompany } from './helpers';

// เงินสดย่อย + ฝาก/ถอน/โอนระหว่างบัญชี (docs/phase5-spec.md ข้อ 9) เฉลยคิดมือรายบรรทัด
const apiPool = createPool(apiUrl());
const app = buildApp({ pool: apiPool, auth: devAuth(), cfg: { ...authConfigFromEnv({}), allowedOrigins: false } });
afterAll(async () => { await app.close(); await apiPool.end(); await db.end(); });

let owner: string;
let co: string;
const call = (method: 'GET' | 'POST', url: string, payload?: unknown, key: string = randomUUID()) =>
  app.inject({ method, url, payload: payload as object, headers: { 'x-dev-user-id': owner, 'x-dev-role': 'student', 'idempotency-key': key } });
async function ok(method: 'GET' | 'POST', url: string, payload?: unknown, key?: string) {
  const r = await call(method, url, payload, key);
  if (r.statusCode >= 300) throw new Error(`${method} ${url} → ${r.statusCode} ${r.body}`);
  return r.json();
}
const api = (p: string) => `/companies/${co}${p}`;
// ยอดคงเหลือแต่ละบัญชี (เดบิต − เครดิต) ทั้งปี
async function balances(...codes: string[]) {
  const r = await db.query(
    `select code, acc.account_movement($1, code, '2026-01-01', '2026-12-31')::numeric(18,2)::text v from unnest($2::text[]) code`, [co, codes]);
  return Object.fromEntries(r.rows.map((x) => [x.code, x.v]));
}
// บรรทัดสมุดรายวันของเลขที่เอกสาร: [รหัสบัญชี, เดบิต, เครดิต]
async function lines(docNo: string) {
  const r = await db.query(
    `select a.code, l.debit::text, l.credit::text from acc.journal_lines l
       join acc.journal_entries j on j.company_id = l.company_id and j.id = l.entry_id
       join acc.chart_of_accounts a on a.company_id = l.company_id and a.id = l.account_id
      where j.company_id = $1 and j.doc_no = $2 order by l.debit = 0, a.code`, [co, docNo]);
  return r.rows.map((x) => [x.code, x.debit, x.credit]);
}
const entries = async () => (await db.query('select count(*)::int n from acc.journal_entries where company_id = $1', [co])).rows[0].n as number;
const status = async () => {
  const p = await ok('GET', api('/petty-cash'));
  return [p.fund, p.pending, p.onHand];
};

beforeAll(async () => {
  const school = await newSchool();
  const teacher = await newUser(school, 'teacher');
  owner = await newUser(school, 'student');
  co = await newCompany(owner, await newClassroom(school, teacher, [owner]));
  // เปิดกิจการ: เงินสด 50,000
  await ok('POST', api('/journal'), { date: '2026-01-02', description: 'นำเงินมาลงทุน',
    lines: [{ account_code: '1110', debit: '50000' }, { account_code: '3110', credit: '50000' }] });
});

describe('ฝาก/ถอน/โอนเงินระหว่างบัญชี (BT)', () => {
  let feeTransfer: string;

  it('ฝากเงินสด 30,000 เข้ากระแสรายวัน: Dr 1120 / Cr 1110', async () => {
    const t = await ok('POST', api('/cash-transfers'), { date: '2026-01-05', from: '1110', to: '1120', amount: '30000' });
    expect([t.docNo, t.from, t.to, t.amount, t.fee]).toEqual(['BT-0001', '1110', '1120', '30000.00', '0.00']);
    expect(await lines('BT-0001')).toEqual([['1120', '30000.00', '0.00'], ['1110', '0.00', '30000.00']]);
    expect((await db.query(`select description from acc.journal_entries where company_id = $1 and doc_no = 'BT-0001'`, [co])).rows[0].description)
      .toBe('ฝากเงิน เงินฝากธนาคาร - กระแสรายวัน');
  });

  it('โอนกระแสรายวัน → ออมทรัพย์ 10,000 ค่าธรรมเนียม 25: Dr 1130 10,000 · Dr 5260 25 / Cr 1120 10,025', async () => {
    const t = await ok('POST', api('/cash-transfers'), { date: '2026-01-06', from: '1120', to: '1130', amount: '10000', fee: '25' });
    feeTransfer = t.id;
    expect([t.docNo, t.feeAccount]).toEqual(['BT-0002', '5260']);
    expect(await lines('BT-0002')).toEqual([['1130', '10000.00', '0.00'], ['5260', '25.00', '0.00'], ['1120', '0.00', '10025.00']]);
  });

  it('ถอนเงิน 2,000 เข้าเงินสด → 1110 = 50,000 − 30,000 + 2,000 = 22,000 · 1120 = 30,000 − 10,025 − 2,000 = 17,975', async () => {
    await ok('POST', api('/cash-transfers'), { date: '2026-01-07', from: '1120', to: '1110', amount: '2000' });
    expect(await balances('1110', '1120', '1130', '5260')).toEqual({ 1110: '22000.00', 1120: '17975.00', 1130: '10000.00', 5260: '25.00' });
  });

  it('โอนเข้าเงินสดย่อย/บัญชีเดียวกัน/บัญชีที่ไม่ใช่เงินสดไม่ได้', async () => {
    const before = await entries();
    const petty = await call('POST', api('/cash-transfers'), { date: '2026-01-07', from: '1110', to: '1140', amount: '100' });
    expect([petty.statusCode, petty.json().message]).toEqual([422, 'เงินสดย่อยตั้ง/ปรับวงเงินที่หน้าเงินสดย่อย']);
    expect((await call('POST', api('/cash-transfers'), { date: '2026-01-07', from: '1110', to: '1110', amount: '100' })).statusCode).toBe(400);
    expect((await call('POST', api('/cash-transfers'), { date: '2026-01-07', from: '1110', to: '1310', amount: '100' })).json().code).toBe('ACC04');
    expect(await entries()).toBe(before);
  });

  it('ยกเลิก BT-0002 = กลับรายการ · ส่งซ้ำด้วยคีย์เดิมได้ผลเดิม · คีย์ใหม่ยกเลิกซ้ำไม่ได้', async () => {
    const key = randomUUID();
    const v = await ok('POST', api(`/cash-transfers/${feeTransfer}/void`), { date: '2026-01-08', reason: 'โอนผิดบัญชี' }, key);
    expect([v.voided, v.voidReason]).toEqual([true, 'โอนผิดบัญชี']);
    expect(await lines(v.voidDocNo)).toEqual([['1120', '10025.00', '0.00'], ['1130', '0.00', '10000.00'], ['5260', '0.00', '25.00']]);
    const n = await entries();
    expect((await ok('POST', api(`/cash-transfers/${feeTransfer}/void`), { date: '2026-01-08', reason: 'โอนผิดบัญชี' }, key)).voidDocNo).toBe(v.voidDocNo);
    expect(await entries()).toBe(n);
    expect((await call('POST', api(`/cash-transfers/${feeTransfer}/void`), { date: '2026-01-08', reason: 'ซ้ำ' })).json().code).toBe('ACC16');
    expect(await balances('1110', '1120', '1130', '5260')).toEqual({ 1110: '22000.00', 1120: '28000.00', 1130: '0.00', 5260: '0.00' });
    expect((await ok('GET', api('/cash-transfers'))).transfers.map((t: { docNo: string; voided: boolean }) => [t.docNo, t.voided]))
      .toEqual([['BT-0003', false], ['BT-0002', true], ['BT-0001', false]]);
  });
});

describe('เงินสดย่อยระบบวงเงินคงที่ (PC / PCV)', () => {
  const v: string[] = [];
  let reim: string;

  it('ตั้งวงเงิน 5,000 จากเงินสด: Dr 1140 / Cr 1110', async () => {
    const f = await ok('POST', api('/petty-cash/fund'), { date: '2026-02-01', fund: '5000', custodian: 'นางสาวขวัญใจ' });
    expect([f.docNo, f.fund, f.change]).toEqual(['PC-0001', '5000.00', '5000.00']);
    expect(await lines('PC-0001')).toEqual([['1140', '5000.00', '0.00'], ['1110', '0.00', '5000.00']]);
    expect(await status()).toEqual(['5000.00', '0.00', '5000.00']);
  });

  it('จ่ายใบสำคัญ 3 ใบ (350 + 180.50 + 69.50 = 600) ไม่ลงบัญชี · คงเหลือในมือ 4,400', async () => {
    const before = await entries();
    for (const [account, payee, description, amount] of [
      ['5230', 'การประปา', 'ค่าน้ำประปาเดือน ม.ค.', '350'],
      ['5260', 'นายสมชาย', 'ค่าแท็กซี่ส่งเอกสาร', '180.50'],
      ['5260', 'ไปรษณีย์ไทย', 'ค่าส่งไปรษณีย์', '69.50'],
    ]) {
      const r = await ok('POST', api('/petty-cash/vouchers'), { date: '2026-02-03', account, payee, description, amount });
      v.push(r.id);
    }
    expect(await entries()).toBe(before);
    expect(await status()).toEqual(['5000.00', '600.00', '4400.00']);
    const list = (await ok('GET', api('/petty-cash'))).vouchers.map((x: { docNo: string; status: string }) => [x.docNo, x.status]);
    expect(list).toEqual([['PCV-0003', 'pending'], ['PCV-0002', 'pending'], ['PCV-0001', 'pending']]);
  });

  it('จ่ายเกินเงินในมือ (4,500 > 4,400) ไม่ได้ · บัญชีที่ไม่ใช่ค่าใช้จ่ายไม่ได้', async () => {
    const over = await call('POST', api('/petty-cash/vouchers'), { date: '2026-02-04', account: '5260', payee: 'ก', description: 'ข', amount: '4500' });
    expect([over.statusCode, over.json().message]).toEqual([422, 'เงินสดย่อยคงเหลือ 4,400.00 ไม่พอจ่าย 4,500.00 เบิกชดเชยก่อน']);
    expect((await call('POST', api('/petty-cash/vouchers'), { date: '2026-02-04', account: '1310', payee: 'ก', description: 'ข', amount: '1' })).json().code)
      .toBe('ACC04');
  });

  it('ยกเลิก PCV-0003 → ค้างเบิก 530.50 · คงเหลือ 4,469.50', async () => {
    await ok('POST', api(`/petty-cash/vouchers/${v[2]}/cancel`), { reason: 'ใบเสร็จซ้ำ' });
    expect(await status()).toEqual(['5000.00', '530.50', '4469.50']);
  });

  it('เบิกชดเชย PCV-0001, 0002 จากกระแสรายวัน: Dr 5230 350 · Dr 5260 180.50 / Cr 1120 530.50 · วงเงินกลับเต็ม', async () => {
    const r = await ok('POST', api('/petty-cash/reimbursements'), { date: '2026-02-28', cashAccount: '1120', voucherIds: [v[0], v[1]] });
    reim = r.id;
    expect([r.docNo, r.total]).toEqual(['PC-0002', '530.50']);
    expect(await lines('PC-0002')).toEqual([['5230', '350.00', '0.00'], ['5260', '180.50', '0.00'], ['1120', '0.00', '530.50']]);
    expect(await status()).toEqual(['5000.00', '0.00', '5000.00']);
    expect(await balances('1140', '1120', '5230', '5260')).toEqual({ 1140: '5000.00', 1120: '27469.50', 5230: '350.00', 5260: '180.50' });
  });

  it('เบิกซ้ำ/เบิกใบที่ยกเลิก/ยกเลิกใบที่เบิกแล้วไม่ได้', async () => {
    const again = await call('POST', api('/petty-cash/reimbursements'), { date: '2026-02-28', voucherIds: [v[1]] });
    expect([again.statusCode, again.json().message]).toEqual([422, 'PCV-0002 ยกเลิกแล้วหรือเบิกชดเชยไปแล้ว']);
    expect((await call('POST', api('/petty-cash/reimbursements'), { date: '2026-02-28', voucherIds: [v[2]] })).json().code).toBe('ACC15');
    const cancel = await call('POST', api(`/petty-cash/vouchers/${v[0]}/cancel`), { reason: 'ผิด' });
    expect([cancel.statusCode, cancel.json().message]).toEqual([409, 'PCV-0001 เบิกชดเชยแล้ว ยกเลิกการเบิกชดเชยก่อน']);
  });

  it('ลดวงเงินเหลือ 3,000 คืนเงินสด: Dr 1110 2,000 / Cr 1140 2,000 · ตั้งเท่าเดิมไม่ได้', async () => {
    const f = await ok('POST', api('/petty-cash/fund'), { date: '2026-03-01', fund: '3000', cashAccount: '1110', custodian: 'นางสาวขวัญใจ' });
    expect([f.docNo, f.change]).toEqual(['PC-0003', '-2000.00']);
    expect(await lines('PC-0003')).toEqual([['1110', '2000.00', '0.00'], ['1140', '0.00', '2000.00']]);
    expect((await call('POST', api('/petty-cash/fund'), { date: '2026-03-01', fund: '3000', custodian: 'ก' })).json().code).toBe('ACC15');
    expect(await status()).toEqual(['3000.00', '0.00', '3000.00']);
  });

  it('ยกเลิกการเบิกชดเชย → ใบสำคัญกลับมาค้างเบิก · ลดวงเงินต่ำกว่ายอดค้างเบิกไม่ได้', async () => {
    await ok('POST', api(`/petty-cash/reimbursements/${reim}/void`), { date: '2026-03-02', reason: 'เบิกผิดบัญชี' });
    expect(await status()).toEqual(['3000.00', '530.50', '2469.50']);
    expect(await balances('1120', '5230', '5260')).toEqual({ 1120: '28000.00', 5230: '0.00', 5260: '0.00' });
    const low = await call('POST', api('/petty-cash/fund'), { date: '2026-03-03', fund: '500', custodian: 'ก' });
    expect([low.statusCode, low.json().message])
      .toEqual([422, 'มีใบสำคัญจ่ายเงินสดย่อยที่ยังไม่เบิกชดเชย 530.50 ลดวงเงินต่ำกว่านั้นไม่ได้ เบิกชดเชยก่อน']);
    // เบิกใหม่ด้วยเงินสดได้
    await ok('POST', api('/petty-cash/reimbursements'), { date: '2026-03-03', voucherIds: [v[0], v[1]] });
    expect(await balances('1110', '1140')).toEqual({ 1110: '18469.50', 1140: '3000.00' });
  });

  it('ผู้อื่นที่ไม่มีสิทธิ์เห็นข้อมูลไม่ได้ (RLS)', async () => {
    const school = await newSchool();
    const stranger = await newUser(school, 'student');
    const r = await app.inject({ method: 'GET', url: api('/petty-cash'), headers: { 'x-dev-user-id': stranger, 'x-dev-role': 'student' } });
    expect(r.statusCode).toBe(404);
  });
});
