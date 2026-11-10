import { test, expect } from '@playwright/test';
import { checkScreen, env, login, watchErrors } from './helpers';

// ไฟล์ตัวอย่างสำหรับนำเข้ารายชื่อ: ดาวน์โหลดได้จากหน้านำเข้า และเลือกไฟล์นั้นแล้วอ่านได้ครบ (ไม่กดนำเข้าจริง ไม่เปลี่ยนข้อมูลตัวอย่าง)
test('นำเข้ารายชื่อ: ดาวน์โหลดไฟล์ตัวอย่าง แล้วเลือกไฟล์นั้น ระบบอ่านได้ครบ 3 คน', async ({ page }, info) => {
  const errors = watchErrors(page);
  await login(page, 'staff', env.adminEmail, env.adminPassword);
  await page.waitForURL('**/admin');
  await page.getByRole('button', { name: 'นำเข้ารายชื่อ (CSV)' }).first().click();
  const link = page.getByRole('link', { name: /ดาวน์โหลดไฟล์ตัวอย่าง/ });
  await expect(link).toBeVisible();
  const res = await page.request.get((await link.getAttribute('href'))!);
  expect(res.status()).toBe(200);
  const body = await res.body();
  expect([...body.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // BOM: Excel เปิดภาษาไทยถูก
  expect(body.subarray(3).toString('utf8')).toMatch(/^รหัสนักเรียน,ชื่อ,นามสกุล,รหัสผ่าน/);
  await page.locator('input[type=file]').setInputFiles({ name: 'ตัวอย่าง.csv', mimeType: 'text/csv', buffer: body });
  await expect(page.getByText('พร้อมนำเข้า 3 คน')).toBeVisible();
  await expect(page.getByRole('cell', { name: 'ตัวอย่าง ใจดี' })).toBeVisible();
  await checkScreen(page, info, 'admin-import-example');
  expect(errors).toEqual([]);
});
