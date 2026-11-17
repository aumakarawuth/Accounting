import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../apps/api/src/app';
import { devAuth } from '../apps/api/src/auth';
import { authConfigFromEnv } from '../apps/api/src/config';
import { createPool } from '../apps/api/src/db';
import { apiUrl } from './global-setup';
import { pool as db, newSchool, newUser, newClassroom, newCompany, taxId } from './helpers';

// ส่วนลดเงินสดตอนรับ/จ่ายชำระ (docs/phase5-spec.md ข้อ 6) เฉลยคิดมือล่วงหน้า (VAT 7%) เทียบทุกบรรทัด
const apiPool = createPool(apiUrl());
const app = buildApp({ pool: apiPool, auth: devAuth(), cfg: { ...authConfigFromEnv({}), allowedOrigins: false } });
afterAll(async () => { await app.close(); await apiPool.end(); await db.end(); });

type Method = 'GET' | 'POST' | 'PATCH';
let owner: string;
let co: string;
const call = (method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as object, headers: { 'x-dev-user-id': owner, 'x-dev-role': 'student', 'idempotency-key': randomUUID() } });
async function ok(method: Method, url: string, payload?: unknown) {
  const r = await call(method, url, payload);
  if (r.statusCode >= 300) throw new Error(`${method} ${url} → ${r.statusCode} ${r.body}`);
  return r.json();
}
async function entry(docNo: string) {
  const r = await db.query(
    `select a.code, sum(l.debit)::numeric(18,2)::text d, sum(l.credit)::numeric(18,2)::text c
       from acc.journal_lines l join acc.chart_of_accounts a on a.company_id = l.company_id and a.id = l.account_id
       join acc.journal_entries e on e.company_id = l.company_id and e.id = l.entry_id
      where e.company_id = $1 and e.doc_no = $2 group by a.code order by a.code`, [co, docNo]);
  return Object.fromEntries(r.rows.map((x) => [x.code, [x.d, x.c]]));
}
async function vat(side: 'sales' | 'purchases', month: string) {
  const r = await db.query(`select doc_no, base::numeric(18,2)::text b, vat::numeric(18,2)::text v
                              from acc.vat_report($1, $2::date, $3) order by row_date, doc_no`, [co, `${month}-01`, side]);
  return r.rows.map((x) => [x.doc_no, x.b, x.v]);
}
const gl = async (code: string) =>
  (await db.query(`select acc.account_movement($1, $2, '2026-01-01', '2026-12-31')::numeric(18,2)::text v`, [co, code])).rows[0].v as string;

beforeAll(async () => {
  const school = await newSchool();
  const teacher = await newUser(school, 'teacher');
  owner = await newUser(school, 'student');
  co = await newCompany(owner, await newClassroom(school, teacher, [owner]));
  const prof = await ok('GET', `/companies/${co}/profile`);
  await ok('PATCH', `/companies/${co}/profile`, { version: prof.version, taxId: taxId(9801), vatRegistered: true });
  await ok('POST', `/companies/${co}/parties`, { code: 'C1', name: 'ร้าน ลูกค้าหนึ่ง', isCustomer: true, isVendor: false, taxId: taxId(9811), vatRegistered: true, creditDays: 30 });
  await ok('POST', `/companies/${co}/parties`, { code: 'V1', name: 'บริษัท ผู้ขายหนึ่ง จำกัด', isCustomer: false, isVendor: true, taxId: taxId(9821), vatRegistered: true, creditDays: 30 });
  await ok('POST', `/companies/${co}/items`, { code: 'P', name: 'สินค้า', unit: 'ชิ้น', isService: false });
  await ok('POST', `/companies/${co}/items`, { code: 'S', name: 'ค่าบริการ', unit: 'งาน', isService: true });
});

describe('รับชำระพร้อมส่วนลดเงินสด (4210 ส่วนลดจ่าย)', () => {
  it('ขายสินค้า 10,700 ลูกค้าจ่าย 10,486 ส่วนลด 2% = 214: Dr เงิน 10,486 Dr 4210 214 / Cr 1210 10,700 · ภาษีขายไม่เปลี่ยน', async () => {
    const iv = await ok('POST', `/companies/${co}/sales/invoice`, { date: '2026-03-02', partyCode: 'C1', lines: [{ itemCode: 'P', qty: '10', unitPrice: '1000' }] });
    const re = await ok('POST', `/companies/${co}/receipts`, { date: '2026-03-10', partyCode: 'C1', cashAccount: '1110',
      allocations: [{ documentId: iv.id, amount: '10486', discount: '214' }] });
    expect(await entry(re.docNo)).toEqual({ 1110: ['10486.00', '0.00'], 1210: ['0.00', '10700.00'], 4210: ['214.00', '0.00'] });
    const d = await ok('GET', `/companies/${co}/sales/documents/${re.id}`);
    expect([d.gross, d.discount, d.total, d.vat]).toEqual(['10700.00', '214.00', '10486.00', '0.00']);
    expect(d.settles.map((s: { amount: string; discount: string }) => [s.amount, s.discount])).toEqual([['10700.00', '214.00']]);
    expect((await ok('GET', `/companies/${co}/sales/documents/${iv.id}`)).open).toBe('0.00');
    expect(await vat('sales', '2026-03')).toEqual([[iv.docNo, '10000.00', '700.00']]);
  });

  it('บริการ 5,350 ลูกค้าจ่าย 5,243 ส่วนลด 107: ภาษีของส่วนลด 7 ไม่ถึงกำหนด ล้างออก · ภาษีขายถึงกำหนด 343 = 7% ของ 4,900', async () => {
    const iv = await ok('POST', `/companies/${co}/sales/invoice`, { date: '2026-04-02', partyCode: 'C1', lines: [{ itemCode: 'S', qty: '1', unitPrice: '5000' }] });
    const re = await ok('POST', `/companies/${co}/receipts`, { date: '2026-04-10', partyCode: 'C1', cashAccount: '1110',
      allocations: [{ documentId: iv.id, amount: '5243', discount: '107' }] });
    expect(await entry(re.docNo)).toEqual({
      1110: ['5243.00', '0.00'], 1210: ['0.00', '5350.00'], 2210: ['0.00', '343.00'], 2211: ['350.00', '0.00'], 4210: ['100.00', '0.00'] });
    expect(await vat('sales', '2026-04')).toEqual([[re.docNo, '4900.00', '343.00']]);
    expect(await gl('2211')).toBe('0.00');
  });

  it('บริการรับสองครั้ง: ครั้งแรก 1,000 + ส่วนลด 70 ตัด 1,070 (ภาษี 70 = ถึงกำหนด 65.42 + ล้าง 4.58) ครั้งหลังรับเต็ม 1,070 · 2211 เป็นศูนย์', async () => {
    const iv = await ok('POST', `/companies/${co}/sales/invoice`, { date: '2026-05-02', partyCode: 'C1', lines: [{ itemCode: 'S', qty: '1', unitPrice: '2000' }] });
    const r1 = await ok('POST', `/companies/${co}/receipts`, { date: '2026-05-10', partyCode: 'C1', cashAccount: '1110',
      allocations: [{ documentId: iv.id, amount: '1000', discount: '70' }] });
    expect(await entry(r1.docNo)).toEqual({
      1110: ['1000.00', '0.00'], 1210: ['0.00', '1070.00'], 2210: ['0.00', '65.42'], 2211: ['70.00', '0.00'], 4210: ['65.42', '0.00'] });
    expect((await ok('GET', `/companies/${co}/sales/documents/${iv.id}`)).open).toBe('1070.00');
    const over = await call('POST', `/companies/${co}/receipts`, { date: '2026-05-20', partyCode: 'C1', cashAccount: '1110',
      allocations: [{ documentId: iv.id, amount: '1000', discount: '71' }] });
    expect(over.json().message).toBe(`${iv.docNo} ค้างอยู่ 1070.00 รับเกินยอดค้างไม่ได้`);
    const r2 = await ok('POST', `/companies/${co}/receipts`, { date: '2026-05-20', partyCode: 'C1', cashAccount: '1110',
      allocations: [{ documentId: iv.id, amount: '1070' }] });
    expect(await entry(r2.docNo)).toEqual({ 1110: ['1070.00', '0.00'], 1210: ['0.00', '1070.00'], 2210: ['0.00', '70.00'], 2211: ['70.00', '0.00'] });
    expect(await gl('2211')).toBe('0.00');
    expect(await vat('sales', '2026-05')).toEqual([[r1.docNo, '934.58', '65.42'], [r2.docNo, '1000.00', '70.00']]);
  });

  it('ยกเลิกใบเสร็จที่มีส่วนลด → ใบขายค้างเต็มจำนวนอีกครั้ง', async () => {
    const iv = await ok('POST', `/companies/${co}/sales/invoice`, { date: '2026-06-02', partyCode: 'C1', lines: [{ itemCode: 'P', qty: '1', unitPrice: '1000' }] });
    const re = await ok('POST', `/companies/${co}/receipts`, { date: '2026-06-05', partyCode: 'C1', cashAccount: '1110',
      allocations: [{ documentId: iv.id, amount: '1060', discount: '10' }] });
    await ok('POST', `/companies/${co}/sales/documents/${re.id}/void`, { date: '2026-06-05', reason: 'ทดสอบ' });
    expect((await ok('GET', `/companies/${co}/sales/documents/${iv.id}`)).open).toBe('1070.00');
    const neg = await call('POST', `/companies/${co}/receipts`, { date: '2026-06-05', partyCode: 'C1', cashAccount: '1110',
      allocations: [{ documentId: iv.id, amount: '1000', discount: '-1' }] });
    expect(neg.statusCode).toBe(400);
  });
});

describe('จ่ายชำระพร้อมส่วนลดเงินสดที่ได้รับ (5120 ส่วนลดรับ)', () => {
  it('ซื้อสินค้า 21,400 จ่าย 21,000 ส่วนลด 400: Dr 2110 21,400 / Cr เงิน 21,000 Cr 5120 400', async () => {
    const pi = await ok('POST', `/companies/${co}/purchases/invoice`, { date: '2026-07-01', partyCode: 'V1', vendorDocNo: 'A-1',
      lines: [{ itemCode: 'P', qty: '20', unitPrice: '1000' }] });
    const pv = await ok('POST', `/companies/${co}/payments`, { date: '2026-07-10', partyCode: 'V1', cashAccount: '1110',
      allocations: [{ documentId: pi.id, amount: '21000', discount: '400' }] });
    expect(await entry(pv.docNo)).toEqual({ 1110: ['0.00', '21000.00'], 2110: ['21400.00', '0.00'], 5120: ['0.00', '400.00'] });
    const d = await ok('GET', `/companies/${co}/purchases/documents/${pv.id}`);
    expect([d.gross, d.discount, d.total]).toEqual(['21400.00', '400.00', '21000.00']);
    expect((await ok('GET', `/companies/${co}/purchases/documents/${pi.id}`)).open).toBe('0.00');
  });

  it('ค่าบริการ 10,700 จ่าย 10,593 ส่วนลด 107 หัก 3%: ฐานหัก 9,900 ภาษีหัก 297 · ภาษีซื้อถึงกำหนด 693 ส่วนลด 100 ภาษีล้าง 7', async () => {
    const pi = await ok('POST', `/companies/${co}/purchases/invoice`, { date: '2026-08-01', partyCode: 'V1', vendorDocNo: 'A-2',
      lines: [{ itemCode: 'S', qty: '1', unitPrice: '10000' }] });
    const pv = await ok('POST', `/companies/${co}/payments`, { date: '2026-08-10', partyCode: 'V1', cashAccount: '1110', whtKind: 'service',
      allocations: [{ documentId: pi.id, amount: '10593', discount: '107' }] });
    expect(await entry(pv.docNo)).toEqual({
      1110: ['0.00', '10296.00'], 1410: ['693.00', '0.00'], 1411: ['0.00', '700.00'], 2110: ['10700.00', '0.00'], 2230: ['0.00', '297.00'], 5120: ['0.00', '100.00'] });
    const d = await ok('GET', `/companies/${co}/purchases/documents/${pv.id}`);
    expect([d.certificate.base, d.certificate.amount]).toEqual(['9900.00', '297.00']);
    expect(await vat('purchases', '2026-08')).toEqual([[pv.docNo, '9900.00', '693.00']]);
    expect(await gl('1411')).toBe('0.00');
  });

  it('จ่ายด้วยเช็คพร้อมส่วนลด: เช็คเท่ายอดเงินที่จ่ายจริง', async () => {
    const pi = await ok('POST', `/companies/${co}/purchases/invoice`, { date: '2026-09-01', partyCode: 'V1', vendorDocNo: 'A-3',
      lines: [{ itemCode: 'P', qty: '1', unitPrice: '5000' }] });
    const ch = await ok('POST', `/companies/${co}/cheques`, { direction: 'paid', date: '2026-09-10', chequeDate: '2026-09-10', chequeNo: '1000123',
      bankName: 'กสิกรไทย', bankAccount: '1120', payment: { partyCode: 'V1', allocations: [{ documentId: pi.id, amount: '5300', discount: '50' }] } });
    expect(ch.amount).toBe('5300.00');
    expect((await ok('GET', `/companies/${co}/purchases/documents/${pi.id}`)).open).toBe('0.00');
  });
});
