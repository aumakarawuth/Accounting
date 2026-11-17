import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { checkScreen, freshStudentHome, watchErrors } from './helpers';

// ยอดยกมาพร้อมรายตัว (docs/phase5-spec.md ข้อ 3) ทุกจอ:
// เงินสด 30,000 + ลูกหนี้ 10,700 + คอมพิวเตอร์ 36,000 (ค่าเสื่อมสะสม 24,000) + สินค้า 100 × 52.50 = ทุน 57,950
// → OB-0001 → ลูกหนี้ยกมาอยู่ในหน้าลูกหนี้ ทะเบียนสินทรัพย์มีค่าเสื่อมสะสมยกมา

test('ยอดยกมา: ใส่รายตัว ผลต่างเป็นศูนย์ → ผ่านรายการ OB → ใช้ต่อในลูกหนี้/ทะเบียนสินทรัพย์', async ({ page, browser, baseURL }, info) => {
  test.setTimeout(120_000);
  const errors = watchErrors(page);
  const { home, co } = await freshStudentHome(page, browser, info, new URL(baseURL!).origin, 'ยอดยกมา');
  const api = (path: string, data: unknown) => page.request.post(`/api/companies/${co}${path}`, { headers: { 'idempotency-key': randomUUID() }, data });
  expect((await api('/parties', { code: 'C1', name: 'ร้าน ลูกค้าหนึ่ง', isCustomer: true, isVendor: false, creditDays: 30 })).status()).toBe(201);
  expect((await api('/items', { code: 'A', name: 'สินค้า A', unit: 'ชิ้น', isService: false, trackInventory: true })).status()).toBe(201);

  await page.goto(`${home}/opening`);
  await page.getByLabel('วันที่ยกมา').fill('31122568');
  const gl = (n: number) => page.getByRole('group', { name: `บัญชี ${n}` });
  await gl(1).getByRole('combobox', { name: 'บัญชี', exact: true }).selectOption('1110');
  await gl(1).getByLabel('เดบิต').fill('30000');

  await page.getByRole('button', { name: 'เพิ่มลูกค้า' }).click();
  const ar = page.getByRole('group', { name: 'ลูกค้า 1' });
  await ar.getByRole('combobox', { name: 'ลูกค้า', exact: true }).selectOption('C1');
  await ar.getByLabel('เลขที่ใบเดิม').fill('INV-9');
  await ar.getByLabel('วันที่ใบ').fill('15122568');
  await ar.getByLabel('ยอดค้าง').fill('10700');

  await page.getByRole('button', { name: 'เพิ่มสินทรัพย์ถาวร' }).click();
  const fa = page.getByRole('group', { name: 'สินทรัพย์ถาวร 1' });
  await fa.getByLabel('รหัส', { exact: true }).fill('FA-1');
  await fa.getByLabel('ชื่อ', { exact: true }).fill('คอมพิวเตอร์');
  await fa.getByLabel('วันที่ได้มา').fill('01012567');
  await fa.getByLabel('ราคาทุน').fill('36000');
  await fa.getByLabel('อายุ (เดือน)').fill('36');
  await fa.getByRole('combobox', { name: 'บัญชีสินทรัพย์', exact: true }).selectOption('1630');
  await fa.getByRole('combobox', { name: 'บัญชีค่าเสื่อมราคาสะสม', exact: true }).selectOption('1631');
  await fa.getByLabel('ค่าเสื่อมราคาสะสมยกมา').fill('24000');

  await page.getByRole('button', { name: 'เพิ่มสินค้า' }).click();
  const inv = page.getByRole('group', { name: 'สินค้า 1' });
  await inv.getByRole('combobox', { name: 'สินค้า', exact: true }).selectOption('A');
  await inv.getByLabel('จำนวน').fill('100');
  await inv.getByLabel('ต้นทุนต่อหน่วย').fill('52.50');
  await expect(inv.getByText('5,250.00')).toBeVisible();

  const bar = page.getByRole('status').filter({ hasText: 'เดบิต' });
  await expect(bar).toHaveText('เดบิต 81,950.00 · เครดิต 24,000.00 · ผลต่าง 57,950.00');
  await expect(page.getByRole('button', { name: 'ผ่านรายการยอดยกมา' })).toBeDisabled();
  await page.getByRole('button', { name: 'เพิ่มบัญชี' }).click();
  await gl(2).getByRole('combobox', { name: 'บัญชี', exact: true }).selectOption('3110');
  await gl(2).getByLabel('เครดิต').fill('57950');
  await expect(bar).toHaveText('เดบิต 81,950.00 · เครดิต 81,950.00 · ผลต่าง 0.00 · ดุล');
  // บัญชีคุมไม่อยู่ในรายการให้เลือก
  await expect(gl(2).getByRole('combobox', { name: 'บัญชี', exact: true }).locator('option[value="1210"]')).toHaveCount(0);
  await checkScreen(page, info, 'opening-form');
  await page.getByRole('button', { name: 'ผ่านรายการยอดยกมา' }).click();

  await expect(page.getByText('ผ่านรายการเลขที่ OB-0001')).toBeVisible();
  await expect(page.getByRole('link', { name: 'ยอดยกมา ณ 31/12/2568 · OB-0001' })).toBeVisible();
  const ars = page.getByRole('region', { name: 'ลูกหนี้รายใบ' });
  await expect(ars.getByRole('row').filter({ hasText: 'OB-0001/INV-9' })).toContainText('14/01/2569');
  await checkScreen(page, info, 'opening-posted');

  await page.goto(`${home}/sales/receivables`);
  await expect(page.getByText('OB-0001/INV-9').filter({ visible: true }).first()).toBeVisible();
  await page.goto(`${home}/fixed-assets?month=2025-12`);
  await expect(page.getByText('24,000.00').filter({ visible: true }).first()).toBeVisible();
  expect(errors).toEqual([]);
});
