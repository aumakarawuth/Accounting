import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { curriculumApp } from './curriculum-helpers';
import { newSchool, newUser, newClassroom, newCompany } from './helpers';
import { ratio } from '../apps/api/src/ratios';

// เฟส 7 โมดูล 4: อัตราส่วนทางการเงิน (docs/phase7-spec.md ข้อ 4) เฉลยคิดมือ
// ม.ค. 2569: ลงทุน 200,000 · ซื้อสินค้าเชื่อ 60,000 · ขายเชื่อ 50,000 ต้นทุน 30,000 · กู้ระยะยาว 100,000
//   สิ้น ม.ค.: เงินสด 300,000 ลูกหนี้ 50,000 สินค้า 30,000 รวมสินทรัพย์ 380,000 · เจ้าหนี้ 60,000 · ส่วนของเจ้าของ 220,000
// ก.พ.: ขายเชื่อ 80,000 ต้นทุน 20,000 · รับชำระ 40,000 · ค่าเช่า 10,000 · จ่ายเจ้าหนี้ 30,000
//   สิ้น ก.พ.: เงินสด 300,000 ลูกหนี้ 90,000 สินค้า 10,000 รวม 400,000 · เจ้าหนี้ 30,000 เงินกู้ 100,000 · ส่วนของเจ้าของ 270,000 · กำไร ก.พ. 50,000
const { ok, as, close } = curriculumApp();
afterAll(close);
let owner: string, other: string, co: string;
const jv = (date: string, dr: string, cr: string, amount: string) =>
  ok(owner, 'POST', `/companies/${co}/journal`, { date, description: 'รายการค้า', lines: [{ account_code: dr, debit: amount }, { account_code: cr, credit: amount }] });
const values = (r: { items: { key: string; value: string | null }[] }) => Object.fromEntries(r.items.map((i) => [i.key, i.value]));

beforeAll(async () => {
  const school = await newSchool();
  const teacher = await newUser(school, 'teacher');
  owner = await newUser(school, 'student');
  other = await newUser(school, 'student');
  await newClassroom(school, teacher, [owner, other]);
  co = await newCompany(owner, null);
  await jv('2026-01-01', '1110', '3110', '200000');
  await jv('2026-01-05', '1310', '2110', '60000');
  await jv('2026-01-10', '1210', '4110', '50000');
  await jv('2026-01-10', '5130', '1310', '30000');
  await jv('2026-01-20', '1110', '2610', '100000');
  await jv('2026-02-03', '1210', '4110', '80000');
  await jv('2026-02-03', '5130', '1310', '20000');
  await jv('2026-02-10', '1110', '1210', '40000');
  await jv('2026-02-15', '5220', '1110', '10000');
  await jv('2026-02-20', '2110', '1110', '30000');
});

describe('อัตราส่วนทางการเงิน', () => {
  it('ปัดครึ่งขึ้น 2 ตำแหน่ง · ตัวหารเป็นศูนย์ = คำนวณไม่ได้', () => {
    expect(ratio(2n, 3n)).toBe('0.67');
    expect(ratio(1n, 8n)).toBe('0.13');     // 0.125 → 0.13
    expect(ratio(-1n, 8n)).toBe('-0.13');
    expect(ratio(1n, 0n)).toBeNull();
    expect(ratio(5n, 8n, 100n)).toBe('62.50');
  });

  it('เดือน ก.พ.: ยอดถัวเฉลี่ยต้นงวด (สิ้น ม.ค.) + ปลายงวด ตรงเฉลย', async () => {
    const r = await ok(owner, 'GET', `/companies/${co}/ratios?month=2026-02&scope=month`);
    expect(r.days).toBe(28);
    expect(r.figures).toMatchObject({ currentAssets: '400000.00', currentLiabilities: '30000.00', quickAssets: '390000.00',
      receivablesOpening: '50000.00', receivables: '90000.00', averageReceivables: '70000.00', averageInventory: '20000.00',
      averageAssets: '390000.00', averageEquity: '245000.00', liabilities: '130000.00', equity: '270000.00',
      netSales: '80000.00', costOfSales: '20000.00', grossProfit: '60000.00', netIncome: '50000.00' });
    expect(values(r)).toEqual({
      current: '13.33', quick: '13.00', receivableTurnover: '1.14', collectionDays: '24.50', inventoryTurnover: '1.00', inventoryDays: '28.00',
      assetTurnover: '0.21', grossMargin: '75.00', netMargin: '62.50', roa: '12.82', roe: '20.41', debtToEquity: '0.48',
    });
    // ตัวเลขที่ใช้ตรงงบการเงินเดือนเดียวกัน
    const st = await ok(owner, 'GET', `/companies/${co}/statements?month=2026-02&scope=month`);
    expect([st.totalAssets, st.totalEquity, st.netIncome, st.multiStep.netSales]).toEqual(['400000.00', '270000.00', '50000.00', '80000.00']);
  });

  it('ตั้งแต่ต้นปี (ไม่มียอดต้นงวด = ใช้ปลายงวด)', async () => {
    const r = await ok(owner, 'GET', `/companies/${co}/ratios?month=2026-02&scope=ytd`);
    expect(r.days).toBe(59);
    expect(r.figures).toMatchObject({ receivablesOpening: '0.00', averageReceivables: '90000.00', netSales: '130000.00', netIncome: '70000.00' });
    expect(values(r)).toMatchObject({ receivableTurnover: '1.44', collectionDays: '40.85', inventoryTurnover: '5.00', roe: '25.93' });
  });

  it('บริษัทว่าง: คำนวณไม่ได้ทุกตัว · นักเรียนอื่นอ่านไม่ได้', async () => {
    const empty = await newCompany(owner, null);
    const r = await ok(owner, 'GET', `/companies/${empty}/ratios?month=2026-02&scope=month`);
    expect(r.items.every((i: { value: string | null }) => i.value === null)).toBe(true);
    expect((await as(other, 'GET', `/companies/${co}/ratios?month=2026-02&scope=month`)).statusCode).toBe(404);
  });
});
