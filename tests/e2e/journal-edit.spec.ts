import { test, expect } from '@playwright/test';
import { checkScreen, studentHome, watchErrors } from './helpers';

// หน้าแรกมีปุ่มสมุดรายวันใหม่ทุกจอ (รวมมือถือ) · แก้ไขรายการ: ฟอร์มเติมค่าเดิม → ผ่านรายการ = กลับรายการเดิม + ลงใหม่
test('ปุ่มสมุดรายวันใหม่บนหน้าแรก และแก้ไขรายการที่ผ่านแล้ว', async ({ page }, info) => {
  const errors = watchErrors(page);
  const home = await studentHome(page);
  await page.getByRole('main').getByRole('link', { name: 'สมุดรายวันใหม่' }).click();
  await page.waitForURL(`**${home}/journal/new`);

  const codes = page.getByRole('combobox');
  await codes.nth(0).fill('1110');
  await page.getByRole('option', { name: /1110/ }).click();
  await codes.nth(1).fill('3110');
  await page.getByRole('option', { name: /3110/ }).click();
  const money = page.locator('input[inputmode=decimal]');
  await money.nth(0).fill('321');
  await money.nth(3).fill('321');
  await page.getByRole('button', { name: /ผ่านรายการ/ }).click();
  const posted = page.getByText(/ผ่านรายการเลขที่ JV-\d{4}/);
  const first = (await posted.textContent())!.match(/JV-\d{4}/)![0];
  await page.getByRole('link', { name: 'ดูรายการ' }).click();

  await page.getByRole('link', { name: 'แก้ไขรายการ' }).click();
  await expect(page.getByRole('heading', { name: `แก้ไข ${first}` })).toBeVisible();
  await expect(money.nth(0)).toHaveValue('321.00');
  await money.nth(0).fill('654');
  await money.nth(3).fill('654');
  await checkScreen(page, info, 'journal-edit');
  await page.getByRole('button', { name: /ผ่านรายการ/ }).click();
  await page.waitForURL(/\/journal\/[0-9a-f-]{36}$/);
  await expect(page.getByText('654.00').filter({ visible: true }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'แก้ไขรายการ' })).toBeVisible();
  expect(errors).toEqual([]);
});
