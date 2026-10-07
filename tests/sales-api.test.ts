import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../apps/api/src/app';
import { devAuth } from '../apps/api/src/auth';
import { authConfigFromEnv } from '../apps/api/src/config';
import { createPool } from '../apps/api/src/db';
import { apiUrl } from './global-setup';
import { pool as db, newSchool, newUser, newClassroom, newCompany, taxId } from './helpers';

// เฟส 2.2 ขาย ผ่าน API: ออกเอกสาร รับชำระ ดูเอกสาร ยกเลิก ลูกหนี้คงค้าง/อายุหนี้ และสิทธิ์
const apiPool = createPool(apiUrl());
const app = buildApp({ pool: apiPool, auth: devAuth(), cfg: { ...authConfigFromEnv({}), allowedOrigins: false } });
afterAll(async () => { await app.close(); await apiPool.end(); await db.end(); });

const teachers = new Set<string>();
const as = (user: string, method: 'GET' | 'POST', url: string, payload?: unknown, key: string | null = randomUUID()) =>
  app.inject({ method, url, payload, headers: {
    'x-dev-user-id': user, 'x-dev-role': teachers.has(user) ? 'teacher' : 'student', ...(key ? { 'idempotency-key': key } : {}) } });

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
  await db.query(`insert into acc.parties (company_id, code, name, is_customer, credit_days, tax_id, vat_registered) values
    ($1, 'C1', 'บริษัท ลูกค้า จำกัด', true, 30, $2, true), ($1, 'C2', 'ร้านเงินสด', true, 0, null, false)`, [co, taxId(5)]);
  await db.query(`insert into acc.items (company_id, code, name, unit, is_service, sale_price) values
    ($1, 'G1', 'กระดาษ A4', 'รีม', false, 120), ($1, 'S1', 'ค่าออกแบบ', 'งาน', true, 5000)`, [co]);
});

describe('API เอกสารขาย', () => {
  it('ข้อมูลฟอร์ม: ลูกค้า สินค้า บัญชีรายได้ บัญชีรับเงิน และสถานะ VAT ของบริษัท', async () => {
    const f = (await as(owner, 'GET', `/companies/${co}/sales/form`)).json();
    expect(f.company).toMatchObject({ vatRegistered: true, vatRate: '7.00', canWrite: true, locked: false });
    expect(f.customers.map((c: { code: string }) => c.code)).toEqual(['C1', 'C2']);
    expect(f.items.map((i: { code: string; isService: boolean }) => [i.code, i.isService])).toEqual([['G1', false], ['S1', true]]);
    expect(f.revenueAccounts.map((a: { code: string }) => a.code)).toContain('4110');
    expect(f.cashAccounts.map((a: { code: string }) => a.code)).toEqual(['1110', '1120', '1130', '1140']);
  });

  it('ขายเชื่อ → ดูใบ (ข้อมูลผู้ขาย/ลูกค้าตามที่ออก) → รับชำระ → ใบแสดงว่าถูกรับชำระแล้ว', async () => {
    const r = await as(owner, 'POST', `/companies/${co}/sales/invoice`, {
      date: '2026-10-05', partyCode: 'c1', lines: [{ itemCode: 'G1', qty: '10', unitPrice: '120' }],
    });
    expect(r.statusCode).toBe(201);
    const { id, docNo } = r.json();
    expect(docNo).toBe('IV-0001');
    const d = (await as(owner, 'GET', `/companies/${co}/sales/documents/${id}`)).json();
    expect(d).toMatchObject({
      docNo: 'IV-0001', kind: 'sales_invoice', date: '2026-10-05', dueDate: '2026-11-04', partyName: 'บริษัท ลูกค้า จำกัด',
      partyTaxId: taxId(5), partyBranchNo: '00000', sellerTaxId: taxId(99), sellerAddress: 'กรุงเทพฯ', isTaxInvoice: true,
      base: '1200.00', vat: '84.00', total: '1284.00', open: '1284.00', entryDocNo: 'IV-0001', settledBy: [], notes: [],
      lines: [{ lineNo: 1, description: 'กระดาษ A4', qty: '10.000', unit: 'รีม', unitPrice: '120.00', amount: '1200.00', accountCode: '4110' }],
    });
    const re = await as(owner, 'POST', `/companies/${co}/receipts`, { date: '2026-10-10', partyCode: 'C1', cashAccount: '1120', allocations: [{ documentId: id, amount: '1284' }] });
    expect(re.json().docNo).toBe('RE-0001');
    const after = (await as(owner, 'GET', `/companies/${co}/sales/documents/${id}`)).json();
    expect(after).toMatchObject({ open: '0.00', settledBy: [{ docNo: 'RE-0001', amount: '1284.00', voided: false }] });
    const receipt = (await as(owner, 'GET', `/companies/${co}/sales/documents/${re.json().id}`)).json();
    expect(receipt).toMatchObject({ kind: 'receipt', cashAccount: '1120', open: null, settles: [{ docNo: 'IV-0001', amount: '1284.00' }] });
  });

  it('ต้องมี idempotency key · ส่งซ้ำด้วย key เดิมได้ใบเดิม · ข้อมูลผิดตอบ 400/422 พร้อมเหตุ', async () => {
    const body = { date: '2026-10-06', partyCode: 'C2', lines: [{ itemCode: 'G1', qty: '1', unitPrice: '120' }] };
    expect((await as(owner, 'POST', `/companies/${co}/sales/cash-sale`, body, null)).statusCode).toBe(400);
    const key = randomUUID();
    const a = (await as(owner, 'POST', `/companies/${co}/sales/cash-sale`, body, key)).json();
    const b = (await as(owner, 'POST', `/companies/${co}/sales/cash-sale`, body, key)).json();
    expect(a).toEqual(b);
    const mixed = await as(owner, 'POST', `/companies/${co}/sales/invoice`, { ...body, lines: [{ itemCode: 'G1', qty: '1', unitPrice: '1' }, { itemCode: 'S1', qty: '1', unitPrice: '1' }] });
    expect([mixed.statusCode, mixed.json().code]).toEqual([422, 'ACC15']);
    expect(mixed.json().message).toContain('สินค้ากับบริการต้องแยกใบ');
    expect((await as(owner, 'POST', `/companies/${co}/sales/invoice`, { ...body, partyCode: undefined })).statusCode).toBe(400);
    expect((await as(owner, 'POST', `/companies/${co}/sales/credit-note`, { ...body })).statusCode).toBe(400);
    expect((await as(owner, 'POST', `/companies/${co}/sales/invoice`, { ...body, lines: [{ qty: '1.2345', unitPrice: '1', description: 'x' }] })).statusCode).toBe(400);
    expect((await as(owner, 'POST', `/companies/${co}/sales/refund`, body)).statusCode).toBe(400);
  });

  it('ลดหนี้แล้วยกเลิก: รายการเอกสารแสดงยอดค้าง ยกเลิกต้องมีเหตุผล ได้เลข RV', async () => {
    const iv = (await as(owner, 'POST', `/companies/${co}/sales/invoice`, { date: '2026-10-07', partyCode: 'C1', lines: [{ itemCode: 'S1', qty: '1', unitPrice: '5000' }] })).json();
    const cn = await as(owner, 'POST', `/companies/${co}/sales/credit-note`, { date: '2026-10-08', refDocumentId: iv.id, reason: 'ลดราคา', lines: [{ description: 'ลดค่าออกแบบ', qty: '1', unitPrice: '500' }] });
    expect(cn.json().docNo).toBe('CN-0001');
    const list = (await as(owner, 'GET', `/companies/${co}/sales?kind=sales_invoice&month=2026-10`)).json();
    expect(list.find((x: { docNo: string }) => x.docNo === iv.docNo)).toMatchObject({ total: '5350.00', open: '4815.00', isService: true, isTaxInvoice: false });
    expect((await as(owner, 'POST', `/companies/${co}/sales/documents/${iv.id}/void`, { date: '2026-10-09', reason: '' })).statusCode).toBe(400);
    const blocked = await as(owner, 'POST', `/companies/${co}/sales/documents/${iv.id}/void`, { date: '2026-10-09', reason: 'ออกผิด' });
    expect([blocked.statusCode, blocked.json().code]).toEqual([409, 'ACC16']);
    const v = await as(owner, 'POST', `/companies/${co}/sales/documents/${cn.json().id}/void`, { date: '2026-10-09', reason: 'ออกผิด' });
    expect(v.json().voidDocNo).toMatch(/^RV-\d{4}$/);
    const doc = (await as(owner, 'GET', `/companies/${co}/sales/documents/${cn.json().id}`)).json();
    expect(doc).toMatchObject({ voidReason: 'ออกผิด', voidDocNo: v.json().voidDocNo, refDocNo: iv.docNo });
  });

  it('ลูกหนี้คงค้าง: อายุหนี้ตามวันครบกำหนด และรวมรายลูกค้า', async () => {
    const r = (await as(owner, 'GET', `/companies/${co}/receivables?asOf=2026-12-20`)).json();
    // IV ที่ยังค้าง: ใบค่าออกแบบ (ครบกำหนด 2026-11-06 เลย 44 วัน → 31–60)
    expect(r.asOf).toBe('2026-12-20');
    expect(r.items).toEqual([expect.objectContaining({ docNo: 'IV-0002', open: '5350.00', dueDate: '2026-11-06', daysOverdue: 44, bucket: 'd60' })]);
    expect(r.totals).toEqual({ all: '5350.00', current: '0.00', d30: '0.00', d60: '5350.00', d90: '0.00', over90: '0.00' });
    expect(r.byParty).toEqual([{ partyCode: 'C1', partyName: 'บริษัท ลูกค้า จำกัด', all: '5350.00', current: '0.00', d30: '0.00', d60: '5350.00', d90: '0.00', over90: '0.00' }]);
    const early = (await as(owner, 'GET', `/companies/${co}/receivables?asOf=2026-10-06`)).json();
    expect(early.items).toEqual([]); // ใบลงวันที่ 7 ยังไม่เกิด ณ วันที่ 6
  });

  it('สิทธิ์: ครูดูได้แต่ออก/ยกเลิกไม่ได้ · นักเรียนคนอื่นไม่เห็นบริษัทนี้', async () => {
    expect((await as(teacher, 'GET', `/companies/${co}/sales`)).statusCode).toBe(200);
    expect((await as(teacher, 'GET', `/companies/${co}/receivables`)).statusCode).toBe(200);
    expect((await as(teacher, 'POST', `/companies/${co}/sales/invoice`, { date: '2026-10-05', partyCode: 'C1', lines: [{ itemCode: 'G1', qty: '1', unitPrice: '1' }] })).statusCode).toBe(403);
    expect((await as(other, 'GET', `/companies/${co}/sales`)).statusCode).toBe(404);
    expect((await as(other, 'GET', `/companies/${co}/sales/form`)).statusCode).toBe(404);
  });
});
