import { randomUUID } from 'node:crypto';
import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { checkScreen, isPhone, studentHome, watchErrors } from './helpers';

// เฟส 2.3 ซื้อ: บันทึกซื้อเชื่อบริการตามขั้น (เห็นรายการบัญชีที่จะเกิด) → จ่ายชำระพร้อมหัก 3% → ใบสำคัญจ่าย + 50 ทวิ
// · ซื้อสดจากผู้ขายไม่จด VAT → ยกเลิกพร้อมเหตุผล · เจ้าหนี้คงค้าง
// เตรียมผู้ขาย/บริการผ่าน API รหัสต่อท้ายชื่อจอ บริษัทเดียวกันทุกจอ (เลขที่ของผู้ขายสุ่มทุกครั้ง รันซ้ำบนฐานเดิมได้)

function taxId(first12: string) {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(first12[i]) * (13 - i);
  return first12 + ((11 - (sum % 11)) % 10);
}
const tag = (info: TestInfo) => info.project.name.toUpperCase().replace(/[^A-Z0-9]/g, '');

async function setup(page: Page, info: TestInfo) {
  const home = await studentHome(page);
  const co = home.split('/')[2]!;
  const t = tag(info);
  const api = `/api/companies/${co}`;
  // API ตรวจ origin ของคำขอที่เปลี่ยนข้อมูล (กัน CSRF) คำขอจากเทสต์จึงต้องบอก origin ของเว็บ
  await page.context().setExtraHTTPHeaders({ origin: new URL(page.url()).origin });
  const profile = await (await page.request.get(`${api}/profile`)).json();
  if (!profile.taxId || !profile.vatRegistered) {
    const r = await page.request.patch(`${api}/profile`, { data: { version: profile.version, taxId: taxId('010555801234'), vatRegistered: true, address: '99 ถนนสุขุมวิท กรุงเทพฯ' } });
    expect(r.ok()).toBe(true);
  }
  for (const r of [
    await page.request.post(`${api}/parties`, { data: { code: `PV-${t}`, name: `บริษัท ออกแบบ ${t} จำกัด`, isCustomer: false, isVendor: true, creditDays: 30,
      vatRegistered: true, taxId: taxId('010555900088'), whtKind: 'service' } }),
    await page.request.post(`${api}/parties`, { data: { code: `NV-${t}`, name: `ร้านป้าแดง ${t}`, isCustomer: false, isVendor: true } }),
    await page.request.post(`${api}/items`, { data: { code: `DS-${t}`, name: 'ค่าออกแบบโลโก้', unit: 'งาน', isService: true, purchasePrice: '10000' } }),
  ]) expect([201, 409]).toContain(r.status());
  return { home, t, api };
}

test('ซื้อเชื่อบริการ → จ่ายชำระหัก ณ ที่จ่าย → ใบสำคัญจ่ายพร้อม 50 ทวิ', async ({ page }, info) => {
  const errors = watchErrors(page);
  const { home, t } = await setup(page, info);
  const phone = isPhone(info);
  const vendorNo = `INV-${randomUUID().slice(0, 6)}`;
  await page.goto(`${home}/purchases/new?kind=invoice`);
  await expect(page.getByRole('heading', { name: 'บันทึกซื้อเชื่อ (ร่าง)' })).toBeVisible();

  await page.getByRole('textbox', { name: 'ผู้ขาย', exact: true }).fill(`PV-${t}`);
  await page.getByRole('button', { name: new RegExp(`PV-${t}`) }).click();
  await page.getByLabel('เลขที่ใบกำกับ/ใบเสร็จของผู้ขาย').fill(vendorNo);
  if (phone) await page.getByRole('button', { name: 'ถัดไป: รายการ' }).click();

  await page.getByRole('combobox', { name: 'รายละเอียด 1' }).fill(`DS-${t}`);
  await page.getByRole('option', { name: new RegExp(`DS-${t}`) }).click();
  await expect(page.getByLabel('ลงบัญชี 1')).toHaveValue('5260');
  await expect(page.getByText('ภาษีซื้อถึงกำหนดเมื่อจ่ายเงิน', { exact: false })).toBeVisible();
  if (phone) {
    await page.getByRole('button', { name: 'ถัดไป: ตรวจยอดและภาษี' }).click();
    await page.getByRole('button', { name: 'ถัดไป: บันทึก' }).click();
  }
  // รายการบัญชีที่จะเกิด: ค่าใช้จ่าย + ภาษีซื้อยังไม่ถึงกำหนด / เจ้าหนี้
  const entry = page.getByRole('table').filter({ hasText: 'ภาษีซื้อยังไม่ถึงกำหนด' }).filter({ visible: true });
  await expect(entry).toContainText('10,700.00');
  await expect(entry.getByRole('row', { name: /2110 เจ้าหนี้การค้า/ })).toContainText('10,700.00');
  await checkScreen(page, info, 'purchase-form');
  await page.getByRole('button', { name: /^บันทึก/ }).click();

  await page.waitForURL(/\/purchases\/documents\/[0-9a-f-]{36}$/);
  await expect(page.getByText(/^PI-\d{4}$/).first()).toBeVisible();
  await expect(page.getByText(vendorNo)).toBeVisible();
  await expect(page.getByText('ยอดค้าง 10,700.00')).toBeVisible();
  await checkScreen(page, info, 'purchase-posted');

  // จ่ายชำระใบนี้: หักตามที่ตั้งไว้ที่ผู้ขาย (ค่าบริการ 3%) ฐาน 10,000 → 300 จ่ายสุทธิ 10,400
  await page.getByRole('link', { name: 'จ่ายชำระใบนี้' }).click();
  await page.waitForURL(/\/purchases\/payments\/new/);
  await expect(page.getByLabel(/^จ่ายครั้งนี้ PI-/).last()).toHaveValue('10700.00');
  await expect(page.getByLabel('หักภาษี ณ ที่จ่าย')).toHaveValue('service');
  await expect(page.getByText('10,000.00 × 3% = 300.00')).toBeVisible();
  await expect(page.getByText('10,400.00').first()).toBeVisible();
  await checkScreen(page, info, 'payment-form');
  await page.getByRole('button', { name: /^บันทึก/ }).click();

  await page.waitForURL(/\/purchases\/documents\/[0-9a-f-]{36}$/);
  await expect(page.getByText(/^PV-\d{4}$/).first()).toBeVisible();
  await expect(page.getByText('ใบสำคัญจ่าย', { exact: true })).toBeVisible();
  const cert = page.getByRole('article', { name: 'หนังสือรับรองการหักภาษี ณ ที่จ่าย' });
  await expect(cert.getByText(/^WT-\d{4}$/)).toBeVisible();
  await expect(cert.getByText('☒ ภ.ง.ด.53')).toBeVisible();
  await expect(cert.getByText('(สามร้อยบาทถ้วน)')).toBeVisible();
  await checkScreen(page, info, 'payment-posted');
  expect(errors).toEqual([]);
});

test('ซื้อสดจากผู้ขายไม่จด VAT → ยกเลิกพร้อมเหตุผล · เจ้าหนี้คงค้าง', async ({ page }, info) => {
  const errors = watchErrors(page);
  const { home, t, api } = await setup(page, info);
  const pi = await (await page.request.post(`${api}/purchases/invoice`, {
    headers: { 'idempotency-key': randomUUID() },
    data: { date: new Date().toISOString().slice(0, 10), partyCode: `PV-${t}`, vendorDocNo: `AP-${randomUUID().slice(0, 6)}`, lines: [{ itemCode: `DS-${t}`, qty: '1', unitPrice: '2000' }] },
  })).json();
  expect(pi.docNo).toMatch(/^PI-\d{4}$/);

  await page.goto(`${home}/purchases/new?kind=cash-purchase`);
  await page.getByRole('textbox', { name: 'ผู้ขาย', exact: true }).fill(`NV-${t}`);
  await page.getByRole('button', { name: new RegExp(`NV-${t}`) }).click();
  await expect(page.getByText('ผู้ขายรายนี้ไม่จด VAT', { exact: false }).first()).toBeVisible();
  await page.getByLabel('เลขที่ใบกำกับ/ใบเสร็จของผู้ขาย').fill(`R-${randomUUID().slice(0, 6)}`);
  if (isPhone(info)) await page.getByRole('button', { name: 'ถัดไป: รายการ' }).click();
  await page.getByRole('combobox', { name: 'รายละเอียด 1' }).fill('ค่าน้ำแข็งงานเลี้ยง');
  await page.getByLabel('ราคาต่อหน่วย').first().fill('450');
  await page.getByLabel('ลงบัญชี 1').selectOption('5260');
  if (isPhone(info)) {
    await page.getByRole('button', { name: 'ถัดไป: ตรวจยอดและภาษี' }).click();
    await page.getByRole('button', { name: 'ถัดไป: บันทึก' }).click();
  }
  await checkScreen(page, info, 'cash-purchase-form');
  await page.getByRole('button', { name: /^บันทึก/ }).click();
  await page.waitForURL(/\/purchases\/documents\/[0-9a-f-]{36}$/);
  await expect(page.getByText(/^CP-\d{4}$/).first()).toBeVisible();

  await page.getByRole('button', { name: 'ยกเลิกเอกสาร' }).click();
  await page.getByLabel('เหตุผลที่ยกเลิก').fill('บันทึกผิดบริษัท');
  await page.getByRole('button', { name: 'ยืนยันยกเลิก' }).click();
  await expect(page.getByText(/ยกเลิกแล้ว .* เหตุผล: บันทึกผิดบริษัท \(กลับรายการ RV-\d{4}\)/)).toBeVisible();

  await page.goto(`${home}/purchases/payables`);
  await expect(page.getByRole('link', { name: new RegExp(`${pi.docNo}.*2,140\\.00`) })).toBeVisible();
  await checkScreen(page, info, 'payables');
  await page.goto(`${home}/purchases`);
  await expect(page.getByRole('link', { name: pi.docNo }).first()).toBeVisible();
  await checkScreen(page, info, 'purchase-list');
  expect(errors).toEqual([]);
});
