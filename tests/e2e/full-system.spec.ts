import { test, expect, type Page } from '@playwright/test';
import { checkScreen, env, isPhone, login, studentHome, watchErrors } from './helpers';

// ทดสอบทั้งระบบ (docs/full-system-test.md) ส่วนที่เพิ่มจากรอบนี้ ทั้ง 3 จอ:
// สินค้าคงเหลือ (เปิดติดตามสต็อก → ยอดยกมา → บัตรสต็อก → ยอดตรง 1310) · รายการจากเอกสารไม่มีปุ่มกลับรายการ
// · กระทบยอดธนาคารบอกสาเหตุเป็นภาษาไทย · ปุ่มย้อนกลับบนมือถือ · ออฟไลน์ไม่ส่งคำขอ · ผู้ดูแลทุกลิงก์เปิดได้

const tag = () => Math.random().toString(36).slice(2, 7).toUpperCase();

async function addTrackedItem(page: Page, home: string, code: string) {
  await page.goto(`${home}/items`);
  await page.getByRole('button', { name: 'เพิ่มสินค้า / บริการ' }).click();
  await page.getByLabel('รหัส', { exact: true }).fill(code);
  await page.getByLabel('ชื่อ', { exact: true }).fill(`สินค้าทดสอบ ${code}`);
  await page.getByLabel('หน่วย').fill('ชิ้น');
  await page.getByLabel(/^ติดตามสต็อก/).check();
  await page.getByRole('button', { name: 'บันทึก', exact: true }).click();
  await expect(page.getByRole('list', { name: 'สินค้า / บริการ' }).getByText(code, { exact: true })).toBeVisible();
}

test('สินค้าคงเหลือ: เปิดติดตามสต็อก → ยอดยกมา → บัตรสต็อก → ยอดรวมตรงบัญชี 1310', async ({ page }, info) => {
  const errors = watchErrors(page);
  const home = await studentHome(page);
  const code = `ST-${tag()}`;
  await addTrackedItem(page, home, code);
  await expect(page.getByText('ติดตามสต็อก').first()).toBeVisible();

  await page.goto(`${home}/inventory`);
  await expect(page.getByRole('heading', { name: /^สินค้าคงเหลือ/ })).toBeVisible();
  const form = page.getByRole('form', { name: /^ปรับสต็อก/ });
  await form.getByLabel('สินค้า', { exact: true }).selectOption(code);
  // ข้อมูลไม่ครบ: ไม่เลือกบัญชีคู่ → บอกสาเหตุ ไม่ส่งคำขอ
  await form.getByLabel(/^จำนวน/).fill('10');
  await form.getByLabel('ต้นทุนต่อหน่วย').fill('25');
  await form.getByRole('button', { name: 'บันทึกปรับสต็อก' }).click();
  await expect(form.getByRole('alert')).toContainText('บัญชีคู่');
  await form.getByLabel('บัญชีคู่').selectOption('3110');
  await form.getByLabel('คำอธิบาย').fill('ยอดยกมา');
  await form.getByRole('button', { name: 'บันทึกปรับสต็อก' }).click();
  await expect(form.getByRole('status')).toContainText(/บันทึกแล้ว รายการเลขที่ IA-\d+/);
  const row = page.getByRole('row').filter({ hasText: code });
  await expect(row).toContainText('10 ชิ้น');
  await expect(row).toContainText('250.00');
  await expect(page.getByText('✓ ตรงกัน')).toBeVisible();
  await checkScreen(page, info, 'inventory');

  // ตัดออกเกินคงเหลือ → ข้อความจาก DB บอกยอดที่มี
  await form.getByLabel(/^จำนวน/).fill('-11');
  await form.getByRole('button', { name: 'บันทึกปรับสต็อก' }).click();
  await expect(form.getByRole('alert')).toContainText('ไม่พอ');

  await row.getByRole('link', { name: new RegExp(`บัตรสต็อก ${code}`) }).click();
  const card = page.getByRole('region', { name: new RegExp(`^บัตรสต็อก ${code}`) });
  await expect(card).toBeVisible();
  await expect(card.getByRole('link', { name: /^IA-/ })).toBeVisible();
  await checkScreen(page, info, 'inventory-card');

  // รายการ IA มาจากทะเบียนสต็อก: หน้ารายการบอกให้ยกเลิกที่ต้นทาง ไม่มีปุ่มกลับรายการ/แก้ไข
  await card.getByRole('link', { name: /^IA-/ }).click();
  await expect(page.getByText(/ระบบลงจากเอกสารหรือทะเบียน/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'กลับรายการ' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'แก้ไขรายการ' })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('กระทบยอดธนาคาร: statement ยอดไม่ตรง / วันที่ไม่มีจริง บอกสาเหตุเป็นภาษาไทย', async ({ page }, info) => {
  const errors = watchErrors(page);
  const home = await studentHome(page);
  await page.goto(`${home}/bank-reconciliation`);
  await page.locator('summary').click();
  await page.getByLabel('รหัสบัญชีธนาคาร').fill('1120');
  await page.getByLabel('ตั้งแต่วันที่').fill('2026-02-01');
  await page.getByLabel('ถึงวันที่').fill('2026-02-28');
  await page.getByLabel('ยอดต้นงวดตามธนาคาร').fill('0');
  await page.getByLabel('ยอดปลายงวดตามธนาคาร').fill('999');
  const lines = page.getByLabel(/^รายการ \(/);
  await lines.fill('2026-02-03,รับโอน,1000.00,T1');
  await page.getByRole('button', { name: 'นำเข้า', exact: true }).click();
  await expect(page.locator('p[role=alert]')).toContainText('ไม่เท่ากับยอดปลายงวด');
  await lines.fill('2026-02-30,รับโอน,999.00,T1');
  await page.getByRole('button', { name: 'นำเข้า', exact: true }).click();
  await expect(page.locator('p[role=alert]')).toContainText('ไม่มีวันที่นี้ในปฏิทิน');
  await checkScreen(page, info, 'bank-errors');
  expect(errors).toEqual([]);
});

test('มือถือ: ปุ่มกลับ (แอปที่ติดตั้งไม่มีปุ่มย้อนของเบราว์เซอร์) พากลับหน้าก่อน', async ({ page }, info) => {
  test.skip(!isPhone(info), 'ปุ่มย้อนกลับแสดงเฉพาะจอมือถือ');
  const errors = watchErrors(page);
  const home = await studentHome(page);
  await page.goto(`${home}/menu`);
  await page.getByRole('main').getByRole('link', { name: 'สินค้าคงเหลือ' }).click();
  await page.waitForURL(`**${home}/inventory`);
  await page.getByRole('button', { name: 'กลับ', exact: true }).click();
  await page.waitForURL(`**${home}/menu`);
  expect(errors).toEqual([]);
});

test('เน็ตหลุด: กดบันทึกขณะออฟไลน์ไม่ส่งคำขอ บอกให้รอออนไลน์', async ({ page, context }) => {
  const errors = watchErrors(page);
  const home = await studentHome(page);
  const code = `OF-${tag()}`;
  await addTrackedItem(page, home, code);
  await page.goto(`${home}/inventory`);
  const form = page.getByRole('form', { name: /^ปรับสต็อก/ });
  await form.getByLabel('สินค้า', { exact: true }).selectOption(code);
  await form.getByLabel(/^จำนวน/).fill('1');
  await form.getByLabel('ต้นทุนต่อหน่วย').fill('1');
  await form.getByLabel('บัญชีคู่').selectOption('3110');
  let posted = 0;
  page.on('request', (r) => { if (r.method() === 'POST' && r.url().includes('/inventory/adjustments')) posted++; });
  await context.setOffline(true);
  await form.getByRole('button', { name: 'บันทึกปรับสต็อก' }).click();
  await expect(form.getByRole('alert')).toContainText('ไม่มีอินเทอร์เน็ต');
  expect(posted).toBe(0);
  await context.setOffline(false);
  // เน็ตหลุดระหว่างส่ง (คำขอถูกตัด): บอกเป็นภาษาไทย ไม่ใช่ข้อความอังกฤษของเบราว์เซอร์
  await page.route('**/inventory/adjustments', (r) => r.abort('internetdisconnected'));
  await form.getByRole('button', { name: 'บันทึกปรับสต็อก' }).click();
  await expect(form.getByRole('alert')).toContainText('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้');
  await page.unroute('**/inventory/adjustments');
  // กลับมาออนไลน์ กดซ้ำสองครั้งเร็ว ๆ ได้รายการเดียว
  await form.getByRole('button', { name: 'บันทึกปรับสต็อก' }).dblclick();
  await expect(form.getByRole('status')).toContainText(/IA-\d+/);
  await expect(page.getByRole('row').filter({ hasText: code })).toContainText('1 ชิ้น');
  expect(errors).toEqual([]);
});

test('ผู้ดูแลระบบ: ทุกลิงก์ในหน้าผู้ดูแลเปิดได้ ไม่มี error · นักเรียน/ครูเข้าหน้าผู้ดูแลไม่ได้', async ({ page, browser }, info) => {
  const errors = watchErrors(page);
  await login(page, 'staff', env.adminEmail, env.adminPassword);
  await page.waitForURL('**/admin');
  const hrefs = await page.locator('a[href^="/admin"], a[href="/privacy"]').evaluateAll((as) =>
    [...new Set(as.map((a) => (a as HTMLAnchorElement).getAttribute('href')!))]);
  expect(hrefs.length).toBeGreaterThan(1);
  for (const href of hrefs) {
    const r = await page.goto(href);
    expect(r?.status() ?? 0, href).toBeLessThan(400);
    await expect(page.getByText('ไม่พบหน้านี้')).toHaveCount(0);
  }
  await checkScreen(page, info, 'admin-links');
  const student = await (await browser.newContext({ viewport: info.project.use.viewport ?? undefined })).newPage();
  await studentHome(student);
  await student.goto('/admin');
  await expect(student).not.toHaveURL(/\/admin$/);
  await student.context().close();
  expect(errors).toEqual([]);
});
