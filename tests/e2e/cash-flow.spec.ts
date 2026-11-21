import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { checkScreen, freshStudentHome, watchErrors } from './helpers';

// งบกระแสเงินสด (docs/phase6-spec.md ข้อ 2) ทุกจอ: ลงทุน 100,000 · ขายเชื่อ 30,000 รับ 20,000 · ซื้ออุปกรณ์ 24,000
// ค่าเสื่อม 500 · กู้ 10,000 · ถอนใช้ 2,000 → ดำเนินงาน 29,500 − 20,000(ลูกหนี้) = ... เงินสดปลายงวด 104,000

test('งบกระแสเงินสด ทางอ้อม/ทางตรง: เงินสดปลายงวดตรงบัญชี 11xx', async ({ page, browser, baseURL }, info) => {
  test.setTimeout(120_000);
  const errors = watchErrors(page);
  const { home, co } = await freshStudentHome(page, browser, info, new URL(baseURL!).origin, 'กระแสเงินสด');
  for (const [date, dr, cr, amount, adjusting] of [
    ['2026-04-01', '1110', '3110', '100000', false], ['2026-04-05', '1210', '4110', '30000', false], ['2026-04-10', '1110', '1210', '20000', false],
    ['2026-04-12', '1630', '1110', '24000', false], ['2026-04-30', '5250', '1631', '500', true], ['2026-04-20', '1110', '2610', '10000', false],
    ['2026-04-25', '3310', '1110', '2000', false],
  ] as const) {
    const r = await page.request.post(`/api/companies/${co}/journal`, { headers: { 'idempotency-key': randomUUID() },
      data: { date, description: 'ทดสอบงบกระแสเงินสด', adjusting, lines: [{ account_code: dr, debit: amount }, { account_code: cr, credit: amount }] } });
    expect(r.status()).toBe(201);
  }
  await page.goto(`${home}/cash-flow?month=2026-04&scope=month`);
  const st = page.getByRole('article', { name: 'งบกระแสเงินสด' });
  const line = (label: string) => st.getByText(label, { exact: true }).locator('xpath=ancestor::div[1]');
  await expect(line('กำไร(ขาดทุน)สุทธิ')).toContainText('29,500.00');
  await expect(line('บวก ค่าเสื่อมราคา')).toContainText('500.00');
  await expect(line('ลูกหนี้การค้า (เพิ่มขึ้น)')).toContainText('(10,000.00)');
  await expect(line('เงินสดสุทธิได้มา(ใช้ไป)ในกิจกรรมดำเนินงาน')).toContainText('20,000.00');
  await expect(line('เงินสดจ่ายซื้ออุปกรณ์สำนักงาน')).toContainText('(24,000.00)');
  await expect(line('เงินสดสุทธิได้มา(ใช้ไป)ในกิจกรรมจัดหาเงิน')).toContainText('108,000.00');
  await expect(line('เงินสดและรายการเทียบเท่าเงินสดปลายงวด')).toContainText('104,000.00');
  await expect(st.getByRole('status')).toHaveText('เงินสดปลายงวด 104,000.00 ตรงกับยอดบัญชีเงินสด/เงินฝากในงบแสดงฐานะการเงิน');
  await checkScreen(page, info, 'cash-flow-indirect');

  await page.getByRole('navigation', { name: 'วิธี' }).getByRole('link', { name: 'ทางตรง' }).click();
  await expect(line('เงินสดรับจากลูกค้า')).toContainText('20,000.00');
  await expect(line('เงินสดสุทธิได้มา(ใช้ไป)ในกิจกรรมดำเนินงาน')).toContainText('20,000.00');
  await checkScreen(page, info, 'cash-flow-direct');
  for (const ext of ['pdf', 'xlsx']) {
    const r = await page.request.get(`/export/company/${co}/cash-flow.${ext}?month=2026-04&scope=month&method=direct`);
    expect(r.status()).toBe(200);
  }
  expect(errors).toEqual([]);
});
