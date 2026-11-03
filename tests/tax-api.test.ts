import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../apps/api/src/app';
import { devAuth } from '../apps/api/src/auth';
import { authConfigFromEnv } from '../apps/api/src/config';
import { createPool } from '../apps/api/src/db';
import { apiUrl } from './global-setup';
import { pool as db, newSchool, newUser, newClassroom, newCompany, taxId } from './helpers';

// เฟส 2.4 ภาษีผ่าน API: รายงานภาษีขาย/ซื้อ ภ.พ.30 ก่อนและหลังปิด ชำระ ยกเลิกการปิด ภ.ง.ด.3/53 นำส่ง และสิทธิ์
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
  await db.query(`update acc.companies set tax_id = $2, address = 'กรุงเทพฯ', version = version + 1 where id = $1`, [co, taxId(98)]);
  await db.query(`insert into acc.parties (company_id, code, name, is_customer, is_vendor, credit_days, tax_id, vat_registered, address) values
    ($1, 'C1', 'ลูกค้าหนึ่ง', true, false, 30, null, false, ''), ($1, 'V1', 'บริษัท ออกแบบ จำกัด', false, true, 30, '0105558012349', true, 'เชียงใหม่')`, [co]);
  await db.query(`insert into acc.items (company_id, code, name, unit, is_service) values ($1, 'G1', 'สินค้า', 'ชิ้น', false), ($1, 'S1', 'ค่าออกแบบ', 'งาน', true)`, [co]);
});

describe('API ภาษี', () => {
  it('ภ.พ.30: รายงาน → ปิด → ลงย้อนเดือนที่ปิดไม่ได้ (409) → ชำระ → ยกเลิกไม่ได้หลังชำระ', async () => {
    expect((await as(owner, 'POST', `/companies/${co}/sales/invoice`, { date: '2026-10-05', partyCode: 'C1', lines: [{ itemCode: 'G1', qty: '10', unitPrice: '1000' }] })).statusCode).toBe(201);
    expect((await as(owner, 'POST', `/companies/${co}/purchases/cash-purchase`,
      { date: '2026-10-06', partyCode: 'V1', vendorDocNo: 'R-1', whtKind: 'service', lines: [{ itemCode: 'S1', qty: '1', unitPrice: '2000' }] })).statusCode).toBe(201);

    const before = (await as(owner, 'GET', `/companies/${co}/tax/vat?month=2026-10`)).json();
    expect(before).toMatchObject({ month: '2026-10', closing: null, company: { vatRegistered: true, canWrite: true } });
    expect(before.sales.map((r: { docNo: string; vat: string }) => [r.docNo, r.vat])).toEqual([['IV-0001', '700.00']]);
    expect(before.purchases.map((r: { docNo: string; refNo: string; vat: string }) => [r.docNo, r.refNo, r.vat])).toEqual([['CP-0001', 'R-1', '140.00']]);
    expect(before.preview).toMatchObject({ outputVat: '700.00', inputVat: '140.00', payable: '560.00', refundable: '0.00', earlierOpen: false, laterClosed: false });

    expect((await as(teacher, 'POST', `/companies/${co}/tax/vat/2026-10/close`)).statusCode).toBe(403);
    expect((await as(other, 'GET', `/companies/${co}/tax/vat`)).statusCode).toBe(404);
    const key = randomUUID();
    const closed = await as(owner, 'POST', `/companies/${co}/tax/vat/2026-10/close`, undefined, key);
    expect(closed.statusCode).toBe(201);
    expect(closed.json()).toMatchObject({ month: '2026-10', outputVat: '700.00', inputVat: '140.00', payable: '560.00', entryDocNo: 'VC-0001', voidedAt: null });
    expect((await as(owner, 'POST', `/companies/${co}/tax/vat/2026-10/close`, undefined, key)).json().id).toBe(closed.json().id);
    expect((await as(owner, 'POST', `/companies/${co}/tax/vat/2026-10/close`)).statusCode).toBe(409);
    expect((await as(owner, 'POST', `/companies/${co}/tax/vat/2026-10/close`, undefined, null)).statusCode).toBe(400);

    const late = await as(owner, 'POST', `/companies/${co}/sales/cash-sale`, { date: '2026-10-30', partyCode: 'C1', lines: [{ itemCode: 'G1', qty: '1', unitPrice: '100' }] });
    expect(late.statusCode).toBe(409);
    expect(late.json()).toMatchObject({ code: 'ACC17', message: expect.stringContaining('10/2569 ปิดแล้ว') });

    const view = (await as(teacher, 'GET', `/companies/${co}/tax/vat?month=2026-10`)).json();
    expect(view.closing).toMatchObject({ id: closed.json().id, paidDocNo: null });
    expect(view.company.canWrite).toBe(false);
    expect(view.cashAccounts.map((a: { code: string }) => a.code)).toContain('1120');

    const id = closed.json().id;
    expect((await as(owner, 'POST', `/companies/${co}/tax/vat/closings/${id}/pay`, { date: '2026-10-31' })).statusCode).toBe(400);
    const paid = await as(owner, 'POST', `/companies/${co}/tax/vat/closings/${id}/pay`, { date: '2026-11-15', cashAccount: '1120' });
    expect(paid.statusCode).toBe(200);
    expect(paid.json()).toMatchObject({ paidDocNo: 'TX-0001', paidDate: '2026-11-15' });
    expect((await as(owner, 'POST', `/companies/${co}/tax/vat/closings/${id}/void`, { reason: 'ผิด' })).statusCode).toBe(409);
  });

  it('ยกเลิกการปิดเดือนล่าสุดต้องมีเหตุผล ประวัติแสดงทั้งที่ยกเลิกและที่ใช้อยู่', async () => {
    const r = await as(owner, 'POST', `/companies/${co}/tax/vat/2026-11/close`);
    expect(r.json()).toMatchObject({ outputVat: '0.00', payable: '0.00', entryDocNo: null });
    expect((await as(owner, 'POST', `/companies/${co}/tax/vat/closings/${r.json().id}/void`, { reason: ' ' })).statusCode).toBe(400);
    const v = await as(owner, 'POST', `/companies/${co}/tax/vat/closings/${r.json().id}/void`, { reason: 'ปิดเร็วไป' });
    expect(v.statusCode).toBe(200);
    expect(v.json()).toMatchObject({ voidReason: 'ปิดเร็วไป', voidedAt: expect.any(String), voidDocNo: null });
    const nov = (await as(owner, 'GET', `/companies/${co}/tax/vat?month=2026-11`)).json();
    expect(nov.closing).toBeNull();
    expect(nov.history.map((h: { month: string; voidedAt: string | null }) => [h.month, h.voidedAt !== null])).toEqual([['2026-11', true], ['2026-10', false]]);
  });

  it('ภ.ง.ด.53: หนังสือรับรองของเดือน ยอดรวม นำส่ง แล้วนำส่งซ้ำไม่ได้', async () => {
    const w = (await as(owner, 'GET', `/companies/${co}/tax/wht?month=2026-10`)).json();
    expect(w.certificates).toEqual([expect.objectContaining({ certNo: 'WT-0001', form: 'pnd53', docNo: 'CP-0001', base: '2000.00', amount: '60.00', voided: false })]);
    expect(w.forms).toEqual([
      { form: 'pnd3', count: 0, base: '0.00', amount: '0.00', remittance: null },
      { form: 'pnd53', count: 1, base: '2000.00', amount: '60.00', remittance: null },
    ]);
    expect((await as(owner, 'POST', `/companies/${co}/tax/wht/2026-10/pnd3/remit`, { date: '2026-11-07' })).statusCode).toBe(400);
    expect((await as(owner, 'POST', `/companies/${co}/tax/wht/2026-10/pnd1/remit`, { date: '2026-11-07' })).statusCode).toBe(400);
    const r = await as(owner, 'POST', `/companies/${co}/tax/wht/2026-10/pnd53/remit`, { date: '2026-11-07' });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ form: 'pnd53', amount: '60.00', certCount: 1, entryDocNo: 'TX-0002' });
    expect((await as(owner, 'POST', `/companies/${co}/tax/wht/2026-10/pnd53/remit`, { date: '2026-11-07' })).statusCode).toBe(409);
    const after = (await as(owner, 'GET', `/companies/${co}/tax/wht?month=2026-10`)).json();
    expect(after.forms[1].remittance).toMatchObject({ amount: '60.00', date: '2026-11-07', entryDocNo: 'TX-0002' });
  });
});
