import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import { checkScreen, freshStudentHome, isPhone, watchErrors } from './helpers';

// ใบสั่งซื้อ → จ่ายมัดจำ → ใบรับสินค้า (รับ 6 จาก 10) → ซื้อเชื่อจากใบรับสินค้า หักมัดจำ 1,070 (docs/phase5-spec.md ข้อ 5)

function taxId(first12: string) {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(first12[i]) * (13 - i);
  return first12 + ((11 - (sum % 11)) % 10);
}

/** มือถือ: เดินขั้นของฟอร์มบันทึกซื้อจากขั้นที่ from จนถึงขั้นบันทึก (จอใหญ่เห็นทุกขั้นพร้อมกัน) */
async function toLastStep(page: Page, phone: boolean, from = 0) {
  if (!phone) return;
  for (const n of ['รายการ', 'ตรวจยอดและภาษี', 'บันทึก'].slice(from)) await page.getByRole('button', { name: `ถัดไป: ${n}` }).click();
}

test('ซื้อครบวงจร: ใบสั่งซื้อ → มัดจำ → ใบรับสินค้า → ซื้อเชื่อจากใบรับสินค้าหักมัดจำ', async ({ page, browser, baseURL }, info) => {
  test.setTimeout(180_000);
  const errors = watchErrors(page);
  const phone = isPhone(info);
  const { home, co } = await freshStudentHome(page, browser, info, new URL(baseURL!).origin, 'ซื้อครบวงจร');
  const api = `/api/companies/${co}`;
  const profile = await (await page.request.get(`${api}/profile`)).json();
  expect((await page.request.patch(`${api}/profile`, { data: { version: profile.version, taxId: taxId('010555801234'), vatRegistered: true } })).ok()).toBe(true);
  for (const [path, data] of [
    ['/parties', { code: 'V1', name: 'บริษัท ผู้ขายหนึ่ง จำกัด', isCustomer: false, isVendor: true, creditDays: 30, vatRegistered: true, taxId: taxId('010555900077') }],
    ['/items', { code: 'P', name: 'ไส้กรองน้ำ', unit: 'ชิ้น', isService: false, trackInventory: true, purchasePrice: '500' }],
  ] as const) expect((await page.request.post(`${api}${path}`, { headers: { 'idempotency-key': randomUUID() }, data })).status()).toBe(201);

  // ใบสั่งซื้อ 10 ชิ้น × 500
  await page.goto(`${home}/purchases/orders/new`);
  await expect(page.getByRole('heading', { name: 'ใบสั่งซื้อ (ร่าง)' })).toBeVisible();
  await page.getByRole('combobox', { name: 'ผู้ขาย', exact: true }).selectOption('V1');
  await page.getByRole('combobox', { name: 'สินค้า 1', exact: true }).selectOption('P');
  await page.getByLabel(/^จำนวน/).first().fill('10');
  await expect(page.getByText('5,350.00')).toBeVisible();
  await checkScreen(page, info, 'purchase-order-form');
  await page.getByRole('button', { name: 'บันทึกใบสั่งซื้อ' }).click();
  await page.waitForURL(/\/purchases\/orders\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('status').filter({ hasText: 'ยังไม่ได้รับ' })).toBeVisible();
  const poUrl = page.url();
  await checkScreen(page, info, 'purchase-order');

  // จ่ายมัดจำ 1,000 + ภาษี 70 ตามใบสั่งซื้อ
  await page.getByRole('link', { name: 'จ่ายเงินมัดจำตามใบสั่งซื้อนี้' }).click();
  await page.getByLabel('เลขที่ใบรับเงินมัดจำ/ใบกำกับภาษีของผู้ขาย').fill('DEP-1');
  await page.getByLabel('จำนวนเงินมัดจำ').fill('1000');
  await expect(page.getByText('1,070.00')).toBeVisible();
  await checkScreen(page, info, 'purchase-deposit-form');
  await page.getByRole('button', { name: 'ผ่านรายการจ่ายเงินมัดจำ' }).click();
  await page.waitForURL(/\/purchases\/documents\/[0-9a-f-]{36}$/);
  await expect(page.getByText('บันทึกจ่ายเงินมัดจำ').first()).toBeVisible();

  // รับสินค้า 6 ชิ้นตามใบสั่งซื้อ: ลง 5110 / 2130
  await page.goto(poUrl);
  await page.getByRole('link', { name: 'รับสินค้าตามใบสั่งซื้อนี้' }).click();
  await expect(page.getByRole('heading', { name: 'ใบรับสินค้า (ร่าง)' })).toBeVisible();
  await page.getByLabel('เลขที่ใบส่งของของผู้ขาย').fill('DN-1');
  await page.getByLabel(/^จำนวน/).first().fill('6');
  const grEntry = page.getByRole('table').filter({ hasText: 'สินค้ารับแล้วยังไม่ได้รับใบแจ้งหนี้' });
  await expect(grEntry).toContainText('3,000.00');
  await checkScreen(page, info, 'goods-receipt-form');
  await page.getByRole('button', { name: 'ผ่านรายการรับสินค้า' }).click();
  await page.waitForURL(/\/purchases\/documents\/[0-9a-f-]{36}$/);
  await expect(page.getByText('GR-0001').first()).toBeVisible();
  await expect(page.getByText('ได้ใบแจ้งหนี้ 0 / 6 ชิ้น')).toBeVisible();

  // ได้ใบกำกับ: ซื้อเชื่อจากใบรับสินค้านี้ หักมัดจำทั้งหมด → ค้าง 3,210 − 1,070 = 2,140
  await page.getByRole('link', { name: 'บันทึกซื้อเชื่อจากใบรับสินค้านี้' }).click();
  await expect(page.getByRole('heading', { name: 'บันทึกซื้อเชื่อ (ร่าง)' })).toBeVisible();
  await page.getByLabel('เลขที่ใบกำกับ/ใบเสร็จของผู้ขาย').fill('INV-1');
  await toLastStep(page, phone, 0);
  if (phone) await page.getByRole('button', { name: 'ย้อนกลับ' }).click(); // ขั้นตรวจยอด: เลือกหักมัดจำ
  const totals = page.getByRole('region', { name: 'ตรวจยอดและภาษี' });
  await totals.getByRole('checkbox', { name: /VD-0001/ }).check();
  await expect(totals.getByLabel('ยอดที่หักจาก VD-0001')).toHaveValue('1070.00');
  await expect(totals.getByText('2,140.00')).toBeVisible();
  await toLastStep(page, phone, 2);
  const entry = page.getByRole('table').filter({ hasText: 'เงินมัดจำจ่าย' }).filter({ visible: true });
  await expect(entry.getByRole('row', { name: /2130/ })).toContainText('3,000.00');
  await checkScreen(page, info, 'invoice-from-receipt');
  await page.getByRole('button', { name: /^บันทึก/ }).click();
  await page.waitForURL(/\/purchases\/documents\/[0-9a-f-]{36}$/);
  await expect(page.getByText(/^PI-\d{4}$/).first()).toBeVisible();
  await expect(page.getByText('ยอดค้าง 2,140.00')).toBeVisible();
  await expect(page.getByRole('region', { name: 'จับคู่ใบรับสินค้า / ใบซื้อ' }).getByText('GR-0001')).toBeVisible();
  await page.goto(poUrl);
  await expect(page.getByRole('status').filter({ hasText: 'รับบางส่วน' })).toBeVisible();
  await expect(page.getByText('6 / 10 ชิ้น')).toBeVisible();
  await checkScreen(page, info, 'purchase-order-partial');
  expect(errors).toEqual([]);
});
