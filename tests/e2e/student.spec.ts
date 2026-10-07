import { test, expect } from '@playwright/test';
import { checkScreen, isPhone, studentHome, watchErrors } from './helpers';

test('สมุดรายวัน: ไม่ดุลกดผ่านรายการไม่ได้ ดุลแล้วได้เลขที่ JV', async ({ page }, info) => {
  const errors = watchErrors(page);
  const home = await studentHome(page);
  await checkScreen(page, info, 'student-home');

  await page.goto(`${home}/journal/new`);
  const codes = page.getByRole('combobox');
  await codes.nth(0).fill('1110');
  await page.getByRole('option', { name: /1110/ }).click();
  await codes.nth(1).fill('4120');
  await page.getByRole('option', { name: /4120/ }).click();
  const money = page.locator('input[inputmode=decimal]');
  await money.nth(0).fill('12500');
  await money.nth(3).fill('12000');
  const post = page.getByRole('button', { name: /ผ่านรายการ/ });
  await expect(post).toBeDisabled();
  await expect(page.getByText('เดบิตมากกว่าเครดิต 500.00', { exact: false })).toBeVisible();
  await checkScreen(page, info, 'journal-unbalanced');

  await money.nth(3).fill('12500');
  await expect(post).toBeEnabled();
  await post.click();
  await expect(page.getByText(/ผ่านรายการเลขที่ JV-\d{4}/)).toBeVisible();
  await checkScreen(page, info, 'journal-posted');
  expect(errors).toEqual([]);
});

test('งบทดลอง แยกประเภท งบการเงิน: ดุล และเปิดแยกประเภทจากรายการบัญชีได้', async ({ page }, info) => {
  const errors = watchErrors(page);
  const home = await studentHome(page);

  await page.goto(`${home}/trial-balance`);
  // ค้นในเนื้อหาหลัก (แถบบนอาจมีป้ายครูกำลังดูอยู่ ซึ่งก็เป็น role=status)
  await expect(page.locator('main').getByRole('status')).toContainText('ดุล');
  await checkScreen(page, info, 'trial-balance');

  await page.goto(`${home}/ledger`);
  await checkScreen(page, info, 'ledger-accounts');
  await page.getByRole('link', { name: /1110\s*เงินสด/ }).click();
  await expect(page.getByRole('heading', { name: /บัญชีแยกประเภท · 1110 เงินสด/ })).toBeVisible();
  await checkScreen(page, info, 'ledger-1110');

  await page.goto(`${home}/statements`);
  await expect(page.locator('main').getByRole('status').last()).toHaveText('สินทรัพย์เท่ากับหนี้สินและส่วนของเจ้าของ');
  await checkScreen(page, info, 'statements');
  expect(errors).toEqual([]);
});

test('มือถือ: แถบล่างและเมนูทั้งหมด', async ({ page }, info) => {
  test.skip(!isPhone(info), 'แถบล่างมีเฉพาะมือถือ');
  const home = await studentHome(page);
  await page.getByRole('link', { name: 'เมนูทั้งหมด' }).click();
  await page.waitForURL(`**${home}/menu`);
  await expect(page.getByRole('button', { name: 'ออกจากระบบ' })).toBeVisible();
  await checkScreen(page, info, 'menu');
});
