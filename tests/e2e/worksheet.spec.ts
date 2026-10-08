import { test, expect } from '@playwright/test';
import { checkScreen, isPhone, studentHome, watchErrors } from './helpers';

// กระดาษทำการ: ลงรายการปรับปรุง (AJ วันสิ้นเดือน) จากหน้าปรับปรุง/ปิดงวด → กระดาษทำการ 10 ช่องแสดงในช่องปรับปรุง
// ทุกคู่ช่องดุล · สลับแบบ 8 และ 6 ช่อง (รันซ้ำได้ทุกจอบนบริษัทเดียวกัน: เทียบกับยอดที่อ่านจาก API ก่อนลง)

test('ลงรายการปรับปรุง AJ → กระดาษทำการ 10 / 8 / 6 ช่อง', async ({ page }, info) => {
  const errors = watchErrors(page);
  const home = await studentHome(page);
  const co = home.split('/')[2]!;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date());
  const month = today.slice(0, 7);
  const [y, m] = month.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const before = await (await page.request.get(`/api/companies/${co}/worksheet?month=${month}&format=10`)).json();

  await page.goto(`${home}/closing`);
  await page.getByRole('link', { name: 'ลงรายการปรับปรุง' }).click();
  await expect(page.getByRole('heading', { name: 'รายการปรับปรุง' })).toBeVisible();
  await expect(page.locator('input[inputmode=numeric]').first()).toHaveValue(`${last}/${String(m).padStart(2, '0')}/${y + 543}`);
  const codes = page.getByRole('combobox');
  await codes.nth(0).fill('5250');
  await page.getByRole('option', { name: /5250/ }).click();
  await codes.nth(1).fill('1631');
  await page.getByRole('option', { name: /1631/ }).click();
  const money = page.locator('input[inputmode=decimal]');
  await money.nth(0).fill('1200');
  await money.nth(3).fill('1200');
  await page.getByRole('button', { name: /ผ่านรายการ/ }).click();
  await expect(page.getByText(/ผ่านรายการเลขที่ AJ-\d{4}/)).toBeVisible();

  await page.goto(`${home}/worksheet?month=${month}`);
  await expect(page.getByRole('heading', { name: /กระดาษทำการ/ })).toBeVisible();
  const sheet = page.getByRole('region', { name: 'กระดาษทำการ' });
  await expect(sheet).toContainText(isPhone(info) ? 'หลังปรับปรุง' : 'งบทดลองหลังปรับปรุง');
  const w = await (await page.request.get(`/api/companies/${co}/worksheet?month=${month}&format=10`)).json();
  const cents = (x: string) => Math.round(Number(x) * 100);
  expect(cents(w.totals.adj.debit) - cents(before.totals?.adj.debit ?? '0')).toBe(120000);
  for (const k of ['tb', 'adj', 'atb']) expect(w.totals[k].debit).toBe(w.totals[k].credit);
  expect(w.grand.is.debit).toBe(w.grand.is.credit);
  expect(w.grand.bs.debit).toBe(w.grand.bs.credit);
  const row = sheet.getByRole('row', { name: /1631/ });
  await expect(row).toBeVisible();
  await checkScreen(page, info, 'worksheet-10');

  await page.getByRole('link', { name: '8 ช่อง' }).click();
  await expect(sheet).not.toContainText('หลังปรับปรุง');
  await expect(sheet).toContainText('ปรับปรุง');
  await page.getByRole('link', { name: '6 ช่อง' }).click();
  await expect(sheet).not.toContainText('ปรับปรุง');
  await expect(page.getByText('แบบ 6 ช่องไม่มีช่องปรับปรุง')).toBeVisible();
  await checkScreen(page, info, 'worksheet-6');
  expect(errors).toEqual([]);
});
