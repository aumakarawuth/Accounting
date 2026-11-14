import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { checkScreen, freshStudentHome, watchErrors } from './helpers';

// ค่าเสื่อมตามจำนวนวัน + ขายสินทรัพย์ของบริษัทจด VAT (docs/phase5-spec.md ข้อ 10)
// ทุน 36,500 ได้มา 15 มี.ค. 2569 อายุ 1 ปี = 365 วัน วันละ 100 · ขาย 10 มิ.ย. 30,000 + VAT 2,100

function taxId(first12: string) {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(first12[i]) * (13 - i);
  return first12 + ((11 - (sum % 11)) % 10);
}

test('ลงทะเบียนรายวัน แล้วขายพร้อมออกใบกำกับภาษี', async ({ page, browser, baseURL }, info) => {
  test.setTimeout(120_000);
  const errors = watchErrors(page);
  const { home, co } = await freshStudentHome(page, browser, info, new URL(baseURL!).origin, 'ขายสินทรัพย์');
  const api = `/api/companies/${co}`;
  const post = async (path: string, data: object) => {
    const r = await page.request.post(`${api}${path}`, { headers: { 'idempotency-key': randomUUID() }, data });
    expect(r.status(), await r.text()).toBe(201);
    return r.json();
  };
  const profile = await (await page.request.get(`${api}/profile`)).json();
  expect((await page.request.patch(`${api}/profile`, { data: { version: profile.version, taxId: taxId('010555801299'), vatRegistered: true } })).ok()).toBe(true);
  await post('/parties', { code: 'C1', name: 'บริษัท ผู้ซื้อรถ จำกัด', isCustomer: true, isVendor: false, taxId: taxId('010555802299') });
  await post('/journal', { date: '2026-01-02', description: 'ลงทุน', lines: [{ account_code: '1120', debit: '100000' }, { account_code: '3110', credit: '100000' }] });

  // ลงทะเบียนแบบตามจำนวนวัน
  await page.goto(`${home}/fixed-assets?month=2026-03`);
  await page.getByRole('button', { name: 'ลงทะเบียนสินทรัพย์', exact: true }).click();
  const form = page.getByRole('region', { name: 'ลงทะเบียนสินทรัพย์ถาวร' });
  await form.getByLabel('รหัสสินทรัพย์').fill('VAN');
  await form.getByLabel('ชื่อสินทรัพย์').fill('รถตู้');
  await form.getByLabel('วันที่ได้มา (วว/ดด/ปปปป)').fill('15032569');
  await form.getByLabel('ราคาทุน', { exact: true }).fill('36500');
  await form.getByLabel('อายุใช้งาน (ปี)').fill('1');
  await form.getByLabel('วิธีคิดค่าเสื่อม').selectOption('daily');
  await form.getByLabel('บันทึกการได้มา').selectOption('1120');
  await expect(form.getByText('ค่าเสื่อมวันละ 100.00 · ทั้งอายุ 365 วัน · เดือนแรก 1,700.00')).toBeVisible();
  await form.getByRole('button', { name: 'บันทึกทะเบียน' }).click();
  await expect(form).toBeHidden();
  await expect(page.getByText(/ตามจำนวนวัน/).filter({ visible: true }).first()).toBeVisible();

  // ค่าเสื่อม มี.ค.–พ.ค. 1,700 + 3,000 + 3,100 = 7,800
  for (const month of ['2026-03', '2026-04', '2026-05']) await post('/depreciation', { month });

  // ขาย 10 มิ.ย.: ค่าเสื่อม 9 วัน 900 · ตามบัญชี 27,800 · กำไร 2,200
  await page.goto(`${home}/fixed-assets?month=2026-06`);
  await page.getByRole('button', { name: 'จำหน่าย / ขาย' }).click();
  const sale = page.getByRole('region', { name: 'จำหน่ายสินทรัพย์ VAN' });
  await sale.getByLabel('วันที่จำหน่าย (วว/ดด/ปปปป)').fill('10062569');
  await sale.getByLabel('ราคาขาย ไม่รวม VAT (ไม่มี = ตัดจำหน่าย)').fill('30000');
  await expect(sale.getByLabel('ผู้ซื้อ (ใบกำกับภาษี)')).toHaveValue('C1');
  await expect(sale.getByText('ค่าเสื่อม 9 วันในเดือนที่จำหน่าย 900.00')).toBeVisible();
  await expect(sale.getByText('บริษัทจด VAT: ออกใบกำกับภาษีเลขที่ FD ภาษีขาย 7% = 2,100.00 · รับเงินรวม 32,100.00')).toBeVisible();
  await expect(sale.getByText('มูลค่าตามบัญชี 27,800.00 · กำไร(ขาดทุน) 2,200.00')).toBeVisible();
  await checkScreen(page, info, 'asset-sale');
  await sale.getByRole('button', { name: 'ยืนยัน' }).click();
  await expect(sale).toBeHidden();
  await expect(page.getByText('จำหน่าย 10/06/2569 กำไร(ขาดทุน) 2,200.00').filter({ visible: true }).first()).toBeVisible();

  // รายงานภาษีขาย มิ.ย. มีใบกำกับภาษี FD-0001
  await page.goto(`${home}/tax/vat?month=2026-06`);
  await expect(page.getByRole('link', { name: /FD-0001/ }).filter({ visible: true }).first()).toBeVisible();
  await expect(page.getByText('บริษัท ผู้ซื้อรถ จำกัด').filter({ visible: true }).first()).toBeVisible();
  await expect(page.getByText('2,100.00').filter({ visible: true }).first()).toBeVisible();
  expect(errors).toEqual([]);
});
