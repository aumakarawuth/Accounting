import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../apps/api/src/app';
import { devAuth } from '../apps/api/src/auth';
import { authConfigFromEnv } from '../apps/api/src/config';
import { createPool } from '../apps/api/src/db';
import { apiUrl } from './global-setup';
import { pool as db, newSchool, newUser, newClassroom, newCompany, taxId } from './helpers';

// หลายคลัง + โอนย้าย (docs/phase5-spec.md ข้อ 8) เฉลยคิดมือ: บริษัทไม่จด VAT ต้นทุนถัวเฉลี่ยรวมทั้งบริษัท จำนวนแยกคลัง
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
const stock = async () => Object.fromEntries((await ok('GET', `/companies/${co}/inventory`)).stock
  .map((s: { warehouse: string; qty: string }) => [s.warehouse, s.qty]));
const gl1310 = async () => (await db.query(`select acc.account_movement($1, '1310', '2026-01-01', '2026-12-31')::numeric(18,2)::text v`, [co])).rows[0].v;
const entries = async () => (await db.query('select count(*)::int n from acc.journal_entries where company_id = $1', [co])).rows[0].n as number;

beforeAll(async () => {
  const school = await newSchool();
  const teacher = await newUser(school, 'teacher');
  owner = await newUser(school, 'student');
  co = await newCompany(owner, await newClassroom(school, teacher, [owner]));
  const prof = await ok('GET', `/companies/${co}/profile`);
  await ok('PATCH', `/companies/${co}/profile`, { version: prof.version, taxId: taxId(9951) });
  await ok('POST', `/companies/${co}/parties`, { code: 'C1', name: 'ร้าน ลูกค้าหนึ่ง', isCustomer: true, isVendor: false });
  await ok('POST', `/companies/${co}/parties`, { code: 'V1', name: 'ร้าน ผู้ขายหนึ่ง', isCustomer: false, isVendor: true });
  await ok('POST', `/companies/${co}/items`, { code: 'P', name: 'ไส้กรอง', unit: 'ชิ้น', isService: false, trackInventory: true });
});

describe('หลายคลัง: จำนวนแยกคลัง ต้นทุนรวมทั้งบริษัท · โอนย้ายไม่ลงบัญชี', () => {
  let tr: string;

  it('เพิ่มคลัง BKK → มีคลังหลัก MAIN ให้อัตโนมัติ · รหัสซ้ำไม่ได้', async () => {
    await ok('POST', `/companies/${co}/warehouses`, { code: 'BKK', name: 'คลังกรุงเทพ' });
    expect((await ok('GET', `/companies/${co}/warehouses`)).map((w: { code: string; isMain: boolean }) => [w.code, w.isMain]))
      .toEqual([['MAIN', true], ['BKK', false]]);
    expect((await call('POST', `/companies/${co}/warehouses`, { code: 'BKK', name: 'ซ้ำ' })).statusCode).toBe(409);
  });

  it('ซื้อ 10 × 100 เข้าคลังหลัก และ 5 × 130 เข้า BKK: ต้นทุนเฉลี่ยรวม 1,650 / 15 = 110', async () => {
    await ok('POST', `/companies/${co}/purchases/invoice`, { date: '2026-05-01', partyCode: 'V1', vendorDocNo: 'B-1', lines: [{ itemCode: 'P', qty: '10', unitPrice: '100' }] });
    const pi = await ok('POST', `/companies/${co}/purchases/invoice`, { date: '2026-05-02', partyCode: 'V1', vendorDocNo: 'B-2', warehouse: 'BKK',
      lines: [{ itemCode: 'P', qty: '5', unitPrice: '130' }] });
    expect(await stock()).toEqual({ MAIN: '10.000', BKK: '5.000' });
    expect((await ok('GET', `/companies/${co}/purchases/documents/${pi.id}`)).warehouse).toBe('BKK คลังกรุงเทพ');
  });

  it('ขายจาก BKK 6 ชิ้นไม่ได้ (มี 5) · ขาย 4 ชิ้นได้ ต้นทุน 4 × 110 = 440 ตามเฉลี่ยรวม', async () => {
    const over = await call('POST', `/companies/${co}/sales/invoice`, { date: '2026-05-03', partyCode: 'C1', warehouse: 'BKK',
      lines: [{ itemCode: 'P', qty: '6', unitPrice: '300' }] });
    expect(over.json().message).toBe('สินค้า ไส้กรอง ใน คลังกรุงเทพ (BKK) คงเหลือ ณ สิ้นวันที่ 03/05/2569 ติดลบ (-1.000) ตรวจคลังที่เลือกหรือโอนย้ายก่อน');
    await ok('POST', `/companies/${co}/sales/invoice`, { date: '2026-05-03', partyCode: 'C1', warehouse: 'BKK', lines: [{ itemCode: 'P', qty: '4', unitPrice: '300' }] });
    expect(await stock()).toEqual({ MAIN: '10.000', BKK: '1.000' });
    expect(await gl1310()).toBe('1210.00');
  });

  it('โอน 3 ชิ้น MAIN → BKK: เลขที่ TR ไม่ลงบัญชี มูลค่า 1310 เท่าเดิม', async () => {
    const before = await entries();
    const t = await ok('POST', `/companies/${co}/inventory/transfers`, { date: '2026-05-04', from: 'MAIN', to: 'BKK', lines: [{ itemCode: 'P', qty: '3' }] });
    tr = t.id;
    expect([t.docNo, t.from, t.to, t.lines]).toEqual(['TR-0001', 'MAIN', 'BKK', [{ itemCode: 'P', name: 'ไส้กรอง', unit: 'ชิ้น', qty: '3.000' }]]);
    expect(await entries()).toBe(before);
    expect(await stock()).toEqual({ MAIN: '7.000', BKK: '4.000' });
    expect(await gl1310()).toBe('1210.00');
    const over = await call('POST', `/companies/${co}/inventory/transfers`, { date: '2026-05-04', from: 'BKK', to: 'MAIN', lines: [{ itemCode: 'P', qty: '5' }] });
    expect(over.json().code).toBe('ACC15');
  });

  it('รับคืน 1 ชิ้นจากใบขาย BKK (ไม่เลือกคลัง) → เข้า BKK ตามใบที่อ้าง · ตรวจนับขาดในคลังหลัก 2 ชิ้น', async () => {
    const iv = (await db.query(`select id from acc.documents where company_id = $1 and doc_no = 'IV-0001'`, [co])).rows[0].id;
    await ok('POST', `/companies/${co}/sales/credit-note`, { date: '2026-05-05', refDocumentId: iv, reason: 'คืน', lines: [{ itemCode: 'P', qty: '1', unitPrice: '300' }] });
    await ok('POST', `/companies/${co}/inventory/adjustments`, { itemCode: 'P', date: '2026-05-06', quantity: '-2', offsetAccount: '5130', warehouse: 'MAIN' });
    expect(await stock()).toEqual({ MAIN: '5.000', BKK: '5.000' });
    // 1,210 + 110 (รับคืน) − 220 (ตัดขาด 2 × 110) = 1,100 = 10 ชิ้น × 110
    expect(await gl1310()).toBe('1100.00');
  });

  it('ยกเลิกการโอนที่ทำให้ BKK ติดลบไม่ได้ · ปิดคลังที่ยังมีของ/คลังหลักไม่ได้', async () => {
    await ok('POST', `/companies/${co}/sales/invoice`, { date: '2026-05-07', partyCode: 'C1', warehouse: 'BKK', lines: [{ itemCode: 'P', qty: '4', unitPrice: '300' }] });
    const cancel = await call('POST', `/companies/${co}/inventory/transfers/${tr}/cancel`, { reason: 'โอนผิด' });
    expect([cancel.statusCode, cancel.json().code]).toEqual([422, 'ACC15']);
    expect((await call('PATCH', `/companies/${co}/warehouses/BKK`, { active: false })).json().message).toBe('คลังกรุงเทพ ยังมีสินค้าคงเหลือ โอนย้ายออกก่อนปิดใช้');
    expect((await call('PATCH', `/companies/${co}/warehouses/MAIN`, { active: false })).json().message).toBe('คลังหลักปิดใช้ไม่ได้');
    expect(await stock()).toEqual({ MAIN: '5.000', BKK: '1.000' });
  });

  it('โอนของที่เหลือออกแล้วปิดคลังได้ · เลือกคลังที่ปิดแล้วไม่ได้', async () => {
    await ok('POST', `/companies/${co}/inventory/transfers`, { date: '2026-05-08', from: 'BKK', to: 'MAIN', lines: [{ itemCode: 'P', qty: '1' }] });
    expect((await ok('PATCH', `/companies/${co}/warehouses/BKK`, { active: false })).active).toBe(false);
    const r = await call('POST', `/companies/${co}/purchases/invoice`, { date: '2026-05-09', partyCode: 'V1', vendorDocNo: 'B-3', warehouse: 'BKK',
      lines: [{ itemCode: 'P', qty: '1', unitPrice: '100' }] });
    expect([r.statusCode, r.json().message]).toEqual([422, 'ไม่พบคลังรหัส BKK ที่เปิดใช้']);
    expect(await stock()).toEqual({ MAIN: '6.000' });
  });
});
