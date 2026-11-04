import { test, expect } from '@playwright/test';
import { checkScreen, studentHome, watchErrors } from './helpers';

// กระทบยอดธนาคาร: นำเข้า statement แล้วหน้าแสดงรายการ สรุปยอด และเลือก statement ได้
test('กระทบยอดธนาคาร: นำเข้า statement และแสดงรายการ', async ({ page }, info) => {
  const errors = watchErrors(page);
  const home = await studentHome(page);
  await page.goto(`${home}/bank-reconciliation`);
  await expect(page.getByRole('heading', { name: 'กระทบยอดธนาคาร' })).toBeVisible();
  // งวดไม่ซ้ำกันในแต่ละรอบ/จอ (statement ซ้ำงวดเดิมถูกปฏิเสธ)
  const day = new Date(Date.now() + info.workerIndex * 86_400_000 + Math.floor(Math.random() * 1e6) * 86_400_000);
  const d = (x: Date) => x.toISOString().slice(0, 10);
  const end = new Date(day.getTime() + 86_400_000);
  await page.locator('summary').click();
  await page.getByLabel('รหัสบัญชีธนาคาร').fill('1120');
  await page.getByLabel('ตั้งแต่วันที่').fill(d(day));
  await page.getByLabel('ถึงวันที่').fill(d(end));
  await page.getByLabel('ยอดต้นงวดตามธนาคาร').fill('0');
  await page.getByLabel('ยอดปลายงวดตามธนาคาร').fill('980');
  await page.getByLabel(/^รายการ \(/).fill(`${d(day)},รับโอน e2e,1000.00,TRX-1\n${d(end)},ค่าธรรมเนียม e2e,-20.00,`);
  await page.getByRole('button', { name: 'นำเข้า', exact: true }).click();
  await expect(page.getByRole('cell', { name: /รับโอน e2e/ }).first()).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'เลือก statement' })).toBeVisible();
  await checkScreen(page, info, 'bank-reconciliation');
  expect(errors).toEqual([]);
});
