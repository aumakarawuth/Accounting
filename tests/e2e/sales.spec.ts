import { randomUUID } from 'node:crypto';
import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { checkScreen, isPhone, studentHome, watchErrors } from './helpers';

// เฟส 2.2 ขาย: ออกใบกำกับภาษี (มือถือ 4 ขั้น / จอใหญ่มีกระดาษตัวอย่าง) → ใบที่ผ่านแล้ว → รับชำระ → ลูกหนี้ → ยกเลิก
// เตรียมลูกค้า/สินค้าผ่าน API (หน้าจอข้อมูลหลักมีเทสต์ของตัวเองแล้ว) รหัสต่อท้ายชื่อจอ บริษัทเดียวกันทุกจอ

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
  // สร้างซ้ำได้ (รันซ้ำบนฐานเดิม) 409 = มีอยู่แล้ว
  for (const r of [
    await page.request.post(`${api}/parties`, { data: { code: `SC-${t}`, name: `บริษัท ลูกค้าขาย ${t} จำกัด`, isCustomer: true, isVendor: false, creditDays: 30, vatRegistered: true, taxId: taxId('010555900077') } }),
    await page.request.post(`${api}/items`, { data: { code: `PA-${t}`, name: 'กระดาษ A4', unit: 'รีม', isService: false, salePrice: '120' } }),
  ]) expect([201, 409]).toContain(r.status());
  return { home, co, t, api };
}

test('ใบกำกับภาษี: กรอกตามขั้น เห็นกระดาษตัวอย่าง ผ่านรายการแล้วรับชำระ', async ({ page }, info) => {
  const errors = watchErrors(page);
  const { home, t } = await setup(page, info);
  const phone = isPhone(info);
  let posts = 0;
  page.on('request', (r) => { if (r.method() === 'POST' && /\/sales\/invoice$/.test(r.url())) posts++; });
  await page.goto(`${home}/sales/new?kind=invoice`);
  await expect(page.getByRole('heading', { name: 'ใบกำกับภาษี / ใบแจ้งหนี้ (ร่าง)' })).toBeVisible();

  // ขั้น 1 ลูกค้า
  await page.getByRole('textbox', { name: 'ลูกค้า' }).fill(`SC-${t}`);
  await page.getByRole('button', { name: new RegExp(`SC-${t}`) }).click();
  if (phone) {
    await expect(page.getByText('ขั้น 1 จาก 4 · ลูกค้า')).toBeVisible();
    await page.getByRole('button', { name: 'ถัดไป: รายการ' }).click();
    await expect(page.getByText('ขั้น 2 จาก 4 · รายการ')).toBeVisible();
  }

  // ขั้น 2 รายการ: ค้นสินค้าด้วยรหัส เลือกแล้วได้ราคาขาย
  await page.getByRole('combobox', { name: 'รายละเอียด 1' }).fill(`PA-${t}`);
  await page.getByRole('option', { name: new RegExp(`PA-${t}`) }).click();
  await expect(page.getByRole('combobox', { name: 'รายละเอียด 1' })).toHaveValue('กระดาษ A4');
  await page.getByLabel(/^จำนวน/).first().fill('10');
  if (phone) {
    await checkScreen(page, info, 'invoice-step2');
    await page.getByRole('button', { name: 'ดูตัวอย่างกระดาษ' }).click();
    await expect(page.getByText('หนึ่งพันสองร้อยแปดสิบสี่บาทถ้วน').filter({ visible: true })).toBeVisible();
    await page.getByRole('button', { name: 'กลับไปแก้ร่าง' }).click();
    await page.getByRole('button', { name: 'ถัดไป: ตรวจยอดและภาษี' }).click();
  }

  // ขั้น 3 ยอดและภาษี: 1,200 + VAT 7% = 1,284
  const totals = page.getByRole('region', { name: 'ตรวจยอดและภาษี' });
  await expect(totals.getByText('1,284.00')).toBeVisible();
  await expect(totals.getByText('84.00', { exact: true })).toBeVisible();
  if (phone) {
    await page.getByRole('button', { name: 'ถัดไป: ผ่านรายการ' }).click();
    await expect(page.getByText('ตรวจก่อนผ่านรายการ', { exact: false })).toBeVisible();
    expect(posts).toBe(0); // กดถัดไปแล้วต้องยังไม่ผ่านรายการเอง (ปุ่มเดิมกลายเป็น submit กลางคลิก)
  } else {
    await expect(page.getByText('(หนึ่งพันสองร้อยแปดสิบสี่บาทถ้วน)').filter({ visible: true })).toBeVisible(); // กระดาษตัวอย่างด้านขวา
  }
  await checkScreen(page, info, 'invoice-form');
  await page.getByRole('button', { name: /^ผ่านรายการ/ }).click();

  // ใบที่ผ่านรายการแล้ว: เลข IV ตราประทับ ยอดค้างเต็มจำนวน
  await page.waitForURL(/\/sales\/documents\/[0-9a-f-]{36}$/);
  await expect(page.getByText(/^IV-\d{4}$/).first()).toBeVisible();
  await expect(page.getByText('ใบกำกับภาษี / ใบแจ้งหนี้', { exact: true })).toBeVisible();
  await expect(page.getByText('ยอดค้าง 1,284.00')).toBeVisible();
  await checkScreen(page, info, 'invoice-posted');

  // รับชำระใบนี้: เลือกไว้เต็มยอด ลูกค้าหัก 3% จากมูลค่าก่อนภาษี 1,200 = 36
  await page.getByRole('link', { name: 'รับชำระใบนี้' }).click();
  await page.waitForURL(/\/sales\/receipts\/new/);
  await expect(page.getByLabel(/^รับครั้งนี้ IV-/).last()).toHaveValue('1284.00');
  await page.getByLabel('อัตราที่ลูกค้าหัก').selectOption('3');
  await expect(page.getByRole('textbox', { name: 'ลูกค้าหักภาษี ณ ที่จ่าย' })).toHaveValue('36.00');
  await expect(page.getByText('1,248.00')).toBeVisible();
  await checkScreen(page, info, 'receipt-form');
  await page.getByRole('button', { name: /^ผ่านรายการ/ }).click();
  await page.waitForURL(/\/sales\/documents\/[0-9a-f-]{36}$/);
  await expect(page.getByText(/^RE-\d{4}$/).first()).toBeVisible();
  await expect(page.getByText('รับเงินสุทธิ')).toBeVisible();
  await checkScreen(page, info, 'receipt-posted');

  // ใบเดิมรับครบแล้ว
  await page.getByRole('region', { name: 'รับชำระ / ลดหนี้ที่ตัดใบนี้' }).getByRole('link', { name: /^IV-/ }).click();
  await expect(page.getByText('รับครบแล้ว')).toBeVisible();
  expect(errors).toEqual([]);
});

test('ใบลดหนี้อ้างใบขายเชื่อ · ลูกหนี้คงค้าง · ยกเลิกเอกสารต้องมีเหตุผล', async ({ page }, info) => {
  const errors = watchErrors(page);
  const { home, t, api } = await setup(page, info);
  const iv = await (await page.request.post(`${api}/sales/invoice`, {
    headers: { 'idempotency-key': randomUUID() },
    data: { date: new Date().toISOString().slice(0, 10), partyCode: `SC-${t}`, lines: [{ itemCode: `PA-${t}`, qty: '5', unitPrice: '120' }] },
  })).json();
  expect(iv.docNo).toMatch(/^IV-\d{4}$/);

  await page.goto(`${home}/sales/documents/${iv.id}`);
  await page.getByRole('link', { name: 'ออกใบลดหนี้' }).click();
  await expect(page.getByRole('heading', { name: 'ใบลดหนี้ (ร่าง)' })).toBeVisible();
  await expect(page.getByText(`${iv.docNo} ยอด 642.00 ค้าง 642.00`)).toBeVisible();
  await page.getByLabel('เหตุผล', { exact: true }).fill('สินค้าชำรุด 1 รีม');
  if (isPhone(info)) await page.getByRole('button', { name: 'ถัดไป: รายการ' }).click();
  await page.getByRole('combobox', { name: 'รายละเอียด 1' }).fill('รับคืนกระดาษ A4 ชำรุด');
  await page.getByLabel(/^จำนวน/).first().fill('1');
  await page.getByLabel('ราคาต่อหน่วย').first().fill('120');
  if (isPhone(info)) {
    await page.getByRole('button', { name: 'ถัดไป: ตรวจยอดและภาษี' }).click();
    await page.getByRole('button', { name: 'ถัดไป: ผ่านรายการ' }).click();
  }
  await checkScreen(page, info, 'credit-note-form');
  await page.getByRole('button', { name: /^ผ่านรายการ/ }).click();
  await page.waitForURL(/\/sales\/documents\/[0-9a-f-]{36}$/);
  await expect(page.getByText(/^CN-\d{4}$/).first()).toBeVisible();
  await expect(page.getByText('ใบลดหนี้ / ใบกำกับภาษี', { exact: true })).toBeVisible();

  // ลูกหนี้คงค้าง: ใบเดิมเหลือ 642.00 − 128.40 = 513.60
  await page.goto(`${home}/sales/receivables`);
  await expect(page.getByRole('link', { name: new RegExp(`${iv.docNo}.*513\\.60`) })).toBeVisible();
  await checkScreen(page, info, 'receivables');

  // ยกเลิกใบลดหนี้: ต้องใส่เหตุผล ได้เลข RV และตรายกเลิก
  await page.goBack();
  await page.getByRole('button', { name: 'ยกเลิกเอกสาร' }).click();
  const confirm = page.getByRole('button', { name: 'ยืนยันยกเลิก' });
  await expect(confirm).toBeDisabled();
  await page.getByLabel('เหตุผลที่ยกเลิก').fill('ลูกค้าขอเปลี่ยนเป็นลดราคาแทน');
  await checkScreen(page, info, 'void-dialog');
  await confirm.click();
  await expect(page.getByText(/ยกเลิกแล้ว .* เหตุผล: ลูกค้าขอเปลี่ยนเป็นลดราคาแทน \(กลับรายการ RV-\d{4}\)/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'ยกเลิกเอกสาร' })).toHaveCount(0);

  // รายการเอกสารขายแสดงทั้งใบขายเชื่อและใบลดหนี้ที่ยกเลิก
  await page.goto(`${home}/sales/invoices`);
  await expect(page.getByRole('link', { name: iv.docNo }).first()).toBeVisible();
  await checkScreen(page, info, 'sales-list');
  expect(errors).toEqual([]);
});
