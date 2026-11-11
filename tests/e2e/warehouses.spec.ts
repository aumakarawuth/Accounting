import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { checkScreen, freshStudentHome, isPhone, watchErrors } from './helpers';

// หลายคลัง (docs/phase5-spec.md ข้อ 8): เพิ่มคลัง → ซื้อเข้าคลังที่เลือก → โอนย้าย → ยอดแยกคลัง

function taxId(first12: string) {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(first12[i]) * (13 - i);
  return first12 + ((11 - (sum % 11)) % 10);
}

test('เพิ่มคลัง ซื้อเข้าคลังที่เลือก แล้วโอนย้าย', async ({ page, browser, baseURL }, info) => {
  test.setTimeout(120_000);
  const errors = watchErrors(page);
  const { home, co } = await freshStudentHome(page, browser, info, new URL(baseURL!).origin, 'หลายคลัง');
  const api = `/api/companies/${co}`;
  const post = async (path: string, data: object) => {
    const r = await page.request.post(`${api}${path}`, { headers: { 'idempotency-key': randomUUID() }, data });
    expect(r.status(), await r.text()).toBe(201);
    return r.json();
  };
  const profile = await (await page.request.get(`${api}/profile`)).json();
  expect((await page.request.patch(`${api}/profile`, { data: { version: profile.version, taxId: taxId('010555801234') } })).ok()).toBe(true);
  await post('/parties', { code: 'V1', name: 'ร้าน ผู้ขายหนึ่ง', isCustomer: false, isVendor: true });
  await post('/items', { code: 'P', name: 'ไส้กรองน้ำ', unit: 'ชิ้น', isService: false, trackInventory: true, purchasePrice: '100' });

  // เพิ่มคลัง BKK
  await page.goto(`${home}/inventory/warehouses`);
  const add = page.getByRole('form', { name: 'เพิ่มคลัง' });
  await add.getByLabel('รหัสคลัง').fill('BKK');
  await add.getByLabel('ชื่อคลัง').fill('คลังกรุงเทพ');
  await add.getByRole('button', { name: 'เพิ่มคลัง' }).click();
  await expect(page.getByRole('region', { name: 'คลังทั้งหมด' }).getByText('คลังกรุงเทพ', { exact: true })).toBeVisible();

  // ซื้อเชื่อเข้าคลัง BKK 10 ชิ้น
  await page.goto(`${home}/purchases/new?kind=invoice`);
  await page.getByRole('textbox', { name: 'ผู้ขาย', exact: true }).fill('V1');
  await page.getByRole('button', { name: /V1/ }).click();
  await page.getByLabel('เลขที่ใบกำกับ/ใบเสร็จของผู้ขาย').fill(`INV-${randomUUID().slice(0, 6)}`);
  await page.getByRole('combobox', { name: 'คลัง', exact: true }).selectOption('BKK');
  if (isPhone(info)) await page.getByRole('button', { name: 'ถัดไป: รายการ' }).click();
  await page.getByRole('combobox', { name: 'รายละเอียด 1' }).fill('P');
  await page.getByRole('option', { name: /ไส้กรองน้ำ/ }).click();
  await page.getByLabel(/^จำนวน/).first().fill('10');
  if (isPhone(info)) {
    await page.getByRole('button', { name: 'ถัดไป: ตรวจยอดและภาษี' }).click();
    await page.getByRole('button', { name: 'ถัดไป: บันทึก' }).click();
  }
  await page.getByRole('button', { name: /^บันทึก/ }).click();
  await page.waitForURL(/\/purchases\/documents\/[0-9a-f-]{36}$/);
  await expect(page.getByText('คลัง BKK คลังกรุงเทพ')).toBeVisible();

  // โอน 4 ชิ้น BKK → MAIN
  await page.goto(`${home}/inventory/warehouses`);
  const form = page.getByRole('form', { name: 'โอนย้ายสินค้า' });
  await form.getByRole('combobox', { name: 'จากคลัง', exact: true }).selectOption('BKK');
  await form.getByRole('combobox', { name: 'ไปคลัง', exact: true }).selectOption('MAIN');
  await form.getByLabel('จำนวน 1').fill('4');
  await form.getByRole('button', { name: 'บันทึกการโอนย้าย' }).click();
  await expect(form.getByRole('status')).toHaveText('บันทึกแล้ว เลขที่ TR-0001');
  const stock = page.getByRole('region', { name: 'คงเหลือตามคลัง' });
  await expect(stock.getByRole('row').filter({ hasText: 'BKK' })).toContainText('6 ชิ้น');
  await expect(stock.getByRole('row').filter({ hasText: 'MAIN' })).toContainText('4 ชิ้น');
  await checkScreen(page, info, 'warehouses');
  // หน้าสินค้าคงเหลือแสดงยอดแยกคลัง มูลค่ารวมเท่าเดิม
  await page.goto(`${home}/inventory`);
  await expect(page.getByText('BKK 6 · MAIN 4')).toBeVisible();
  await expect(page.getByText('1,000.00').first()).toBeVisible();
  expect(errors).toEqual([]);
});
