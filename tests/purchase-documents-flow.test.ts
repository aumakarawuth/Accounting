import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../apps/api/src/app';
import { devAuth } from '../apps/api/src/auth';
import { authConfigFromEnv } from '../apps/api/src/config';
import { createPool } from '../apps/api/src/db';
import { apiUrl } from './global-setup';
import { pool as db, newSchool, newUser, newClassroom, newCompany, taxId } from './helpers';

// ใบสั่งซื้อ → ใบรับสินค้า → บันทึกซื้อ · ใบเพิ่มหนี้จากผู้ขาย · จ่ายเงินมัดจำ/หักมัดจำ (docs/phase5-spec.md ข้อ 5)
// เฉลยคิดด้วยมือล่วงหน้า (VAT 7%) เทียบทุกบรรทัด
const apiPool = createPool(apiUrl());
const app = buildApp({ pool: apiPool, auth: devAuth(), cfg: { ...authConfigFromEnv({}), allowedOrigins: false } });
afterAll(async () => { await app.close(); await apiPool.end(); await db.end(); });

type Method = 'GET' | 'POST' | 'PATCH';
let owner: string;
let co: string;
const call = (method: Method, url: string, payload?: unknown, key = randomUUID()) =>
  app.inject({ method, url, payload: payload as object, headers: { 'x-dev-user-id': owner, 'x-dev-role': 'student', 'idempotency-key': key } });
async function ok(method: Method, url: string, payload?: unknown, key?: string) {
  const r = await call(method, url, payload, key);
  if (r.statusCode >= 300) throw new Error(`${method} ${url} → ${r.statusCode} ${r.body}`);
  return r.json();
}
async function lines(entryId: string) {
  const r = await db.query(
    `select a.code, sum(l.debit)::numeric(18,2)::text d, sum(l.credit)::numeric(18,2)::text c
       from acc.journal_lines l join acc.chart_of_accounts a on a.company_id = l.company_id and a.id = l.account_id
      where l.entry_id = $1 group by a.code order by a.code`, [entryId]);
  return Object.fromEntries(r.rows.map((x) => [x.code, [x.d, x.c]]));
}
const entry = async (docNo: string) =>
  lines((await db.query(`select id from acc.journal_entries where company_id = $1 and doc_no = $2`, [co, docNo])).rows[0].id);
const doc = async (docNo: string) =>
  (await db.query(`select id from acc.purchase_documents where company_id = $1 and doc_no = $2`, [co, docNo])).rows[0].id as string;
const detail = async (docNo: string) => ok('GET', `/companies/${co}/purchases/documents/${await doc(docNo)}`);
async function vat(month: string) {
  const r = await db.query(`select doc_no, base::numeric(18,2)::text b, vat::numeric(18,2)::text v
                              from acc.vat_report($1, $2::date, 'purchases') order by row_date, doc_no`, [co, `${month}-01`]);
  return r.rows.map((x) => [x.doc_no, x.b, x.v]);
}
const gl = async (code: string, from: string, to: string) =>
  (await db.query(`select acc.account_movement($1, $2, $3::date, $4::date)::numeric(18,2)::text v`, [co, code, from, to])).rows[0].v as string;
const stock = async () => (await db.query(
  `select quantity::numeric(14,3)::text q, value::numeric(18,2)::text v
     from acc.inventory_balance($1, (select id from acc.items where company_id = $1 and code = 'P'))`, [co])).rows[0];
const voidDoc = (docNo: string, id: string) => call('POST', `/companies/${co}/purchases/documents/${id}/void`, { date: '2026-05-31', reason: `ทดสอบยกเลิก ${docNo}` });

beforeAll(async () => {
  const school = await newSchool();
  const teacher = await newUser(school, 'teacher');
  owner = await newUser(school, 'student');
  co = await newCompany(owner, await newClassroom(school, teacher, [owner]));
  const prof = await ok('GET', `/companies/${co}/profile`);
  await ok('PATCH', `/companies/${co}/profile`, { version: prof.version, taxId: taxId(9701), vatRegistered: true });
  await ok('POST', `/companies/${co}/parties`, { code: 'V1', name: 'บริษัท ผู้ขายหนึ่ง จำกัด', isCustomer: false, isVendor: true,
    taxId: taxId(9711), vatRegistered: true, creditDays: 30 });
  await ok('POST', `/companies/${co}/items`, { code: 'P', name: 'ไส้กรองน้ำ', unit: 'ชิ้น', isService: false, trackInventory: true });
  await ok('POST', `/companies/${co}/items`, { code: 'S', name: 'ค่าซ่อมเครื่อง', unit: 'งาน', isService: true, trackInventory: false });
});

describe('ใบสั่งซื้อ → มัดจำ → ใบรับสินค้า → ซื้อเชื่อจากใบรับสินค้า (ราคาต่าง) หักมัดจำ → ซื้อส่วนที่เหลือ → ใบเพิ่มหนี้ → จ่ายชำระ', () => {
  let po: string;

  it('ใบสั่งซื้อ 10 × 500: ฐาน 5,000 ภาษี 350 รวม 5,350 · ไม่ลงบัญชี', async () => {
    const r = await ok('POST', `/companies/${co}/purchase-orders`, { date: '2026-05-01', untilDate: '2026-05-31', partyCode: 'V1',
      lines: [{ itemCode: 'P', qty: '10', unitPrice: '500' }] });
    expect(r.docNo).toBe('PO-0001');
    po = r.id;
    const o = await ok('GET', `/companies/${co}/purchase-orders/${po}`);
    expect([o.gross, o.base, o.vat, o.total, o.status]).toEqual(['5000.00', '5000.00', '350.00', '5350.00', 'open']);
    expect((await db.query('select count(*)::int n from acc.journal_entries where company_id = $1', [co])).rows[0].n).toBe(0);
  });

  it('จ่ายมัดจำ 1,000 + ภาษี 70 ตามใบสั่งซื้อ: ภาษีซื้อขอคืนเดือนที่จ่าย', async () => {
    const r = await ok('POST', `/companies/${co}/purchases/deposit`, { date: '2026-05-02', partyCode: 'V1', vendorDocNo: 'DEP-1',
      amount: '1000', orderId: po });
    expect(r.docNo).toBe('VD-0001');
    expect(await entry('VD-0001')).toEqual({ 1110: ['0.00', '1070.00'], 1410: ['70.00', '0.00'], 1520: ['1000.00', '0.00'] });
    const dup = await call('POST', `/companies/${co}/purchases/deposit`, { date: '2026-05-02', partyCode: 'V1', vendorDocNo: 'dep-1', amount: '5' });
    expect(dup.json().message).toBe('บันทึกใบรับเงินมัดจำเลขที่ dep-1 ของผู้ขายรายนี้ไปแล้ว');
  });

  it('ใบรับสินค้า 6 ชิ้น × 500 (ใบส่งของ): Dr 5110 / Cr 2130 3,000 · รับเข้าคลัง · ไม่เป็นเจ้าหนี้', async () => {
    const r = await ok('POST', `/companies/${co}/purchases/goods-receipt`, { date: '2026-05-05', partyCode: 'V1', vendorDocNo: 'DN-1', orderId: po,
      lines: [{ itemCode: 'P', qty: '6', unitPrice: '500', orderLineNo: 1 }] });
    expect(r.docNo).toBe('GR-0001');
    expect(await entry('GR-0001')).toEqual({ 2130: ['0.00', '3000.00'], 5110: ['3000.00', '0.00'] });
    expect(await entry('IM-0001')).toEqual({ 1310: ['3000.00', '0.00'], 5110: ['0.00', '3000.00'] });
    expect(await stock()).toEqual({ q: '6.000', v: '3000.00' });
    const o = await ok('GET', `/companies/${co}/purchase-orders/${po}`);
    expect([o.status, o.lines[0].received]).toEqual(['partial', '6.000']);
    expect((await ok('GET', `/companies/${co}/payables`)).items ?? []).toEqual([]);
    const open = await ok('GET', `/companies/${co}/goods-receipts/open?party=V1`);
    expect(open.map((x: { docNo: string; remaining: string }) => [x.docNo, x.remaining])).toEqual([['GR-0001', '6.000']]);
    const dup = await call('POST', `/companies/${co}/purchases/goods-receipt`, { date: '2026-05-05', partyCode: 'V1', vendorDocNo: 'DN-1',
      lines: [{ itemCode: 'P', qty: '1', unitPrice: '500' }] });
    expect(dup.json().message).toBe('บันทึกใบส่งของเลขที่ DN-1 ของผู้ขายรายนี้ไปแล้ว');
    const svc = await call('POST', `/companies/${co}/purchases/goods-receipt`, { date: '2026-05-05', partyCode: 'V1', vendorDocNo: 'DN-9',
      lines: [{ itemCode: 'S', qty: '1', unitPrice: '500' }] });
    expect(svc.json().message).toBe('บรรทัดที่ 1: S เป็นบริการ ใบรับสินค้าใช้กับสินค้าเท่านั้น');
  });

  it('ซื้อเชื่อจากใบรับสินค้า ราคาในใบกำกับ 510: ล้าง 2130 ตามใบรับ ส่วนต่าง 60 ค้าง 5110 · ไม่รับเข้าคลังซ้ำ · หักมัดจำทั้งหมด', async () => {
    const [gr, vd] = [await doc('GR-0001'), await doc('VD-0001')];
    const r = await ok('POST', `/companies/${co}/purchases/invoice`, { date: '2026-05-10', partyCode: 'V1', vendorDocNo: 'INV-1',
      lines: [{ itemCode: 'P', qty: '6', unitPrice: '510', receiptId: gr, receiptLineNo: 1 }], deposits: [{ documentId: vd, amount: '1070' }] });
    expect(r.docNo).toBe('PI-0001');
    expect(await entry('PI-0001')).toEqual({ 1410: ['214.20', '0.00'], 2110: ['0.00', '3274.20'], 5110: ['3060.00', '0.00'] });
    expect(await entry('GM-0001')).toEqual({ 2130: ['3000.00', '0.00'], 5110: ['0.00', '3000.00'] });
    expect(await entry('VA-0001')).toEqual({ 1410: ['0.00', '70.00'], 1520: ['0.00', '1000.00'], 2110: ['1070.00', '0.00'] });
    expect(await stock()).toEqual({ q: '6.000', v: '3000.00' });
    expect((await db.query(`select count(*)::int n from acc.journal_entries where company_id = $1 and doc_prefix = 'IM'`, [co])).rows[0].n).toBe(1);
    const d = await detail('PI-0001');
    expect([d.open, d.matches.map((m: { docNo: string; qty: string; amount: string }) => [m.docNo, m.qty, m.amount])])
      .toEqual(['2204.20', [['GR-0001', '6.000', '3000.00']]]);
    expect(await gl('2130', '2026-05-01', '2026-05-31')).toBe('0.00');
    expect(await gl('5110', '2026-05-01', '2026-05-31')).toBe('60.00');
    expect(await gl('1520', '2026-05-01', '2026-05-31')).toBe('0.00');
    expect(await ok('GET', `/companies/${co}/goods-receipts/open?party=V1`)).toEqual([]);
    const over = await call('POST', `/companies/${co}/purchases/invoice`, { date: '2026-05-11', partyCode: 'V1', vendorDocNo: 'INV-1X',
      lines: [{ itemCode: 'P', qty: '1', unitPrice: '500', receiptId: gr, receiptLineNo: 1 }] });
    expect(over.json().message).toBe('บรรทัดที่ 1: เกินจำนวนที่รับใน GR-0001 (รับ 6.000 ได้ใบแจ้งหนี้แล้ว 6.000)');
    const voidGr = await voidDoc('GR-0001', gr);
    expect([voidGr.statusCode, voidGr.json().message]).toEqual([409, 'GR-0001 มีใบซื้อ PI-0001 อ้างอยู่ ยกเลิกใบซื้อก่อน']);
  });

  it('ซื้อเชื่อส่วนที่เหลือ 4 × 500 อ้างใบสั่งซื้อ → รับเข้าคลัง ใบสั่งซื้อปิด · รับเกินที่สั่งไม่ได้', async () => {
    await ok('POST', `/companies/${co}/purchases/invoice`, { date: '2026-05-20', partyCode: 'V1', vendorDocNo: 'INV-2', orderId: po,
      lines: [{ itemCode: 'P', qty: '4', unitPrice: '500', orderLineNo: 1 }] });
    expect(await entry('PI-0002')).toEqual({ 1410: ['140.00', '0.00'], 2110: ['0.00', '2140.00'], 5110: ['2000.00', '0.00'] });
    expect(await entry('IM-0002')).toEqual({ 1310: ['2000.00', '0.00'], 5110: ['0.00', '2000.00'] });
    expect(await stock()).toEqual({ q: '10.000', v: '5000.00' });
    const o = await ok('GET', `/companies/${co}/purchase-orders/${po}`);
    expect([o.status, o.documents.map((x: { docNo: string }) => x.docNo), o.deposits[0].remaining])
      .toEqual(['closed', ['GR-0001', 'PI-0002'], '0.00']);
    const over = await call('POST', `/companies/${co}/purchases/goods-receipt`, { date: '2026-05-21', partyCode: 'V1', vendorDocNo: 'DN-2', orderId: po,
      lines: [{ itemCode: 'P', qty: '1', unitPrice: '500', orderLineNo: 1 }] });
    expect(over.json().message).toBe('บรรทัดที่ 1: รับเกินจำนวนในใบสั่งซื้อ PO-0001 (สั่ง 10.000 รับแล้ว 10.000)');
    const cancel = await call('POST', `/companies/${co}/purchase-orders/${po}/cancel`, { reason: 'ทดสอบ' });
    expect([cancel.statusCode, cancel.json().code]).toEqual([409, 'ACC16']);
  });

  it('ใบเพิ่มหนี้จากผู้ขาย 4 × 25 = 100 + 7: เป็นเจ้าหนี้แยกใบ ไม่เปลี่ยนสต็อก · จ่ายชำระพร้อมใบซื้อ', async () => {
    const pi2 = await doc('PI-0002');
    const r = await ok('POST', `/companies/${co}/purchases/debit-note`, { date: '2026-05-25', refDocumentId: pi2, vendorDocNo: 'DBN-1',
      reason: 'ผู้ขายปรับราคาขึ้น', lines: [{ itemCode: 'P', qty: '4', unitPrice: '25' }] });
    expect(r.docNo).toBe('PD-0001');
    expect(await entry('PD-0001')).toEqual({ 1410: ['7.00', '0.00'], 2110: ['0.00', '107.00'], 5110: ['100.00', '0.00'] });
    expect(await stock()).toEqual({ q: '10.000', v: '5000.00' });
    const ap = await ok('GET', `/companies/${co}/payables?asOf=2026-05-31`);
    expect(JSON.stringify(ap)).toContain('PD-0001');
    const pv = await ok('POST', `/companies/${co}/payments`, { date: '2026-05-28', partyCode: 'V1', cashAccount: '1110',
      allocations: [{ documentId: pi2, amount: '2140' }, { documentId: r.id, amount: '107' }] });
    expect(await entry(pv.docNo)).toEqual({ 1110: ['0.00', '2247.00'], 2110: ['2247.00', '0.00'] });
    expect((await detail('PD-0001')).open).toBe('0.00');
    const blocked = await voidDoc('PI-0002', pi2);
    expect(blocked.statusCode).toBe(409);
  });

  it('รายงานภาษีซื้อ พ.ค.: มัดจำบวก หักมัดจำลบ = ยอด 1410', async () => {
    expect(await vat('2026-05')).toEqual([
      ['VD-0001', '1000.00', '70.00'], ['PI-0001', '3060.00', '214.20'], ['VA-0001', '-1000.00', '-70.00'],
      ['PI-0002', '2000.00', '140.00'], ['PD-0001', '100.00', '7.00']]);
    expect(await gl('1410', '2026-05-01', '2026-05-31')).toBe('361.20');
  });

  it('ยกเลิกตามกติกา: มัดจำ/ใบซื้อที่มีการหักอ้างยกเลิกไม่ได้ · ยกเลิกใบหักมัดจำ → ใบซื้อ → ใบรับสินค้า (กลับ GM และสต็อก)', async () => {
    const [vd, pi1, va, gr] = [await doc('VD-0001'), await doc('PI-0001'), await doc('VA-0001'), await doc('GR-0001')];
    for (const [no, id] of [['VD-0001', vd], ['PI-0001', pi1]] as const) {
      const r = await voidDoc(no, id);
      expect([r.statusCode, r.json().code]).toEqual([409, 'ACC16']);
    }
    expect((await voidDoc('VA-0001', va)).statusCode).toBe(200);
    expect((await ok('GET', `/companies/${co}/purchase-deposits?party=V1`))[0].remaining).toBe('1070.00');
    expect((await voidDoc('PI-0001', pi1)).statusCode).toBe(200);
    expect(await gl('2130', '2026-05-01', '2026-05-31')).toBe('-3000.00');
    expect((await ok('GET', `/companies/${co}/goods-receipts/open?party=V1`))[0].remaining).toBe('6.000');
    expect((await voidDoc('GR-0001', gr)).statusCode).toBe(200);
    expect(await gl('2130', '2026-05-01', '2026-05-31')).toBe('0.00');
    expect(await stock()).toEqual({ q: '4.000', v: '2000.00' });
    expect(await gl('5110', '2026-05-01', '2026-05-31')).toBe('100.00');
    expect((await voidDoc('VD-0001', vd)).statusCode).toBe(200);
    expect(await gl('1520', '2026-05-01', '2026-05-31')).toBe('0.00');
    expect(await gl('1410', '2026-05-01', '2026-05-31')).toBe('147.00'); // PI-0002 140 + PD-0001 7
  });
});

describe('มัดจำงานบริการ: ภาษีซื้อขอคืนตอนจ่ายมัดจำ ภาษีซื้อยังไม่ถึงกำหนดของใบซื้อลดตามที่หัก', () => {
  it('มัดจำ 2,000 + 140 → ซื้อเชื่อบริการ 5,000 + 350 หักมัดจำ 1,070 → จ่ายส่วนที่เหลือ: 1411 เป็นศูนย์ ภาษีซื้อรวม 140 + 280', async () => {
    const vd = await ok('POST', `/companies/${co}/purchases/deposit`, { date: '2026-06-01', partyCode: 'V1', vendorDocNo: 'DEP-2',
      amount: '2000', isService: true });
    expect(await entry(vd.docNo)).toEqual({ 1110: ['0.00', '2140.00'], 1410: ['140.00', '0.00'], 1520: ['2000.00', '0.00'] });
    const pi = await ok('POST', `/companies/${co}/purchases/invoice`, { date: '2026-06-10', partyCode: 'V1', vendorDocNo: 'INV-3',
      lines: [{ itemCode: 'S', qty: '1', unitPrice: '5000' }], deposits: [{ documentId: vd.id, amount: '1070' }] });
    expect(await entry(pi.docNo)).toEqual({ 1411: ['350.00', '0.00'], 2110: ['0.00', '5350.00'], 5260: ['5000.00', '0.00'] });
    expect(await entry('VA-0002')).toEqual({ 1411: ['0.00', '70.00'], 1520: ['0.00', '1000.00'], 2110: ['1070.00', '0.00'] });
    expect((await detail(pi.docNo)).open).toBe('4280.00');
    const pv = await ok('POST', `/companies/${co}/payments`, { date: '2026-06-20', partyCode: 'V1', cashAccount: '1110',
      allocations: [{ documentId: pi.id, amount: '4280' }] });
    expect(await entry(pv.docNo)).toEqual({ 1110: ['0.00', '4280.00'], 1410: ['280.00', '0.00'], 1411: ['0.00', '280.00'], 2110: ['4280.00', '0.00'] });
    expect(await gl('1411', '2026-06-01', '2026-06-30')).toBe('0.00');
    expect(await vat('2026-06')).toEqual([['VD-0002', '2000.00', '140.00'], [pv.docNo, '4000.00', '280.00']]);
    expect(await gl('1410', '2026-06-01', '2026-06-30')).toBe('420.00');
    expect((await ok('GET', `/companies/${co}/purchase-deposits?party=V1`)).map((x: { docNo: string; remaining: string }) => [x.docNo, x.remaining]))
      .toEqual([['VD-0002', '1070.00']]);
  });
});
