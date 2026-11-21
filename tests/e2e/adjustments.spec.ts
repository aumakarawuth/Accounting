import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { checkScreen, freshStudentHome, watchErrors } from './helpers';

// รายการปรับปรุง + กลับรายการอัตโนมัติ (docs/phase6-spec.md ข้อ 5) ทุกจอ:
// ค่าน้ำไฟค้างจ่าย 800 ติ๊กกลับรายการ → AJ 31 ก.ค. + JV 1 ส.ค. · จ่ายล่วงหน้าบันทึกเป็นสินทรัพย์ → กลับรายการไม่ได้

test('รายการปรับปรุงค้างจ่าย + กลับรายการอัตโนมัติวันแรกของงวดถัดไป', async ({ page, browser, baseURL }, info) => {
  test.setTimeout(120_000);
  const errors = watchErrors(page);
  const { home, co } = await freshStudentHome(page, browser, info, new URL(baseURL!).origin, 'ปรับปรุง');
  const r = await page.request.post(`/api/companies/${co}/journal`, { headers: { 'idempotency-key': randomUUID() },
    data: { date: '2026-07-01', description: 'จ่ายค่าเช่าล่วงหน้า', lines: [{ account_code: '1510', debit: '12000' }, { account_code: '1110', credit: '12000' }] } });
  expect(r.status()).toBe(201);

  await page.goto(`${home}/adjustments?month=2026-07`);
  const form = page.getByRole('form', { name: 'บันทึกรายการปรับปรุง' });
  await form.getByLabel('บัญชีค่าใช้จ่าย').selectOption('5230');
  await form.getByLabel('จำนวนเงิน').fill('800');
  await form.getByLabel('กลับรายการอัตโนมัติวันแรกของงวดถัดไป').check();
  await expect(form.getByText('จะลง AJ: เดบิต 5230 ค่าน้ำ ค่าไฟ / เครดิต 2310 ค่าใช้จ่ายค้างจ่าย 800.00')).toBeVisible();
  await expect(form.getByText('และ JV วันที่ 1 เดือนถัดไป: เดบิต 2310 ค่าใช้จ่ายค้างจ่าย / เครดิต 5230 ค่าน้ำ ค่าไฟ ยอดเท่ากัน')).toBeVisible();
  await checkScreen(page, info, 'adjustments-form');
  await form.getByRole('button', { name: 'ผ่านรายการปรับปรุง' }).click();
  await expect(form.getByRole('status')).toHaveText(/^ผ่านรายการเลขที่ AJ-\d{4} และกลับรายการ JV-\d{4}$/);
  const list = page.getByRole('region', { name: 'รายการปรับปรุงที่บันทึกแล้ว' });
  await expect(list).toContainText('กลับรายการอัตโนมัติ');
  await expect(list).toContainText('01/08/2569');

  await form.getByLabel('ชนิด').selectOption({ label: 'ค่าใช้จ่ายจ่ายล่วงหน้า' });
  await form.getByLabel('ตอนรับ/จ่ายเงินบันทึกไว้เป็น').selectOption({ label: 'สินทรัพย์' });
  await expect(form.getByLabel('กลับรายการอัตโนมัติวันแรกของงวดถัดไป')).toBeDisabled();
  await form.getByLabel('บัญชีค่าใช้จ่าย').selectOption('5220');
  await form.getByLabel('จำนวนเงิน').fill('1000');
  await expect(form.getByText('จะลง AJ: เดบิต 5220 ค่าเช่า / เครดิต 1510 ค่าใช้จ่ายจ่ายล่วงหน้า 1,000.00')).toBeVisible();
  await form.getByRole('button', { name: 'ผ่านรายการปรับปรุง' }).click();
  await expect(form.getByRole('status')).toHaveText(/^ผ่านรายการเลขที่ AJ-\d{4}$/);
  await checkScreen(page, info, 'adjustments-list');

  await page.goto(`${home}/books?month=2026-08&book=general`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('สมุดรายวันทั่วไป');
  await expect(page.getByText(/กลับรายการปรับปรุง AJ-\d{4}/).locator('visible=true').first()).toBeVisible();
  expect(errors).toEqual([]);
});
