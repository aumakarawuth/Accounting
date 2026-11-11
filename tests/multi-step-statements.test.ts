import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../apps/api/src/app';
import { devAuth } from '../apps/api/src/auth';
import { authConfigFromEnv } from '../apps/api/src/config';
import { createPool } from '../apps/api/src/db';
import { apiUrl } from './global-setup';
import { pool as db, newSchool, newUser, newClassroom, newCompany, taxId } from './helpers';

// งบการเงินหลายขั้น + แยกหมุนเวียน/ไม่หมุนเวียน (docs/phase5-spec.md ข้อ 2)
// เฉลยคิดด้วยมือล่วงหน้า เทียบทุกบรรทัด
const apiPool = createPool(apiUrl());
const app = buildApp({ pool: apiPool, auth: devAuth(), cfg: { ...authConfigFromEnv({}), allowedOrigins: false } });
afterAll(async () => { await app.close(); await apiPool.end(); await db.end(); });

type Method = 'GET' | 'POST' | 'PATCH';
let owner: string;
const call = (method: Method, url: string, payload?: unknown, key = randomUUID()) =>
  app.inject({ method, url, payload: payload as object, headers: { 'x-dev-user-id': owner, 'x-dev-role': 'student', 'idempotency-key': key } });
async function ok(method: Method, url: string, payload?: unknown, key?: string) {
  const r = await call(method, url, payload, key);
  if (r.statusCode >= 300) throw new Error(`${method} ${url} → ${r.statusCode} ${r.body}`);
  return r.json();
}
type L = [string, string, string]; // [บัญชี, เดบิต, เครดิต]
const jv = (co: string, date: string, lines: L[], adjusting = false) =>
  ok('POST', `/companies/${co}/journal`, { date, description: 'ทดสอบ', adjusting,
    lines: lines.map(([a, d, c]) => (d ? { account_code: a, debit: d } : { account_code: a, credit: c })) });
const pairs = (ls: { code: string; amount: string }[]) => ls.map((l) => [l.code, l.amount]);

async function company() {
  const school = await newSchool();
  const teacher = await newUser(school, 'teacher');
  owner = await newUser(school, 'student');
  return newCompany(owner, await newClassroom(school, teacher, [owner]));
}

describe('ระบบสินค้าสิ้นงวด: ต้นทุนขาย = ต้นงวด + ซื้อสุทธิ − ปลายงวด (ตรวจนับ)', () => {
  let co: string;
  beforeAll(async () => {
    co = await company();
    for (const [code, name] of [['5150', 'ค่าขนส่งเข้า'], ['5910', 'ภาษีเงินได้นิติบุคคล']]) {
      await ok('POST', `/companies/${co}/accounts`, { code, name, type: 'expense' });
    }
    await jv(co, '2024-12-31', [['1310', '15000', ''], ['3110', '', '15000']]); // สินค้ายกมา
    await jv(co, '2025-01-02', [['1110', '200000', ''], ['3110', '', '200000']]);
    await jv(co, '2025-01-03', [['1630', '36000', ''], ['2610', '', '36000']]);
    await jv(co, '2025-01-05', [['5110', '40000', ''], ['2110', '', '40000']]);
    await jv(co, '2025-01-08', [['2110', '2000', ''], ['5140', '', '2000']]);
    await jv(co, '2025-01-10', [['5150', '500', ''], ['1110', '', '500']]);
    await jv(co, '2025-01-15', [['1110', '60000', ''], ['4110', '', '60000']]);
    await jv(co, '2025-01-16', [['1110', '2000', ''], ['4120', '', '2000']]);
    await jv(co, '2025-01-17', [['1110', '120', ''], ['4310', '', '120']]);
    await jv(co, '2025-01-18', [['4220', '1500', ''], ['1110', '', '1500']]);
    await jv(co, '2025-01-19', [['4210', '300', ''], ['1110', '', '300']]);
    await jv(co, '2025-01-20', [['2110', '38000', ''], ['1110', '', '37240'], ['5120', '', '760']]);
    await jv(co, '2025-01-25', [['5210', '8000', ''], ['5220', '5000', ''], ['5310', '450', ''], ['5320', '700', ''], ['1110', '', '14150']]);
    await jv(co, '2025-01-31', [['5250', '600', ''], ['1631', '', '600']], true);
    await jv(co, '2025-01-31', [['5910', '1000', ''], ['2310', '', '1000']], true);
  });

  it('ตรวจนับปลายเดือน 18,240: AJ วันสิ้นเดือน ปรับ 1310 เพิ่ม 3,240 คู่ต้นทุนขาย', async () => {
    const st = await ok('GET', `/companies/${co}/ending-inventory?month=2025-01`);
    expect(st).toMatchObject({ month: '2025-01', glBalance: '15000.00', perpetual: false, canWrite: true });
    const bad = await call('POST', `/companies/${co}/ending-inventory`, { month: '2025-01', amount: '15000' });
    expect([bad.statusCode, bad.json().message]).toEqual([422, 'ยอดสินค้าคงเหลือในบัญชี ณ 31/01/2568 เท่ากับ 15,000.00 อยู่แล้ว ไม่ต้องปรับปรุง']);
    const key = randomUUID();
    const r = await ok('POST', `/companies/${co}/ending-inventory`, { month: '2025-01', amount: '18240' }, key);
    expect(r.docNo).toMatch(/^AJ-\d{4}$/);
    expect(await ok('POST', `/companies/${co}/ending-inventory`, { month: '2025-01', amount: '18240' }, key)).toEqual(r); // กดซ้ำ
    const lines = (await db.query(
      `select a.code, l.debit::text d, l.credit::text c, e.entry_date::text dt from acc.journal_lines l
         join acc.journal_entries e on e.company_id = l.company_id and e.id = l.entry_id
         join acc.chart_of_accounts a on a.company_id = l.company_id and a.id = l.account_id
        where e.id = $1 order by l.line_no`, [r.id])).rows;
    expect(lines).toEqual([
      { code: '1310', d: '3240.00', c: '0.00', dt: '2025-01-31' }, { code: '5130', d: '0.00', c: '3240.00', dt: '2025-01-31' }]);
  });

  it('งบกำไรขาดทุนหลายขั้น มกราคม 2568 ตรงเฉลย', async () => {
    const st = await ok('GET', `/companies/${co}/statements?month=2025-01&scope=month`);
    const m = st.multiStep;
    expect(pairs(m.sales)).toEqual([['4110', '60000.00'], ['4120', '2000.00'], ['4210', '-300.00'], ['4220', '-1500.00']]);
    expect(m.netSales).toBe('60200.00');
    expect(m.costOfSales).toEqual({
      opening: '15000.00', purchases: '40000.00', discounts: '760.00', returns: '2000.00',
      otherCosts: [{ code: '5150', name: 'ค่าขนส่งเข้า', amount: '500.00' }],
      netPurchases: '37740.00', available: '52740.00', closing: '18240.00', adjustments: '0.00', total: '34500.00',
    });
    expect([m.grossProfit, m.totalOtherIncome, m.totalSellingAdmin, m.totalOtherExpenses, m.profitBeforeFinance,
      m.totalFinanceCosts, m.profitBeforeTax, m.totalIncomeTax, m.netIncome])
      .toEqual(['25700.00', '120.00', '13600.00', '700.00', '11520.00', '450.00', '11070.00', '1000.00', '10070.00']);
    expect(pairs(m.otherIncome)).toEqual([['4310', '120.00']]);
    expect(pairs(m.sellingAdmin)).toEqual([['5210', '8000.00'], ['5220', '5000.00'], ['5250', '600.00']]);
    expect(pairs(m.otherExpenses)).toEqual([['5320', '700.00']]);
    expect(pairs(m.financeCosts)).toEqual([['5310', '450.00']]);
    expect(pairs(m.incomeTax)).toEqual([['5910', '1000.00']]);
    expect(st.netIncome).toBe(m.netIncome); // ขั้นเดียว = หลายขั้น
  });

  it('งบแสดงฐานะการเงินแยกหมุนเวียน/ไม่หมุนเวียน', async () => {
    const st = await ok('GET', `/companies/${co}/statements?month=2025-01&scope=month`);
    const k = st.classified;
    expect(pairs(k.currentAssets)).toEqual([['1110', '208430.00'], ['1310', '18240.00']]);
    expect(pairs(k.nonCurrentAssets)).toEqual([['1630', '36000.00'], ['1631', '-600.00']]);
    expect(pairs(k.currentLiabilities)).toEqual([['2310', '1000.00']]);
    expect(pairs(k.nonCurrentLiabilities)).toEqual([['2610', '36000.00']]);
    expect([k.totalCurrentAssets, k.totalNonCurrentAssets, k.totalCurrentLiabilities, k.totalNonCurrentLiabilities])
      .toEqual(['226670.00', '35400.00', '1000.00', '36000.00']);
    expect([st.totalAssets, st.totalLiabilities, st.totalEquity, st.totalLiabilitiesEquity, st.balanced])
      .toEqual(['262070.00', '37000.00', '225070.00', '262070.00', true]);
  });

  it('เดือนถัดไป: ปลายงวดเดือนก่อน = ต้นงวด · ยังไม่ตรวจนับ = ปลายงวดเท่าต้นงวด · ตั้งแต่ต้นปีรวมสองเดือน', async () => {
    await jv(co, '2025-02-05', [['5110', '10000', ''], ['1110', '', '10000']]);
    await jv(co, '2025-02-06', [['1110', '20000', ''], ['4110', '', '20000']]);
    const feb = (await ok('GET', `/companies/${co}/statements?month=2025-02&scope=month`)).multiStep.costOfSales;
    expect([feb.opening, feb.purchases, feb.netPurchases, feb.closing, feb.total]).toEqual(['18240.00', '10000.00', '10000.00', '18240.00', '10000.00']);
    const ytd = (await ok('GET', `/companies/${co}/statements?month=2025-02&scope=ytd`)).multiStep.costOfSales;
    expect(ytd).toMatchObject({ opening: '15000.00', purchases: '50000.00', discounts: '760.00', returns: '2000.00',
      netPurchases: '47740.00', available: '62740.00', closing: '18240.00', adjustments: '0.00', total: '44500.00' });
    // ตรวจนับปลาย ก.พ. 16,000: ลดลง 2,240 → ต้นทุนขาย ก.พ. = 18,240 + 10,000 − 16,000
    await ok('POST', `/companies/${co}/ending-inventory`, { month: '2025-02', amount: '16000' });
    const feb2 = (await ok('GET', `/companies/${co}/statements?month=2025-02&scope=month`)).multiStep;
    expect([feb2.costOfSales.closing, feb2.costOfSales.adjustments, feb2.costOfSales.total, feb2.grossProfit])
      .toEqual(['16000.00', '0.00', '12240.00', '7760.00']);
    const badDay = await call('POST', `/companies/${co}/ending-inventory`, { month: '2025-13', amount: '1' });
    expect(badDay.statusCode).toBe(400);
  });

  it('ปิดบัญชีสิ้นปีแล้ว สินค้าปลายปียกเป็นต้นงวดปีใหม่ ต้นทุนขายปีใหม่ไม่รวมปีก่อน', async () => {
    await ok('POST', `/companies/${co}/periods/2024-12/close`);
    await ok('POST', `/companies/${co}/fiscal-years/2024-12-31/close`);
    await ok('POST', `/companies/${co}/fiscal-years/2025-12-31/close`);
    await jv(co, '2026-01-10', [['5110', '1000', ''], ['1110', '', '1000']]);
    await jv(co, '2026-01-11', [['1110', '5000', ''], ['4110', '', '5000']]);
    const st = await ok('GET', `/companies/${co}/statements?month=2026-01&scope=ytd`);
    expect(st.multiStep.costOfSales).toMatchObject({ opening: '16000.00', purchases: '1000.00', closing: '16000.00', total: '1000.00' });
    expect([st.multiStep.netSales, st.multiStep.grossProfit, st.multiStep.netIncome]).toEqual(['5000.00', '4000.00', '4000.00']);
  });
});

describe('ระบบสินค้าต่อเนื่อง: ต้นทุนขายจากบัตรสต็อกแสดงในรูปต้นงวด + ซื้อ − ปลายงวด', () => {
  let co: string;
  beforeAll(async () => {
    co = await company();
    const prof = await ok('GET', `/companies/${co}/profile`);
    await ok('PATCH', `/companies/${co}/profile`, { version: prof.version, taxId: taxId(9001), vatRegistered: true });
    await ok('POST', `/companies/${co}/parties`, { code: 'C1', name: 'ลูกค้า', isCustomer: true, isVendor: false, taxId: taxId(9101), vatRegistered: true });
    await ok('POST', `/companies/${co}/parties`, { code: 'V1', name: 'ผู้ขาย', isCustomer: false, isVendor: true, taxId: taxId(9201), vatRegistered: true });
    await ok('POST', `/companies/${co}/items`, { code: 'A', name: 'สินค้า A', unit: 'ชิ้น', isService: false, trackInventory: true });
    await jv(co, '2025-03-01', [['1120', '100000', ''], ['3110', '', '100000']]);
  });

  it('ซื้อ 100 @50 · ขาย 60 · ส่งคืน 10 · รับสินค้าเข้าจากทุน 5 @50 → ต้นทุนขาย 3,000 ส่วนต่าง 250 แสดงเป็นปรับปรุงสินค้าอื่น', async () => {
    const pi = await ok('POST', `/companies/${co}/purchases/invoice`, { date: '2025-03-01', partyCode: 'V1', vendorDocNo: 'P1', lines: [{ itemCode: 'A', qty: '100', unitPrice: '50' }] });
    await ok('POST', `/companies/${co}/sales/invoice`, { date: '2025-03-10', partyCode: 'C1', lines: [{ itemCode: 'A', qty: '60', unitPrice: '90' }] });
    await ok('POST', `/companies/${co}/purchases/credit-note`, { date: '2025-03-15', refDocumentId: pi.id, vendorDocNo: 'N1', reason: 'คืน', lines: [{ itemCode: 'A', qty: '10', unitPrice: '50' }] });
    await ok('POST', `/companies/${co}/inventory/adjustments`, { itemCode: 'A', date: '2025-03-20', quantity: '5', unitCost: '50', offsetAccount: '3110' });
    const st = await ok('GET', `/companies/${co}/statements?month=2025-03&scope=month`);
    expect(st.multiStep.costOfSales).toEqual({
      opening: '0.00', purchases: '5000.00', discounts: '0.00', returns: '500.00', otherCosts: [],
      netPurchases: '4500.00', available: '4500.00', closing: '1750.00', adjustments: '250.00', total: '3000.00',
    });
    expect(pairs(st.multiStep.sales)).toEqual([['4110', '5400.00']]);
    expect([st.multiStep.grossProfit, st.multiStep.netIncome, st.netIncome]).toEqual(['2400.00', '2400.00', '2400.00']);
    // 1310 ปลายงวด = ยอดบัตรสต็อก 35 ชิ้น × 50
    expect(pairs(st.classified.currentAssets)).toContainEqual(['1310', '1750.00']);
  });

  it('ติดตามสต็อกอยู่: บันทึกยอดตรวจนับแบบสิ้นงวดไม่ได้', async () => {
    const st = await ok('GET', `/companies/${co}/ending-inventory?month=2025-03`);
    expect([st.glBalance, st.perpetual]).toEqual(['1750.00', true]);
    const r = await call('POST', `/companies/${co}/ending-inventory`, { month: '2025-03', amount: '1000' });
    expect([r.statusCode, r.json().code]).toEqual([422, 'ACC15']);
  });

  it('บริษัทบริการ (ไม่มีสินค้า): ไม่มีส่วนต้นทุนขาย กำไรขั้นต้น = รายได้สุทธิ', async () => {
    const c2 = await company();
    await jv(c2, '2025-05-01', [['1110', '9000', ''], ['4120', '', '9000']]);
    await jv(c2, '2025-05-02', [['5220', '3000', ''], ['1110', '', '3000']]);
    const m = (await ok('GET', `/companies/${c2}/statements?month=2025-05&scope=month`)).multiStep;
    expect([m.costOfSales, m.netSales, m.grossProfit, m.totalSellingAdmin, m.netIncome]).toEqual([null, '9000.00', '9000.00', '3000.00', '6000.00']);
  });
});
