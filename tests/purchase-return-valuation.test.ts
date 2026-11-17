import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../apps/api/src/app';
import { devAuth } from '../apps/api/src/auth';
import { authConfigFromEnv } from '../apps/api/src/config';
import { createPool } from '../apps/api/src/db';
import { apiUrl } from './global-setup';
import { pool as db, newSchool, newUser, newClassroom, newCompany, taxId } from './helpers';

// ส่งคืนผู้ขายกับมูลค่าคงเหลือ (migration 20261114000117): ส่งคืนจนหมด = ตัดมูลค่าที่เหลือทั้งหมด ·
// ลงย้อนวันที่จนมูลค่า ณ วันส่งคืนไม่พอ = ปฏิเสธ (เดิม 1310 ติดลบหรือ error 500) เฉลยคิดมือในชื่อแต่ละข้อ
const apiPool = createPool(apiUrl());
const app = buildApp({ pool: apiPool, auth: devAuth(), limiter: { hit: async () => 0 }, cfg: { ...authConfigFromEnv({}), allowedOrigins: false } });
afterAll(async () => { await app.close(); await apiPool.end(); await db.end(); });

let seq = 7700;
async function company(method: 'average' | 'fifo') {
  const school = await newSchool();
  const owner = await newUser(school, 'student');
  const co = await newCompany(owner, await newClassroom(school, await newUser(school, 'teacher'), [owner]));
  const call = (m: string, url: string, payload?: unknown) => app.inject({ method: m as 'POST', url: `/companies/${co}${url}`, payload: payload as object,
    headers: { 'x-dev-user-id': owner, 'x-dev-role': 'student', 'idempotency-key': randomUUID() } });
  const ok = async (m: string, url: string, payload?: unknown) => { const r = await call(m, url, payload); if (r.statusCode >= 300) throw new Error(`${url} ${r.statusCode} ${r.body}`); return r.json(); };
  const prof = await ok('GET', '/profile');
  await ok('PATCH', '/profile', { version: prof.version, taxId: taxId(++seq) });
  await ok('POST', '/parties', { code: 'C1', name: 'ลูกค้า', isCustomer: true, isVendor: false });
  await ok('POST', '/parties', { code: 'V1', name: 'ผู้ขาย', isCustomer: false, isVendor: true });
  await ok('POST', '/items', { code: 'X', name: 'สินค้า', unit: 'ชิ้น', isService: false, trackInventory: true, costMethod: method });
  const card = async () => (await db.query(`select m.movement_date::text d, m.quantity::numeric(14,0)::text q, m.eff_value::numeric(18,2)::text v
      from acc.inventory_movements_effective m where m.company_id = $1 and m.live order by m.movement_date, m.created_at`, [co])).rows.map((r) => [r.d.slice(5), r.q, r.v]);
  const gl = async (code: string) => (await db.query(`select acc.account_movement($1, $2, null, '2026-12-31')::numeric(18,2)::text v`, [co, code])).rows[0].v;
  const gl1310 = () => gl('1310');
  const buy = (date: string, no: string, qty: string, price: string) => ok('POST', '/purchases/invoice', { date, partyCode: 'V1', vendorDocNo: no, lines: [{ itemCode: 'X', qty, unitPrice: price }] });
  const ret = (date: string, pi: string, qty: string, price: string) => call('POST', '/purchases/credit-note', { date, partyCode: 'V1', refDocumentId: pi, vendorDocNo: `CN${randomUUID().slice(0, 4)}`, reason: 'คืน', lines: [{ itemCode: 'X', qty, unitPrice: price }] });
  const sell = (date: string, qty: string) => call('POST', '/sales/invoice', { date, partyCode: 'C1', lines: [{ itemCode: 'X', qty, unitPrice: '300' }] });
  return { co, ok, call, card, gl, gl1310, buy, ret, sell };
}

describe('ส่งคืนผู้ขาย × ลงย้อนวันที่', () => {
  // ถัวเฉลี่ย: ซื้อ 5@200 + 5@50 = 1,250 (เฉลี่ย 125) · ขาย 5 = 625 เหลือ 5 ชิ้น 625
  it('average: ส่งคืนใบหลัง 5 ชิ้น (ใบลดหนี้ 250) จนเหลือ 0 → ตัดมูลค่าที่เหลือทั้งหมด 625 ส่วนต่าง 375 อยู่ใน 5140', async () => {
    const t = await company('average');
    await t.buy('2026-03-01', 'A', '5', '200');
    const b = await t.buy('2026-03-02', 'B', '5', '50');
    expect((await t.sell('2026-03-03', '5')).statusCode).toBe(201);
    expect((await t.ret('2026-03-05', b.id, '5', '50')).statusCode).toBe(201);
    expect(await t.card()).toEqual([['03-01', '5', '1000.00'], ['03-02', '5', '250.00'], ['03-03', '-5', '-625.00'], ['03-05', '-5', '-625.00']]);
    expect(await t.gl1310()).toBe('0.00');
    expect(await t.gl('5140')).toBe('375.00'); // ใบลดหนี้ Cr 250 + ตัดออกจากคลัง Dr 625
  });
  // FIFO: ซื้อ 5@50 + 5@200 · ขาย 5 ใช้ชั้นแรก 250 เหลือชั้น 5@200 = 1,000 · ส่งคืนใบแรก 5 ชิ้น (ใบลดหนี้ 250) จนเหลือ 0 → ตัด 1,000
  it('fifo: ส่งคืนจนเหลือ 0 → ตัดมูลค่าที่เหลือทั้งหมด 1,000 ไม่ค้างใน 1310', async () => {
    const t = await company('fifo');
    const a = await t.buy('2026-03-01', 'A', '5', '50');
    await t.buy('2026-03-02', 'B', '5', '200');
    expect((await t.sell('2026-03-03', '5')).statusCode).toBe(201);
    expect((await t.ret('2026-03-05', a.id, '5', '50')).statusCode).toBe(201);
    expect(await t.card()).toEqual([['03-01', '5', '250.00'], ['03-02', '5', '1000.00'], ['03-03', '-5', '-250.00'], ['03-05', '-5', '-1000.00']]);
    expect(await t.gl1310()).toBe('0.00');
  });
  for (const method of ['average', 'fifo'] as const) {
    // ส่งคืนใบแรก 4 ชิ้น 800 วันที่ 5 (มูลค่าตอนนั้น 1,250 ผ่าน) แล้วลงขาย 5 ชิ้นย้อนวันที่ 3: มูลค่า ณ วันที่ 5 เหลือ 625 (ถัวเฉลี่ย) / 250 (FIFO) < 800
    it(`${method}: ขายย้อนวันที่ก่อนวันส่งคืนจนมูลค่าไม่พอ → ปฏิเสธ (เดิม 1310 ติดลบ)`, async () => {
      const t = await company(method);
      const a = await t.buy('2026-03-01', 'A', '5', '200');
      await t.buy('2026-03-02', 'B', '5', '50');
      expect((await t.ret('2026-03-05', a.id, '4', '200')).statusCode).toBe(201);
      const s = await t.sell('2026-03-03', '5');
      expect([s.statusCode, s.json().message]).toEqual([422, `ส่งคืนสินค้า สินค้า ตาม PN-0001 มูลค่า 800.00 เกินมูลค่าคงเหลือ ณ วันที่ 05/03/2569${method === 'average' ? ' (625.00)' : ''} ตรวจรายการที่ลงย้อนวันที่ก่อนวันส่งคืน`]);
      expect(await t.card()).toEqual([['03-01', '5', '1000.00'], ['03-02', '5', '250.00'], ['03-05', '-4', '-800.00']]);
      expect(await t.gl1310()).toBe('450.00');
    });
  }
  // ถัวเฉลี่ย: ส่งคืนจนหมดแล้วลงซื้อย้อนวันที่ก่อนวันส่งคืน → ใบส่งคืนไม่ใช่ใบสุดท้ายแล้ว กลับไปใช้มูลค่าตามใบลดหนี้
  it('average: ส่งคืนที่เคยตัดหมด (625) แล้วลงซื้อย้อนวันที่ 1@100 → ส่งคืนกลับเป็น 250 ตามใบลดหนี้ · คงเหลือ 1 ชิ้น 475', async () => {
    const t = await company('average');
    await t.buy('2026-03-01', 'A', '5', '200');
    const b = await t.buy('2026-03-02', 'B', '5', '50');
    expect((await t.sell('2026-03-03', '5')).statusCode).toBe(201);
    expect((await t.ret('2026-03-05', b.id, '5', '50')).statusCode).toBe(201);
    await t.buy('2026-03-04', 'C', '1', '100');
    expect(await t.card()).toEqual([['03-01', '5', '1000.00'], ['03-02', '5', '250.00'], ['03-03', '-5', '-625.00'], ['03-04', '1', '100.00'], ['03-05', '-5', '-250.00']]);
    expect(await t.gl1310()).toBe('475.00');
  });
});
