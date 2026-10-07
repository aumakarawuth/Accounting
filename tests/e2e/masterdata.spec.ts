import { test, expect } from '@playwright/test';
import { checkScreen, studentHome, watchErrors } from './helpers';

// เฟส 2.1 ข้อมูลหลัก: โปรไฟล์ภาษี ลูกค้า/ผู้ขาย สินค้า/บริการ (บริษัทเดียวกันทุกจอ รหัสจึงต่อท้ายด้วยชื่อจอ)

function taxId(first12: string) {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(first12[i]) * (13 - i);
  return first12 + ((11 - (sum % 11)) % 10);
}
const tag = (name: string) => name.toUpperCase().replace(/[^A-Z0-9]/g, '');

test('ข้อมูลบริษัทและภาษี: เลขผู้เสียภาษีผิดบอกเหตุ บันทึกได้เมื่อถูก', async ({ page }, info) => {
  const errors = watchErrors(page);
  const home = await studentHome(page);
  await page.goto(`${home}/settings`);
  const taxField = page.getByLabel('เลขประจำตัวผู้เสียภาษี');
  const good = taxId('010555801234');
  await taxField.fill(good.slice(0, 12) + ((Number(good[12]) + 1) % 10));
  await expect(page.getByText('เลขประจำตัวผู้เสียภาษีไม่ถูกต้อง')).toBeVisible();
  await expect(page.getByRole('button', { name: 'บันทึก' })).toBeDisabled();
  await taxField.fill(good);
  await page.getByLabel('ที่อยู่').fill(`99 ถนนสุขุมวิท กรุงเทพฯ (${info.project.name})`);
  await page.getByRole('button', { name: 'บันทึก' }).click();
  await expect(page.locator('main').getByRole('status').filter({ hasText: /^บันทึกแล้ว$/ })).toBeVisible();
  await checkScreen(page, info, 'company-profile');
  await page.reload();
  await expect(taxField).toHaveValue(good);
  expect(errors).toEqual([]);
});

test('ลูกค้า/ผู้ขาย: จด VAT ต้องมีเลขภาษี หัก ณ ที่จ่ายตามประเภท กรองลูกค้า/ผู้ขาย', async ({ page }, info) => {
  const errors = watchErrors(page);
  const home = await studentHome(page);
  const t = tag(info.project.name);
  await page.goto(`${home}/parties`);

  await page.getByRole('button', { name: 'เพิ่มลูกค้า / ผู้ขาย' }).click();
  await page.getByLabel('รหัส', { exact: true }).fill(`c-${t}`);
  await page.getByLabel('ชื่อ', { exact: true }).fill('บริษัท สมใจ จำกัด');
  await page.getByLabel('จดทะเบียนภาษีมูลค่าเพิ่ม').check();
  await expect(page.getByText('คู่ค้าที่จด VAT ต้องมีเลขประจำตัวผู้เสียภาษี')).toBeVisible();
  await expect(page.getByRole('button', { name: 'บันทึก' })).toBeDisabled();
  await page.getByLabel('เลขประจำตัวผู้เสียภาษี').fill(taxId('010555900001'));
  await page.getByLabel('เครดิต (วัน)').fill('30');
  await checkScreen(page, info, 'party-form');
  await page.getByRole('button', { name: 'บันทึก' }).click();
  await expect(page.getByRole('status').filter({ hasText: `เพิ่ม C-${t} บริษัท สมใจ จำกัด แล้ว` })).toBeVisible();

  await page.getByRole('button', { name: 'เพิ่มลูกค้า / ผู้ขาย' }).click();
  await page.getByLabel('รหัส', { exact: true }).fill(`V-${t}`);
  await page.getByLabel('ชื่อ', { exact: true }).fill('ร้านออกแบบ');
  await page.getByLabel('ลูกค้า', { exact: true }).uncheck();
  await page.getByLabel('ผู้ขาย', { exact: true }).check();
  await page.getByLabel('หัก ณ ที่จ่ายเมื่อจ่ายเงินให้รายนี้').selectOption('service');
  await page.getByRole('button', { name: 'บันทึก' }).click();

  const list = page.getByRole('list', { name: 'ลูกค้า / ผู้ขาย' });
  const vendor = list.getByRole('listitem').filter({ hasText: `V-${t}` });
  await expect(vendor).toContainText('หัก ณ ที่จ่าย 3%');
  await page.getByRole('button', { name: 'ผู้ขาย', exact: true }).click();
  await expect(list.getByRole('listitem').filter({ hasText: `C-${t}` })).toHaveCount(0);
  await expect(vendor).toBeVisible();

  // แก้ชื่อ: ฟอร์มแก้เปิดในแถว ส่งเฉพาะช่องที่เปลี่ยน
  await vendor.getByRole('button', { name: 'แก้ไข' }).click();
  await page.getByLabel('ชื่อ', { exact: true }).fill('ร้านออกแบบ ดีไซน์');
  await page.getByRole('button', { name: 'บันทึก' }).click();
  await expect(list.getByRole('listitem').filter({ hasText: `V-${t}` })).toContainText('ร้านออกแบบ ดีไซน์');
  await checkScreen(page, info, 'parties');
  expect(errors).toEqual([]);
});

test('สินค้า/บริการ: เพิ่มบริการพร้อมบัญชีรายได้และราคา', async ({ page }, info) => {
  const errors = watchErrors(page);
  const home = await studentHome(page);
  const t = tag(info.project.name);
  await page.goto(`${home}/items`);
  await page.getByRole('button', { name: 'เพิ่มสินค้า / บริการ' }).click();
  await page.getByLabel('รหัส', { exact: true }).fill(`SV-${t}`);
  await page.getByLabel('ชื่อ', { exact: true }).fill('ค่าออกแบบโลโก้');
  await page.getByLabel('หน่วย').fill('งาน');
  await page.getByLabel('บริการ', { exact: true }).check();
  await page.getByLabel('ราคาขาย').fill('5000.555');
  await expect(page.getByText('ราคาเป็นตัวเลข ทศนิยมไม่เกิน 2 ตำแหน่ง')).toBeVisible();
  await page.getByLabel('ราคาขาย').fill('5000');
  await page.getByLabel('บัญชีเมื่อขาย').selectOption('4120');
  await checkScreen(page, info, 'item-form');
  await page.getByRole('button', { name: 'บันทึก' }).click();
  const row = page.getByRole('list', { name: 'สินค้า / บริการ' }).getByRole('listitem').filter({ hasText: `SV-${t}` });
  await expect(row).toContainText('บริการ');
  await expect(row).toContainText('4120 รายได้จากการบริการ');
  await expect(row).toContainText('5,000.00');
  await checkScreen(page, info, 'items');
  expect(errors).toEqual([]);
});
