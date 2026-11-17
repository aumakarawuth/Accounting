import { test, expect } from '@playwright/test';
import { keyboardLayoutVariants } from '../../apps/api/src/keyboard';
import { checkScreen, env, freshStudent, login, watchErrors } from './helpers';

test('หน้าล็อกอินนักเรียน: รหัสผิดบอกจำนวนครั้งที่เหลือ', async ({ page }, info) => {
  const errors = watchErrors(page);
  await page.goto('/login');
  await checkScreen(page, info, 'login');
  await login(page, 'student', env.studentCode, 'รหัสผิดแน่นอน');
  await expect(page.getByText(/รหัสนักเรียนหรือรหัสผ่านไม่ถูกต้อง ลองได้อีก \d ครั้ง/)).toBeVisible();
  await checkScreen(page, info, 'login-error');
  expect(errors).toEqual([]);
});

test('หน้าล็อกอินครู (อีเมล ไม่มี 2FA) เข้าแล้วไปหน้าครู', async ({ page }, info) => {
  const errors = watchErrors(page);
  await page.goto('/login/staff');
  await checkScreen(page, info, 'login-staff');
  await login(page, 'staff', env.teacherEmail, env.teacherPassword);
  await page.waitForURL('**/teacher');
  await expect(page.getByRole('heading', { name: 'ห้องเรียน' })).toBeVisible();
  await checkScreen(page, info, 'teacher-home');
  expect(errors).toEqual([]);
});

test('ไม่ได้ล็อกอินเข้าหน้าในไม่ได้', async ({ page }) => {
  await page.goto('/teacher');
  await page.waitForURL('**/login');
});

// ลดการลืม/พิมพ์รหัสผิด (15 พ.ย. 2569): ปุ่มแสดงรหัส · แป้นผิดภาษาก็เข้าได้ · นักเรียนใช้รหัสบนใบได้เลย
test('ปุ่มแสดงรหัส แล้วเข้าด้วยรหัสไทยที่พิมพ์ตอนแป้นเป็นอังกฤษ นักเรียนใหม่เข้าถึงบริษัทได้เลยไม่ต้องตั้งรหัสใหม่', async ({ page, browser, baseURL }, info) => {
  test.setTimeout(90_000);
  const errors = watchErrors(page);
  const origin = new URL(baseURL!).origin;
  // ตั้งรหัสเป็นภาษาไทย แต่ตอนเข้าแป้นค้างเป็นอังกฤษ: ลงบัญชีย้อนหลัง → ]'[yP=uphvos]y'
  const { code, temp } = await freshStudent(browser, info, origin, 'แป้นภาษา', 'ลงบัญชีย้อนหลัง');
  const typedOnEnglishKeys = keyboardLayoutVariants(temp)[0]!;
  await page.goto('/login');
  await page.getByLabel('รหัสนักเรียน').fill(code);
  const pw = page.getByLabel('รหัสผ่าน', { exact: true });
  await pw.fill(typedOnEnglishKeys);
  await expect(pw).toHaveAttribute('type', 'password');
  await page.getByRole('button', { name: 'แสดงรหัสผ่าน' }).click();
  await expect(pw).toHaveAttribute('type', 'text');
  await expect(pw).toHaveValue(typedOnEnglishKeys);
  await checkScreen(page, info, 'login-show-password');
  await page.getByRole('button', { name: 'ซ่อนรหัสผ่าน' }).click();
  await expect(pw).toHaveAttribute('type', 'password');
  await page.getByRole('button', { name: 'เข้าใช้งาน' }).click();
  await page.waitForURL(/\/c\/[0-9a-f-]{36}$/); // ไม่ผ่านหน้าตั้งรหัสใหม่
  expect(errors).toEqual([]);
});
