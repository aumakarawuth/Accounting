import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../apps/api/src/app';
import { devAuth } from '../apps/api/src/auth';
import { authConfigFromEnv } from '../apps/api/src/config';
import { createPool } from '../apps/api/src/db';
import { apiUrl } from './global-setup';
import { pool as db, newSchool, newUser, newClassroom, newCompany, taxId } from './helpers';
import { dailyCumulative, lifeDays } from '../apps/web/lib/depreciation';
import { fromCents } from '../apps/web/lib/money';

// ค่าเสื่อมราคาตามจำนวนวัน + ภาษีขายเมื่อบริษัทจด VAT ขายสินทรัพย์ (docs/phase5-spec.md ข้อ 10) เฉลยคิดมือรายบรรทัด
// รถ VAN: ทุน 36,500 ซาก 0 ได้มา 15 มี.ค. 2569 อายุ 12 เดือน = 15 มี.ค. 2569 – 14 มี.ค. 2570 = 365 วัน → วันละ 100.00
const apiPool = createPool(apiUrl());
const app = buildApp({ pool: apiPool, auth: devAuth(), cfg: { ...authConfigFromEnv({}), allowedOrigins: false } });
afterAll(async () => { await app.close(); await apiPool.end(); await db.end(); });

let owner: string;
let co: string;
const call = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as object, headers: { 'x-dev-user-id': owner, 'x-dev-role': 'student', 'idempotency-key': randomUUID() } });
async function ok(method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) {
  const r = await call(method, url, payload);
  if (r.statusCode >= 300) throw new Error(`${method} ${url} → ${r.statusCode} ${r.body}`);
  return r.json();
}
const api = (p: string) => `/companies/${co}${p}`;
async function lines(entryId: string) {
  const r = await db.query(
    `select a.code, l.debit::text, l.credit::text from acc.journal_lines l join acc.chart_of_accounts a on a.company_id = l.company_id and a.id = l.account_id
      where l.company_id = $1 and l.entry_id = $2 order by l.line_no`, [co, entryId]);
  return r.rows.map((x) => [x.code, x.debit, x.credit]);
}
const assets = async (month: string) => Object.fromEntries((await ok('GET', api(`/fixed-assets?month=${month}`))).assets
  .map((a: { code: string }) => [a.code, a]));
const balance = async (code: string) =>
  (await db.query(`select acc.account_movement($1, $2, '2026-01-01', '2026-12-31')::numeric(18,2)::text v`, [co, code])).rows[0].v as string;

beforeAll(async () => {
  const school = await newSchool();
  const teacher = await newUser(school, 'teacher');
  owner = await newUser(school, 'student');
  co = await newCompany(owner, await newClassroom(school, teacher, [owner]));
  const prof = await ok('GET', api('/profile'));
  await ok('PATCH', api('/profile'), { version: prof.version, taxId: taxId(9301), vatRegistered: true });
  await ok('POST', api('/parties'), { code: 'C1', name: 'บริษัท ผู้ซื้อรถ จำกัด', isCustomer: true, isVendor: false, taxId: taxId(9302) });
  await ok('POST', api('/journal'), { date: '2026-01-02', description: 'ลงทุน',
    lines: [{ account_code: '1120', debit: '100000' }, { account_code: '3110', credit: '100000' }] });
});

describe('ค่าเสื่อมราคาตามจำนวนวัน', () => {
  it('ลงทะเบียนรายวัน: เริ่มคิดเดือนที่ได้มาเสมอ (ไม่สนเดือนเริ่มที่ส่งมา) · 13 งวด (มี.ค. 2569 – มี.ค. 2570)', async () => {
    await ok('POST', api('/fixed-assets'), { code: 'VAN', name: 'รถตู้', acquiredDate: '2026-03-15', depStart: '2026-04', cost: '36500',
      lifeMonths: 12, depMethod: 'daily', assetAccount: '1620', accumAccount: '1621', counterAccount: '1120' });
    // ได้มา 31 ม.ค. อายุ 1 เดือน = ถึง 27 ก.พ. = 28 วัน (31 ม.ค. + 1 เดือน = 28 ก.พ.)
    await ok('POST', api('/fixed-assets'), { code: 'PC', name: 'เครื่องพิมพ์', acquiredDate: '2026-01-31', cost: '1000', lifeMonths: 1,
      depMethod: 'daily', assetAccount: '1630', accumAccount: '1631', counterAccount: '1120' });
    const a = await assets('2026-03');
    expect([a.VAN.depMethod, a.VAN.depStart, a.VAN.totalMonths, a.VAN.monthly, a.VAN.nextMonth]).toEqual(['daily', '2026-03', 13, null, '2026-03']);
    expect([a.PC.totalMonths, a.PC.nextMonth]).toEqual([2, '2026-01']);
  });

  it('ม.ค. 1 วัน = ปัด(1,000 × 1/28) = 35.71 · ก.พ. ส่วนที่เหลือ 964.29 รวมพอดี 1,000', async () => {
    const jan = await ok('POST', api('/depreciation'), { month: '2026-01' });
    expect(await lines(jan.entryId)).toEqual([['5250', '35.71', '0.00'], ['1631', '0.00', '35.71']]);
    const feb = await ok('POST', api('/depreciation'), { month: '2026-02' });
    expect(await lines(feb.entryId)).toEqual([['5250', '964.29', '0.00'], ['1631', '0.00', '964.29']]);
    const a = await assets('2026-02');
    expect([a.PC.status, a.PC.accumulated, a.PC.bookValue, a.PC.monthsPosted]).toEqual(['fully_depreciated', '1000.00', '0.00', 2]);
  });

  it('มี.ค. 17 วัน (15–31) = 1,700 · เม.ย. 30 วัน = 3,000 · พ.ค. 31 วัน = 3,100', async () => {
    const expected: [string, string][] = [['2026-03', '1700.00'], ['2026-04', '3000.00'], ['2026-05', '3100.00']];
    for (const [month, amt] of expected) {
      const r = await ok('POST', api('/depreciation'), { month });
      expect(await lines(r.entryId)).toEqual([['5250', amt, '0.00'], ['1621', '0.00', amt]]);
    }
    const a = await assets('2026-05');
    expect([a.VAN.accumulated, a.VAN.bookValue, a.VAN.depThisMonth]).toEqual(['7800.00', '28700.00', '3100.00']);
    expect(await balance('1621')).toBe('-7800.00');
  });
});

describe('ขายสินทรัพย์ของบริษัทจด VAT', () => {
  let disposal: string;

  it('ต้องระบุผู้ซื้อเพราะต้องออกใบกำกับภาษี', async () => {
    const r = await call('POST', api(`/fixed-assets/${(await assets('2026-06')).VAN.id}/dispose`),
      { date: '2026-06-10', proceeds: '30000', proceedsAccount: '1120' });
    expect([r.statusCode, r.json().message]).toEqual([400, 'ขายสินทรัพย์ต้องออกใบกำกับภาษี ระบุผู้ซื้อ']);
  });

  it('ขาย 10 มิ.ย. 30,000 + VAT 2,100: ค่าเสื่อม 1–9 มิ.ย. 900 · สะสม 8,700 · ตามบัญชี 27,800 · กำไร 2,200', async () => {
    const d = await ok('POST', api(`/fixed-assets/${(await assets('2026-06')).VAN.id}/dispose`),
      { date: '2026-06-10', proceeds: '30000', proceedsAccount: '1120', partyCode: 'C1' });
    disposal = d.id;
    expect([d.docNo, d.vat, d.finalDepreciation, d.gainLoss]).toEqual(['FD-0001', '2100.00', '900.00', '2200.00']);
    // เดบิต 7,800 + 900 + 32,100 = 40,800 · เครดิต 36,500 + 2,100 + 2,200 = 40,800
    expect(await lines(d.entryId)).toEqual([
      ['1621', '7800.00', '0.00'], ['5250', '900.00', '0.00'], ['1120', '32100.00', '0.00'],
      ['1620', '0.00', '36500.00'], ['2210', '0.00', '2100.00'], ['4330', '0.00', '2200.00']]);
    expect([await balance('1620'), await balance('1621'), await balance('2210')]).toEqual(['0.00', '0.00', '-2100.00']);
    const a = await assets('2026-06');
    expect([a.VAN.status, a.VAN.accumulated, a.VAN.depThisMonth, a.VAN.bookValue, a.VAN.disposalVat]).toEqual(['disposed', '8700.00', '900.00', '0.00', '2100.00']);
    // ขายแล้วไม่ลงค่าเสื่อมเดือน มิ.ย. ซ้ำ
    expect((await call('POST', api('/depreciation'), { month: '2026-06' })).statusCode).toBe(409);
  });

  it('รายงานภาษีขาย มิ.ย.: ใบกำกับภาษี FD-0001 ผู้ซื้อตามทะเบียน · ภ.พ.30 ภาษีขาย 2,100', async () => {
    const vat = await ok('GET', api('/tax/vat?month=2026-06'));
    expect(vat.sales.map((r: { docNo: string; kind: string; partyName: string; partyTaxId: string; base: string; vat: string; status: string }) =>
      [r.docNo, r.kind, r.partyName, r.partyTaxId, r.base, r.vat, r.status]))
      .toEqual([['FD-0001', 'asset_sale', 'บริษัท ผู้ซื้อรถ จำกัด', taxId(9302), '30000.00', '2100.00', 'normal']]);
    expect(vat.preview.outputVat).toBe('2100.00');
  });

  it('ยกเลิกการขายในเดือนเดียวกัน: กลับรายการทั้งใบ ภาษีขายเป็น 0 · สินทรัพย์กลับมาลงค่าเสื่อมต่อได้', async () => {
    await ok('POST', api(`/asset-disposals/${disposal}/void`), { date: '2026-06-20', reason: 'ผู้ซื้อยกเลิก' });
    expect([await balance('2210'), await balance('1621'), await balance('4330')]).toEqual(['0.00', '-7800.00', '0.00']);
    const vat = await ok('GET', api('/tax/vat?month=2026-06'));
    expect(vat.sales.map((r: { base: string; vat: string; status: string }) => [r.base, r.vat, r.status])).toEqual([['0', '0', 'voided']]); // แถวที่ยกเลิกในเดือนเดียวกันแสดง 0 แบบเอกสารขายอื่น
    // มิ.ย. 30 วัน = 3,000 (ค่าเสื่อมถึงวันจำหน่าย 900 ถูกกลับรายการไปพร้อมใบ)
    const r = await ok('POST', api('/depreciation'), { month: '2026-06' });
    expect(await lines(r.entryId)).toEqual([['5250', '3000.00', '0.00'], ['1621', '0.00', '3000.00']]);
  });
});

describe('สูตรรายวัน SQL = TypeScript (ตัวอย่างบนฟอร์ม)', () => {
  it('สุ่ม 300 กรณี: วันทั้งอายุและยอดสะสมตรงกันทุกสตางค์ รวมปลายเดือน (31 ม.ค. + 1 เดือน) และปีอธิกสุรทิน', async () => {
    let seed = 20261114;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    const cases = Array.from({ length: 300 }, () => {
      const acquired = new Date(Date.UTC(2024, 0, 1 + rnd(1500))).toISOString().slice(0, 10);
      const life = 1 + rnd(60);
      const cost = BigInt(1 + rnd(5_000_000)); const salvage = BigInt(rnd(Number(cost)));
      const through = new Date(Date.UTC(2024, 0, 1 + rnd(3500))).toISOString().slice(0, 10);
      return { acquired, life, cost, salvage, through };
    });
    const r = await db.query(
      `select ((c->>'acquired')::date + make_interval(months => (c->>'life')::int))::date - (c->>'acquired')::date as days,
              app.daily_depreciation_cum((c->>'cost')::numeric, (c->>'salvage')::numeric, (c->>'acquired')::date, (c->>'life')::int,
                                         (c->>'through')::date)::text as cum
         from jsonb_array_elements($1::jsonb) with ordinality x(c, i) order by i`,
      [JSON.stringify(cases.map((c) => ({ ...c, cost: fromCents(c.cost), salvage: fromCents(c.salvage) })))]);
    expect(r.rows.map((x) => [x.days, x.cum])).toEqual(cases.map((c) =>
      [lifeDays(c.acquired, c.life), fromCents(dailyCumulative(c.cost, c.salvage, c.acquired, c.life, c.through))]));
  });
});
