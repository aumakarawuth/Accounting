import { test, expect, type Page } from '@playwright/test';
import { checkScreen, studentHome, watchErrors } from './helpers';

// ต้นทุนถัวเฉลี่ยตามลำดับวันที่ (docs/accounting-audit.md, migration 20261110000104) ทั้ง 3 จอ:
// รับเข้า 10 @100 (10 ต.ค.) → ตัดออก 5 (20 ต.ค. = 500) → รับเข้าย้อนวันที่ 10 @200 (5 ต.ค.)
// → ตัดออกวันที่ 20 คิดใหม่เป็น 5 × 150 = 750 · บัตรสต็อกบอกว่าคำนวณใหม่ · ยอดรวมยังตรงบัญชี 1310

const tag = () => Math.random().toString(36).slice(2, 7).toUpperCase();

async function adjust(page: Page, code: string, date: string, qty: string, cost: string | null, offset: string) {
  const form = page.getByRole('form', { name: /^ปรับสต็อก/ });
  await form.getByLabel('สินค้า', { exact: true }).selectOption(code);
  await form.getByLabel(/^วันที่/).fill(date);
  await form.getByLabel(/^จำนวน/).fill(qty);
  if (cost) await form.getByLabel('ต้นทุนต่อหน่วย').fill(cost);
  await form.getByLabel('บัญชีคู่').selectOption(offset);
  await form.getByRole('button', { name: 'บันทึกปรับสต็อก' }).click();
  await expect(form.getByRole('status')).toContainText(/บันทึกแล้ว รายการเลขที่ IA-\d+/);
}

test('ลงรับสินค้าย้อนวันที่: ต้นทุนของรายการหลังจากนั้นคำนวณใหม่ตามลำดับวันที่', async ({ page }, info) => {
  const errors = watchErrors(page);
  const home = await studentHome(page);
  const code = `DC-${tag()}`;
  await page.goto(`${home}/items`);
  await page.getByRole('button', { name: 'เพิ่มสินค้า / บริการ' }).click();
  await page.getByLabel('รหัส', { exact: true }).fill(code);
  await page.getByLabel('ชื่อ', { exact: true }).fill(`สินค้าเรียงวันที่ ${code}`);
  await page.getByLabel('หน่วย').fill('ชิ้น');
  await page.getByLabel(/^ติดตามสต็อก/).check();
  await page.getByRole('button', { name: 'บันทึก', exact: true }).click();
  await expect(page.getByRole('list', { name: 'สินค้า / บริการ' }).getByText(code, { exact: true })).toBeVisible();

  await page.goto(`${home}/inventory`);
  await adjust(page, code, '10/10/2569', '10', '100', '3110');
  await adjust(page, code, '20/10/2569', '-5', null, '5130');
  const row = page.getByRole('row').filter({ hasText: code });
  await expect(row).toContainText('500.00');
  await adjust(page, code, '05/10/2569', '10', '200', '3110');
  await expect(row).toContainText('15 ชิ้น');
  await expect(row).toContainText('2,250.00'); // 1,000 + 2,000 − 750
  await expect(page.getByText('✓ ตรงกัน')).toBeVisible();

  await row.getByRole('link', { name: new RegExp(`บัตรสต็อก ${code}`) }).click();
  const card = page.getByRole('region', { name: new RegExp(`^บัตรสต็อก ${code}`) });
  await expect(card.getByText(/คำนวณต้นทุนของรายการหลังจากนั้นใหม่ตามลำดับวันที่/)).toBeVisible();
  const rows = card.getByRole('row');
  // เรียงตามวันที่: 05/10 รับ 10 · 10/10 รับ 10 · 20/10 จ่าย 5 = 750 (คำนวณใหม่)
  await expect(rows.nth(1)).toContainText('05/10/2569');
  await expect(rows.nth(3)).toContainText('20/10/2569');
  await expect(rows.nth(3)).toContainText('คำนวณต้นทุนใหม่');
  await expect(rows.nth(3)).toContainText('750.00');
  await expect(rows.nth(3).getByRole('link', { name: /^CG-/ })).toBeVisible();
  await checkScreen(page, info, 'inventory-restated');

  // รายการที่ลงใหม่: บอกว่าเป็นการคำนวณต้นทุนใหม่ ยอด 750
  await rows.nth(3).getByRole('link', { name: /^CG-/ }).click();
  await expect(page.getByText(/คำนวณต้นทุนใหม่ IA-\d+/)).toBeVisible();
  await expect(page.getByText(/^(ต้นทุนขาย )?750\.00/).filter({ visible: true }).first()).toBeVisible();
  expect(errors).toEqual([]);
});
