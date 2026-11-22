import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { checkScreen, freshStudentHome, watchErrors } from './helpers';

// อัตราส่วนทางการเงิน (docs/phase7-spec.md ข้อ 4) ทุกจอ: เดือนเดียว ยอดถัวเฉลี่ยจากสิ้นเดือนก่อน
test('อัตราส่วนทางการเงินพร้อมสูตรและตัวเลขที่ใช้', async ({ page, browser, baseURL }, info) => {
  test.setTimeout(120_000);
  const errors = watchErrors(page);
  const { home, co } = await freshStudentHome(page, browser, info, new URL(baseURL!).origin, 'อัตราส่วน');
  for (const [date, dr, cr, amount] of [
    ['2026-01-01', '1110', '3110', '200000'], ['2026-01-05', '1310', '2110', '60000'], ['2026-01-10', '1210', '4110', '50000'],
    ['2026-01-10', '5130', '1310', '30000'], ['2026-01-20', '1110', '2610', '100000'], ['2026-02-03', '1210', '4110', '80000'],
    ['2026-02-03', '5130', '1310', '20000'], ['2026-02-10', '1110', '1210', '40000'], ['2026-02-15', '5220', '1110', '10000'], ['2026-02-20', '2110', '1110', '30000'],
  ]) {
    const r = await page.request.post(`/api/companies/${co}/journal`, { headers: { 'idempotency-key': randomUUID() },
      data: { date, description: 'รายการค้า', lines: [{ account_code: dr, debit: amount }, { account_code: cr, credit: amount }] } });
    expect(r.status()).toBe(201);
  }
  await page.goto(`${home}/ratios?month=2026-02&scope=month`);
  const current = page.getByRole('listitem', { name: 'อัตราส่วนทุนหมุนเวียน', exact: true });
  await expect(current).toContainText('13.33');
  await expect(current).toContainText('สินทรัพย์หมุนเวียน ÷ หนี้สินหมุนเวียน');
  const ar = page.getByRole('listitem', { name: 'อัตราการหมุนเวียนของลูกหนี้' });
  await expect(ar).toContainText('1.14');
  await expect(ar).toContainText('70,000.00');
  await expect(page.getByRole('listitem', { name: 'อัตราผลตอบแทนส่วนของเจ้าของ (ROE)' })).toContainText('20.41');
  await checkScreen(page, info, 'ratios');
  expect(errors).toEqual([]);
});
