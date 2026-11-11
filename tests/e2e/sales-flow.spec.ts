import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import { checkScreen, freshStudentHome, isPhone, watchErrors } from './helpers';

// ใบเสนอราคา → ใบสั่งขาย → รับเงินมัดจำ → ขายเชื่อจากใบสั่งขาย (ส่ง 6 จาก 10 หักมัดจำ 1,070) → ใบวางบิล (docs/phase5-spec.md ข้อ 4)

function taxId(first12: string) {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(first12[i]) * (13 - i);
  return first12 + ((11 - (sum % 11)) % 10);
}

/** มือถือ: เดินขั้นของฟอร์มเอกสารขายจนถึงขั้นผ่านรายการ (จอใหญ่เห็นทุกขั้นพร้อมกัน) */
async function toLastStep(page: Page, phone: boolean, from = 0) {
  if (!phone) return;
  const names = ['รายการ', 'ตรวจยอดและภาษี', 'ผ่านรายการ'];
  for (const n of names.slice(from)) await page.getByRole('button', { name: `ถัดไป: ${n}` }).click();
}

test('ขายครบวงจร: ใบเสนอราคา → ใบสั่งขาย → มัดจำ → ขายเชื่อหักมัดจำ → ใบวางบิล', async ({ page, browser, baseURL }, info) => {
  test.setTimeout(180_000);
  const errors = watchErrors(page);
  const phone = isPhone(info);
  const { home, co } = await freshStudentHome(page, browser, info, new URL(baseURL!).origin, 'ขายครบวงจร');
  const api = `/api/companies/${co}`;
  const profile = await (await page.request.get(`${api}/profile`)).json();
  expect((await page.request.patch(`${api}/profile`, { data: { version: profile.version, taxId: taxId('010555801234'), vatRegistered: true } })).ok()).toBe(true);
  for (const [path, data] of [
    ['/parties', { code: 'C1', name: 'บริษัท ลูกค้าหนึ่ง จำกัด', isCustomer: true, isVendor: false, creditDays: 30, vatRegistered: true, taxId: taxId('010555900077') }],
    ['/items', { code: 'P', name: 'เครื่องกรองน้ำ', unit: 'เครื่อง', isService: false, salePrice: '1000' }],
  ] as const) expect((await page.request.post(`${api}${path}`, { headers: { 'idempotency-key': randomUUID() }, data })).status()).toBe(201);

  // ใบเสนอราคา 10 เครื่อง
  await page.goto(`${home}/sales/new?kind=quotation`);
  await expect(page.getByRole('heading', { name: 'ใบเสนอราคา (ร่าง)' })).toBeVisible();
  await page.getByRole('textbox', { name: 'ลูกค้า' }).fill('C1');
  await page.getByRole('button', { name: /C1/ }).click();
  if (phone) await page.getByRole('button', { name: 'ถัดไป: รายการ' }).click();
  await page.getByRole('combobox', { name: 'รายละเอียด 1' }).fill('P');
  await page.getByRole('option', { name: /เครื่องกรองน้ำ/ }).click();
  await page.getByLabel(/^จำนวน/).first().fill('10');
  await toLastStep(page, phone, 1);
  await checkScreen(page, info, 'quotation-form');
  await page.getByRole('button', { name: /^บันทึกใบเสนอราคา/ }).click();
  await page.waitForURL(/\/sales\/orders\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('status').filter({ hasText: 'รออนุมัติ' })).toBeVisible();
  await expect(page.getByText('ใบเสนอราคา', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('10,700.00').first()).toBeVisible();

  // ใบสั่งขายจากใบเสนอราคา
  await page.getByRole('link', { name: 'สร้างใบสั่งขายจากใบนี้' }).click();
  await expect(page.getByText(/ใบสั่งขายจากใบเสนอราคา QT-0001/)).toBeVisible();
  await toLastStep(page, phone);
  await page.getByRole('button', { name: /^บันทึกใบสั่งขาย/ }).click();
  await page.waitForURL(/\/sales\/orders\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('status').filter({ hasText: 'ยังไม่ได้ส่ง' })).toBeVisible();
  const soUrl = page.url();
  await checkScreen(page, info, 'sales-order');

  // รับเงินมัดจำตามใบสั่งขาย 2,000 + VAT 140
  await page.getByRole('link', { name: 'รับเงินมัดจำตามใบสั่งขายนี้' }).click();
  await page.getByLabel('จำนวนเงินมัดจำ').fill('2000');
  await expect(page.getByText('2,140.00')).toBeVisible();
  await checkScreen(page, info, 'deposit-form');
  await page.getByRole('button', { name: 'ผ่านรายการรับเงินมัดจำ' }).click();
  await page.waitForURL(/\/sales\/documents\/[0-9a-f-]{36}$/);
  await expect(page.getByText('ใบรับเงินมัดจำ / ใบกำกับภาษี').first()).toBeVisible();

  // ขายเชื่อจากใบสั่งขาย ส่ง 6 เครื่อง หักมัดจำ 1,070
  await page.goto(soUrl);
  await page.getByRole('link', { name: 'ขายเชื่อจากใบสั่งขายนี้' }).click();
  await expect(page.getByText(/ขายเชื่อจากใบสั่งขาย SO-0001/)).toBeVisible();
  if (phone) await page.getByRole('button', { name: 'ถัดไป: รายการ' }).click();
  await page.getByLabel(/^จำนวน/).first().fill('6');
  if (phone) await page.getByRole('button', { name: 'ถัดไป: ตรวจยอดและภาษี' }).click();
  const totals = page.getByRole('region', { name: 'ตรวจยอดและภาษี' });
  await totals.getByRole('checkbox', { name: /DP-0001/ }).check();
  await totals.getByLabel('ยอดที่หักจาก DP-0001').fill('1070');
  await expect(totals.getByText('5,350.00')).toBeVisible(); // 6,420 − 1,070
  if (phone) await page.getByRole('button', { name: 'ถัดไป: ผ่านรายการ' }).click();
  await checkScreen(page, info, 'invoice-from-order');
  await page.getByRole('button', { name: /^ผ่านรายการ/ }).click();
  await page.waitForURL(/\/sales\/documents\/[0-9a-f-]{36}$/);
  await expect(page.getByText('หักเงินมัดจำ', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('5,350.00').first()).toBeVisible();
  await page.goto(soUrl);
  await expect(page.getByRole('status').filter({ hasText: 'ส่งบางส่วน' })).toBeVisible();
  await expect(page.getByText('6 / 10 เครื่อง')).toBeVisible();

  // ใบวางบิล
  await page.goto(`${home}/sales/billing/new`);
  await page.getByRole('combobox', { name: 'ลูกค้า', exact: true }).selectOption('C1');
  await expect(page.getByRole('checkbox', { name: /IV-0001/ })).toBeChecked();
  await page.getByRole('button', { name: 'บันทึกใบวางบิล' }).click();
  await page.waitForURL(/\/sales\/billing\/[0-9a-f-]{36}$/);
  await expect(page.getByText('BL-0001')).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'รอชำระ' })).toBeVisible();
  await expect(page.getByText('5,350.00').first()).toBeVisible();
  await checkScreen(page, info, 'billing-note');
  expect(errors).toEqual([]);
});
