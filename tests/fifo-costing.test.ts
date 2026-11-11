import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../apps/api/src/app';
import { devAuth } from '../apps/api/src/auth';
import { authConfigFromEnv } from '../apps/api/src/config';
import { createPool } from '../apps/api/src/db';
import { apiUrl } from './global-setup';
import { pool as db, newSchool, newUser, newClassroom, newCompany, taxId } from './helpers';

// ต้นทุน FIFO (docs/phase5-spec.md ข้อ 7) เฉลยคิดมือ: บริษัทไม่จด VAT ผู้ขายไม่จด VAT (ต้นทุน = ยอดในใบซื้อ)
const apiPool = createPool(apiUrl());
const app = buildApp({ pool: apiPool, auth: devAuth(), cfg: { ...authConfigFromEnv({}), allowedOrigins: false } });
afterAll(async () => { await app.close(); await apiPool.end(); await db.end(); });

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT';
let owner: string;
let co: string;
const call = (method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as object, headers: { 'x-dev-user-id': owner, 'x-dev-role': 'student', 'idempotency-key': randomUUID() } });
async function ok(method: Method, url: string, payload?: unknown) {
  const r = await call(method, url, payload);
  if (r.statusCode >= 300) throw new Error(`${method} ${url} → ${r.statusCode} ${r.body}`);
  return r.json();
}
/** บัตรสต็อกของสินค้า (ค่าหลังคำนวณใหม่ ไม่รวมเอกสารที่ยกเลิก): [วันที่, จำนวน, มูลค่า] */
async function card(code: string) {
  const r = await db.query(
    `select to_char(m.movement_date, 'MM-DD') d, m.quantity::numeric(14,0)::text q, m.eff_value::numeric(18,2)::text v
       from acc.inventory_movements_effective m join acc.items i on i.company_id = m.company_id and i.id = m.item_id
      where m.company_id = $1 and i.code = $2 and m.live order by m.movement_date, m.created_at`, [co, code]);
  return r.rows.map((x) => [x.d, x.q, x.v]);
}
const gl1310 = async () => (await db.query(`select acc.account_movement($1, '1310', '2026-01-01', '2026-12-31')::numeric(18,2)::text v`, [co])).rows[0].v;
const buy = (date: string, no: string, qty: string, price: string) =>
  ok('POST', `/companies/${co}/purchases/invoice`, { date, partyCode: 'V1', vendorDocNo: no, lines: [{ itemCode: 'F', qty, unitPrice: price }] });
const sell = (date: string, qty: string) =>
  ok('POST', `/companies/${co}/sales/invoice`, { date, partyCode: 'C1', lines: [{ itemCode: 'F', qty, unitPrice: '300' }] });

beforeAll(async () => {
  const school = await newSchool();
  const teacher = await newUser(school, 'teacher');
  owner = await newUser(school, 'student');
  co = await newCompany(owner, await newClassroom(school, teacher, [owner]));
  const prof = await ok('GET', `/companies/${co}/profile`);
  await ok('PATCH', `/companies/${co}/profile`, { version: prof.version, taxId: taxId(9901) });
  await ok('POST', `/companies/${co}/parties`, { code: 'C1', name: 'ร้าน ลูกค้าหนึ่ง', isCustomer: true, isVendor: false });
  await ok('POST', `/companies/${co}/parties`, { code: 'V1', name: 'ร้าน ผู้ขายหนึ่ง', isCustomer: false, isVendor: true });
  await ok('POST', `/companies/${co}/items`, { code: 'F', name: 'ไส้กรอง FIFO', unit: 'ชิ้น', isService: false, trackInventory: true, costMethod: 'fifo' });
  await ok('POST', `/companies/${co}/items`, { code: 'A', name: 'ไส้กรองถัวเฉลี่ย', unit: 'ชิ้น', isService: false, trackInventory: true });
});

describe('FIFO: ชั้นต้นทุนเก่าสุดออกก่อน · ลงย้อนวันที่คำนวณใหม่ · รับคืน/ส่งคืน', () => {
  it('ซื้อ 10 × 100 และ 10 × 130 → ขาย 15: ต้นทุน = 10 × 100 + 5 × 130 = 1,650 (ถัวเฉลี่ยจะได้ 1,725)', async () => {
    await buy('2026-03-01', 'B-1', '10', '100');
    await buy('2026-03-05', 'B-2', '10', '130');
    const iv = await sell('2026-03-10', '15');
    const cg = await db.query(`select sum(l.debit)::numeric(18,2)::text v from acc.journal_lines l join acc.chart_of_accounts a on a.company_id = l.company_id and a.id = l.account_id
                                join acc.inventory_document_posts p on p.company_id = l.company_id and p.entry_id = l.entry_id
                               where p.company_id = $1 and p.source_id = $2 and a.code = '5130'`, [co, iv.id]);
    expect(cg.rows[0].v).toBe('1650.00');
    const inv = await ok('GET', `/companies/${co}/inventory/F`);
    expect([inv.item.method, inv.layers]).toEqual(['fifo', [{ date: '2026-03-05', qty: '5.000', value: '650.00' }]]);
  });

  it('ซื้อ 10 × 160 แล้วตรวจนับขาด 7: ตัดชั้น 5 × 130 + 2 × 160 = 970', async () => {
    await buy('2026-03-12', 'B-3', '10', '160');
    await ok('POST', `/companies/${co}/inventory/adjustments`, { itemCode: 'F', date: '2026-03-15', quantity: '-7', offsetAccount: '5130', description: 'ตรวจนับขาด' });
    expect((await card('F')).at(-1)).toEqual(['03-15', '-7', '-970.00']);
  });

  it('ลงซื้อย้อนวันที่ 03 มี.ค. 5 × 90: ขายวันที่ 10 คิดใหม่ 10 × 100 + 5 × 90 = 1,450 · ตรวจนับขาดคิดใหม่ 7 × 130 = 910', async () => {
    await buy('2026-03-03', 'B-0', '5', '90');
    expect(await card('F')).toEqual([
      ['03-01', '10', '1000.00'], ['03-03', '5', '450.00'], ['03-05', '10', '1300.00'], ['03-10', '-15', '-1450.00'],
      ['03-12', '10', '1600.00'], ['03-15', '-7', '-910.00']]);
    expect(await gl1310()).toBe('1990.00');
    expect((await db.query(`select count(*)::int n from acc.inventory_restatements where company_id = $1`, [co])).rows[0].n).toBe(2);
  });

  it('รับคืน 2 ชิ้นจากใบขายวันที่ 10 = ต้นทุนต่อหน่วยของใบนั้น 96.666667 → 193.33 · ส่งคืนผู้ขาย 1 ชิ้น 160 (ชั้นเก่าสุดลดจำนวน ส่วนต่าง 30 ปรับเข้าชั้นนั้น)', async () => {
    const iv = (await db.query(`select id from acc.documents where company_id = $1 and doc_no = 'IV-0001'`, [co])).rows[0].id;
    await ok('POST', `/companies/${co}/sales/credit-note`, { date: '2026-03-20', refDocumentId: iv, reason: 'ลูกค้าคืนของ', lines: [{ itemCode: 'F', qty: '2.000', unitPrice: '300' }] });
    const pi = (await db.query(`select id from acc.purchase_documents where company_id = $1 and vendor_doc_no = 'B-3'`, [co])).rows[0].id;
    await ok('POST', `/companies/${co}/purchases/credit-note`, { date: '2026-03-22', refDocumentId: pi, vendorDocNo: 'CN-1', reason: 'ของชำรุด',
      lines: [{ itemCode: 'F', qty: '1.000', unitPrice: '160' }] });
    const inv = await ok('GET', `/companies/${co}/inventory/F`);
    expect(inv.layers).toEqual([
      { date: '2026-03-05', qty: '2.000', value: '230.00' }, { date: '2026-03-12', qty: '10.000', value: '1600.00' }, { date: '2026-03-20', qty: '2.000', value: '193.33' }]);
  });

  it('ขาย 3 ชิ้น: 2 ชิ้นชั้น 05 มี.ค. (230) + 1 ชิ้นชั้น 12 มี.ค. (160) = 390 · คงเหลือ 11 ชิ้น 1,633.33 = บัญชี 1310', async () => {
    await sell('2026-03-25', '3');
    expect((await card('F')).slice(-3)).toEqual([['03-20', '2', '193.33'], ['03-22', '-1', '-160.00'], ['03-25', '-3', '-390.00']]);
    const inv = await ok('GET', `/companies/${co}/inventory/F`);
    expect(inv.layers).toEqual([{ date: '2026-03-12', qty: '9.000', value: '1440.00' }, { date: '2026-03-20', qty: '2.000', value: '193.33' }]);
    expect(await gl1310()).toBe('1633.33');
    const list = await ok('GET', `/companies/${co}/inventory`);
    expect(list.items.find((x: { code: string }) => x.code === 'F')).toMatchObject({ quantity: '11.000', value: '1633.33', method: 'fifo' });
  });

  it('ยกเลิกใบซื้อย้อนวันที่ → กลับไปเหมือนไม่เคยลง: ขายวันที่ 10 กลับเป็น 1,650', async () => {
    const pi = (await db.query(`select id from acc.purchase_documents where company_id = $1 and vendor_doc_no = 'B-0'`, [co])).rows[0].id;
    await ok('POST', `/companies/${co}/purchases/documents/${pi}/void`, { date: '2026-03-31', reason: 'ลงผิด' });
    expect((await card('F')).find((x) => x[0] === '03-10')).toEqual(['03-10', '-15', '-1650.00']);
    // ชั้นทั้งหมด = บัญชี 1310 (สินค้า A ยังไม่เคลื่อนไหว)
    const inv = await ok('GET', `/companies/${co}/inventory/F`);
    const sum = inv.layers.reduce((s: number, l: { value: string }) => s + Math.round(Number(l.value) * 100), 0) / 100;
    expect(sum.toFixed(2)).toBe(await gl1310());
  });

  it('เปลี่ยนวิธีของสินค้าที่เคลื่อนไหวแล้วไม่ได้ · วิธีของบริษัทเปลี่ยนได้จนกว่าสินค้าที่ใช้วิธีนั้นจะเคลื่อนไหว', async () => {
    const f = (await ok('GET', `/companies/${co}/items`)).find((x: { code: string }) => x.code === 'F');
    const r = await call('PATCH', `/companies/${co}/items/F`, { version: f.version, costMethod: 'average' });
    expect([r.statusCode, r.json().message]).toEqual([422, 'สินค้า F มีความเคลื่อนไหวในบัตรสต็อกแล้ว เปลี่ยนวิธีคิดต้นทุนไม่ได้']);
    await ok('PUT', `/companies/${co}/inventory/method`, { method: 'fifo' });
    expect((await ok('GET', `/companies/${co}/inventory`)).items.find((x: { code: string }) => x.code === 'A').method).toBe('fifo');
    await ok('POST', `/companies/${co}/inventory/adjustments`, { itemCode: 'A', date: '2026-04-01', quantity: '1', unitCost: '50', offsetAccount: '3110' });
    const again = await call('PUT', `/companies/${co}/inventory/method`, { method: 'average' });
    expect(again.statusCode).toBe(422);
  });
});
