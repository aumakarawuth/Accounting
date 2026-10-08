import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../apps/api/src/app';
import { devAuth } from '../apps/api/src/auth';
import { authConfigFromEnv } from '../apps/api/src/config';
import { createPool } from '../apps/api/src/db';
import { apiUrl } from './global-setup';
import { pool as db, newSchool, newUser, newClassroom, newCompany, taxId } from './helpers';

// เฟส 2.3 ซื้อ ผ่าน API: บันทึกซื้อ จ่ายชำระพร้อมหัก ณ ที่จ่าย ดูเอกสาร + 50 ทวิ ยกเลิก เจ้าหนี้คงค้าง/อายุหนี้ และสิทธิ์
const apiPool = createPool(apiUrl());
const app = buildApp({ pool: apiPool, auth: devAuth(), cfg: { ...authConfigFromEnv({}), allowedOrigins: false } });
afterAll(async () => { await app.close(); await apiPool.end(); await db.end(); });

const teachers = new Set<string>();
const as = (user: string, method: 'GET' | 'POST', url: string, payload?: unknown, key: string | null = randomUUID()) =>
  app.inject({ method, url, payload, headers: {
    'x-dev-user-id': user, 'x-dev-role': teachers.has(user) ? 'teacher' : 'student', ...(key ? { 'idempotency-key': key } : {}) } });

const juristic = '0105558012349'; // หลักตรวจสอบถูก ขึ้นต้น 0 = นิติบุคคล
let teacher: string, owner: string, other: string, co: string;
beforeAll(async () => {
  const school = await newSchool();
  teacher = await newUser(school, 'teacher');
  teachers.add(teacher);
  owner = await newUser(school, 'student');
  other = await newUser(school, 'student');
  const room = await newClassroom(school, teacher, [owner, other]);
  co = await newCompany(owner, room);
  await db.query(`update acc.companies set tax_id = $2, address = 'กรุงเทพฯ', version = version + 1 where id = $1`, [co, taxId(99)]);
  await db.query(`insert into acc.parties (company_id, code, name, is_vendor, credit_days, tax_id, vat_registered, wht_kind, wht_rate, address) values
    ($1, 'V1', 'บริษัท ออกแบบ จำกัด', true, 30, $2, true, 'service', 3, 'เชียงใหม่'), ($1, 'V2', 'ร้านเครื่องเขียน', true, 0, null, false, null, null, '')`, [co, juristic]);
  await db.query(`insert into acc.items (company_id, code, name, unit, is_service, purchase_price) values
    ($1, 'G1', 'กระดาษ A4', 'รีม', false, 100), ($1, 'S1', 'ค่าออกแบบ', 'งาน', true, 5000)`, [co]);
});

describe('API เอกสารซื้อ', () => {
  it('ข้อมูลฟอร์ม: ผู้ขาย (พร้อมหัก ณ ที่จ่ายตั้งต้น) สินค้า บัญชีค่าใช้จ่าย บัญชีจ่ายเงิน', async () => {
    const f = (await as(owner, 'GET', `/companies/${co}/purchases/form`)).json();
    expect(f.company).toMatchObject({ vatRegistered: true, canWrite: true, locked: false });
    expect(f.vendors.map((v: { code: string; whtKind: string | null; whtRate: string | null }) => [v.code, v.whtKind, v.whtRate]))
      .toEqual([['V1', 'service', '3.00'], ['V2', null, null]]);
    expect(f.items.map((i: { code: string; purchasePrice: string }) => [i.code, i.purchasePrice])).toEqual([['G1', '100.00'], ['S1', '5000.00']]);
    const exp = f.expenseAccounts.map((a: { code: string }) => a.code);
    expect(exp).toContain('5110');
    expect(exp).toContain('1630');
    expect(exp).not.toContain('1110');
    expect(f.cashAccounts.map((a: { code: string }) => a.code)).toEqual(['1110', '1120', '1130', '1140']);
    expect(f.systemAccounts.map((a: { code: string }) => a.code)).toEqual(['1410', '1411', '2110', '2230', '5140']);
  });

  it('ซื้อเชื่อบริการ → จ่ายชำระหัก 3% → ใบสำคัญจ่ายมี 50 ทวิ → ใบเดิมจ่ายครบ', async () => {
    const r = await as(owner, 'POST', `/companies/${co}/purchases/invoice`, {
      date: '2026-10-05', partyCode: 'v1', vendorDocNo: 'INV-77', lines: [{ itemCode: 'S1', qty: '1', unitPrice: '10000' }],
    });
    expect(r.statusCode).toBe(201);
    const { id, docNo } = r.json();
    expect(docNo).toBe('PI-0001');
    const d = (await as(owner, 'GET', `/companies/${co}/purchases/documents/${id}`)).json();
    expect(d).toMatchObject({
      docNo: 'PI-0001', kind: 'purchase_invoice', vendorDocNo: 'INV-77', date: '2026-10-05', dueDate: '2026-11-04',
      partyName: 'บริษัท ออกแบบ จำกัด', partyTaxId: juristic, isService: true, vatClaimable: true,
      base: '10000.00', vat: '700.00', total: '10700.00', open: '10700.00', entryDocNo: 'PI-0001', certificate: null,
      lines: [{ lineNo: 1, description: 'ค่าออกแบบ', qty: '1.000', unit: 'งาน', unitPrice: '10000.00', amount: '10000.00', accountCode: '5260' }],
    });
    const listed = (await as(owner, 'GET', `/companies/${co}/purchases?party=V1&kind=purchase_invoice`)).json();
    expect(listed.find((x: { id: string }) => x.id === id)).toMatchObject({ open: '10700.00', undueVat: '700.00' });
    const pv = await as(owner, 'POST', `/companies/${co}/payments`, { date: '2026-10-10', partyCode: 'V1', cashAccount: '1120', whtKind: 'service', allocations: [{ documentId: id, amount: '10700' }] });
    expect(pv.json().docNo).toBe('PV-0001');
    const p = (await as(owner, 'GET', `/companies/${co}/purchases/documents/${pv.json().id}`)).json();
    expect(p).toMatchObject({
      kind: 'payment', cashAccount: '1120', total: '10700.00', vat: '700.00', whtBase: '10000.00', whtAmount: '300.00', open: null,
      companyName: expect.any(String), companyTaxId: taxId(99), settles: [{ docNo: 'PI-0001', vendorDocNo: 'INV-77', amount: '10700.00', vatTransfer: '700.00' }],
      certificate: { certNo: 'WT-0001', date: '2026-10-10', form: 'pnd53', payerTaxId: taxId(99), payeeName: 'บริษัท ออกแบบ จำกัด',
        payeeAddress: 'เชียงใหม่', whtKind: 'service', whtRate: '3.00', base: '10000.00', amount: '300.00', voided: false },
    });
    const after = (await as(owner, 'GET', `/companies/${co}/purchases/documents/${id}`)).json();
    expect(after).toMatchObject({ open: '0.00', settledBy: [{ docNo: 'PV-0001', amount: '10700.00', voided: false }] });
  });

  it('ต้องมี idempotency key · ส่งซ้ำได้ใบเดิม · ไม่มีเลขที่ผู้ขาย/ผู้ขาย 400 · บันทึกใบผู้ขายซ้ำ 422 · ผู้ขายไม่มีเลขภาษีแต่หัก 422', async () => {
    const body = { date: '2026-10-06', partyCode: 'V2', vendorDocNo: 'R-1', lines: [{ itemCode: 'G1', qty: '2', unitPrice: '100' }] };
    expect((await as(owner, 'POST', `/companies/${co}/purchases/cash-purchase`, body, null)).statusCode).toBe(400);
    const key = randomUUID();
    const a = (await as(owner, 'POST', `/companies/${co}/purchases/cash-purchase`, body, key)).json();
    expect(a.docNo).toBe('CP-0001');
    expect((await as(owner, 'POST', `/companies/${co}/purchases/cash-purchase`, body, key)).json()).toEqual(a);
    const dup = await as(owner, 'POST', `/companies/${co}/purchases/cash-purchase`, body);
    expect([dup.statusCode, dup.json().code]).toEqual([422, 'ACC15']);
    expect(dup.json().message).toContain('R-1');
    expect((await as(owner, 'POST', `/companies/${co}/purchases/invoice`, { ...body, vendorDocNo: ' ' })).statusCode).toBe(400);
    expect((await as(owner, 'POST', `/companies/${co}/purchases/invoice`, { ...body, vendorDocNo: 'R-2', partyCode: undefined })).statusCode).toBe(400);
    expect((await as(owner, 'POST', `/companies/${co}/purchases/credit-note`, { ...body, vendorDocNo: 'R-3' })).statusCode).toBe(400);
    const noTax = await as(owner, 'POST', `/companies/${co}/purchases/cash-purchase`, { ...body, vendorDocNo: 'R-4', whtKind: 'service' });
    expect([noTax.statusCode, noTax.json().code]).toEqual([422, 'ACC14']);
    expect((await as(owner, 'POST', `/companies/${co}/purchases/cash-purchase`, { ...body, vendorDocNo: 'R-5', whtKind: 'bonus' })).statusCode).toBe(400);
  });

  it('ใบลดหนี้จากผู้ขายแล้วยกเลิก: รายการแสดงยอดค้าง ยกเลิกต้องมีเหตุผล ได้เลข RV', async () => {
    const pi = (await as(owner, 'POST', `/companies/${co}/purchases/invoice`, { date: '2026-10-07', partyCode: 'V1', vendorDocNo: 'INV-78', lines: [{ itemCode: 'G1', qty: '50', unitPrice: '100' }] })).json();
    const pn = await as(owner, 'POST', `/companies/${co}/purchases/credit-note`, { date: '2026-10-08', refDocumentId: pi.id, vendorDocNo: 'CN-9', reason: 'ส่งคืน', lines: [{ itemCode: 'G1', qty: '5', unitPrice: '100' }] });
    expect(pn.json().docNo).toBe('PN-0001');
    const list = (await as(owner, 'GET', `/companies/${co}/purchases?kind=purchase_invoice&month=2026-10`)).json();
    expect(list.find((x: { docNo: string }) => x.docNo === pi.docNo)).toMatchObject({ total: '5350.00', open: '4815.00', vendorDocNo: 'INV-78' });
    expect((await as(owner, 'POST', `/companies/${co}/purchases/documents/${pi.id}/void`, { date: '2026-10-09', reason: '' })).statusCode).toBe(400);
    const blocked = await as(owner, 'POST', `/companies/${co}/purchases/documents/${pi.id}/void`, { date: '2026-10-09', reason: 'บันทึกผิด' });
    expect([blocked.statusCode, blocked.json().code]).toEqual([409, 'ACC16']);
    const v = await as(owner, 'POST', `/companies/${co}/purchases/documents/${pn.json().id}/void`, { date: '2026-10-09', reason: 'บันทึกผิด' });
    expect(v.json().voidDocNo).toMatch(/^RV-\d{4}$/);
    const doc = (await as(owner, 'GET', `/companies/${co}/purchases/documents/${pn.json().id}`)).json();
    expect(doc).toMatchObject({ voidReason: 'บันทึกผิด', voidDocNo: v.json().voidDocNo, refDocNo: pi.docNo, kind: 'purchase_credit_note' });
  });

  it('เจ้าหนี้คงค้าง: อายุหนี้ตามวันครบกำหนด และรวมรายผู้ขาย', async () => {
    const r = (await as(owner, 'GET', `/companies/${co}/payables?asOf=2026-12-20`)).json();
    // ใบที่ยังค้าง: INV-78 (ครบกำหนด 2026-11-06 เลย 44 วัน → 31–60)
    expect(r.items).toEqual([expect.objectContaining({ docNo: 'PI-0002', vendorDocNo: 'INV-78', open: '5350.00', dueDate: '2026-11-06', daysOverdue: 44, bucket: 'd60' })]);
    expect(r.totals).toEqual({ all: '5350.00', current: '0.00', d30: '0.00', d60: '5350.00', d90: '0.00', over90: '0.00' });
    expect(r.byParty).toEqual([{ partyCode: 'V1', partyName: 'บริษัท ออกแบบ จำกัด', all: '5350.00', current: '0.00', d30: '0.00', d60: '5350.00', d90: '0.00', over90: '0.00' }]);
  });

  it('สิทธิ์: ครูดูได้แต่บันทึก/ยกเลิกไม่ได้ · นักเรียนคนอื่นไม่เห็นบริษัทนี้', async () => {
    expect((await as(teacher, 'GET', `/companies/${co}/purchases`)).statusCode).toBe(200);
    expect((await as(teacher, 'GET', `/companies/${co}/payables`)).statusCode).toBe(200);
    expect((await as(teacher, 'POST', `/companies/${co}/purchases/invoice`, { date: '2026-10-05', partyCode: 'V1', vendorDocNo: 'T-1', lines: [{ itemCode: 'G1', qty: '1', unitPrice: '1' }] })).statusCode).toBe(403);
    expect((await as(other, 'GET', `/companies/${co}/purchases`)).statusCode).toBe(404);
    expect((await as(other, 'GET', `/companies/${co}/purchases/form`)).statusCode).toBe(404);
  });
});
