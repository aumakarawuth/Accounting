import { test, expect } from '@playwright/test';
import { checkScreen, env, login, watchErrors } from './helpers';

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
