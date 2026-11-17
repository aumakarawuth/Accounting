import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { checkScreen, freshStudentHome, watchErrors } from './helpers';

// ส่วนลดเงินสดตอนรับชำระ/จ่ายชำระ (docs/phase5-spec.md ข้อ 6): ใส่ส่วนลด ยอดรับ/จ่ายลดให้เอง เห็นรายการบัญชี 4210 / 5120

function taxId(first12: string) {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(first12[i]) * (13 - i);
  return first12 + ((11 - (sum % 11)) % 10);
}

test('รับชำระและจ่ายชำระพร้อมส่วนลดเงินสด', async ({ page, browser, baseURL }, info) => {
  test.setTimeout(120_000);
  const errors = watchErrors(page);
  const { home, co } = await freshStudentHome(page, browser, info, new URL(baseURL!).origin, 'ส่วนลดเงินสด');
  const api = `/api/companies/${co}`;
  const post = async (path: string, data: object) => {
    const r = await page.request.post(`${api}${path}`, { headers: { 'idempotency-key': randomUUID() }, data });
    expect(r.status(), await r.text()).toBe(201);
    return r.json();
  };
  const profile = await (await page.request.get(`${api}/profile`)).json();
  expect((await page.request.patch(`${api}/profile`, { data: { version: profile.version, taxId: taxId('010555801234'), vatRegistered: true } })).ok()).toBe(true);
  await post('/parties', { code: 'C1', name: 'ร้าน ลูกค้าหนึ่ง', isCustomer: true, isVendor: false, creditDays: 30 });
  await post('/parties', { code: 'V1', name: 'บริษัท ผู้ขายหนึ่ง จำกัด', isCustomer: false, isVendor: true, creditDays: 30, vatRegistered: true, taxId: taxId('010555900077') });
  await post('/items', { code: 'P', name: 'สินค้า', unit: 'ชิ้น', isService: false });
  const today = new Date().toISOString().slice(0, 10);
  const iv = await post('/sales/invoice', { date: today, partyCode: 'C1', lines: [{ itemCode: 'P', qty: '10', unitPrice: '1000' }] });
  const pi = await post('/purchases/invoice', { date: today, partyCode: 'V1', vendorDocNo: 'A-1', lines: [{ itemCode: 'P', qty: '20', unitPrice: '1000' }] });

  // รับชำระ 10,700 ให้ส่วนลด 214 → รับเงิน 10,486
  await page.goto(`${home}/sales/receipts/new?party=C1&doc=${iv.id}`);
  await page.getByLabel(`ส่วนลดเงินสด ${iv.docNo}`).fill('214');
  await expect(page.getByLabel(`รับครั้งนี้ ${iv.docNo}`).last()).toHaveValue('10486.00');
  await expect(page.getByText('ตัดหนี้รวม')).toBeVisible();
  await expect(page.getByText('214.00')).toBeVisible();
  await checkScreen(page, info, 'receipt-discount');
  await page.getByRole('button', { name: /^ผ่านรายการ|^บันทึก/ }).click();
  await page.waitForURL(/\/sales\/documents\/[0-9a-f-]{36}$/);
  await expect(page.getByText('ส่วนลดเงินสด').first()).toBeVisible();
  await expect(page.getByText('10,486.00').first()).toBeVisible();

  // จ่ายชำระ 21,400 ได้ส่วนลด 400 → จ่ายเงิน 21,000
  await page.goto(`${home}/purchases/payments/new?party=V1&doc=${pi.id}`);
  await page.getByLabel(`ส่วนลดเงินสด ${pi.docNo}`).fill('400');
  await expect(page.getByLabel(`จ่ายครั้งนี้ ${pi.docNo}`).last()).toHaveValue('21000.00');
  const pv = page.getByRole('table').filter({ hasText: 'ส่วนลดรับ' }).filter({ visible: true });
  await expect(pv.getByRole('row', { name: /5120/ })).toContainText('400.00');
  await checkScreen(page, info, 'payment-discount');
  await page.getByRole('button', { name: /^บันทึก/ }).click();
  await page.waitForURL(/\/purchases\/documents\/[0-9a-f-]{36}$/);
  await expect(page.getByText('ส่วนลดเงินสด').first()).toBeVisible();
  await expect(page.getByText('21,000.00').first()).toBeVisible();
  expect(errors).toEqual([]);
});
