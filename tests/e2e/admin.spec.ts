import { test, expect } from '@playwright/test';
import { checkScreen, env, login, studentHome, watchErrors } from './helpers';

// ผู้ดูแลระบบ: หน้า /admin (ครู ห้อง ตั้งค่าโรงเรียน) และ audit log · ปิดกระดาษทำการ 6 ช่อง → นักเรียนเห็นเฉพาะ 8/10 → เปิดคืน

test('ผู้ดูแลระบบเปิด/ปิดแบบกระดาษทำการ นักเรียนเห็นตามที่ตั้ง', async ({ browser }, info) => {
  const adminCtx = await browser.newContext({ viewport: info.project.use.viewport ?? undefined });
  const admin = await adminCtx.newPage();
  const errors = watchErrors(admin);
  await login(admin, 'staff', env.adminEmail, env.adminPassword);
  await admin.waitForURL('**/admin');
  // คืนค่าตั้งเสมอ (เทสต์อื่นและจอถัดไปใช้กระดาษทำการทุกแบบ)
  const restore = () => admin.request.post('/api/admin/settings/worksheet', {
    data: { formats: [6, 8, 10] }, headers: { origin: new URL(admin.url()).origin } });
  expect((await restore()).ok()).toBe(true);
  await admin.reload();
  try {
    await expect(admin.getByText('ครูสมศรี').first()).toBeVisible();
    await expect(admin.getByText('ม.5/2 บัญชี').first()).toBeVisible();
    const settings = admin.getByRole('region', { name: 'ตั้งค่าโรงเรียน' });
    const six = settings.getByLabel('กระดาษทำการ 6 ช่อง');
    await expect(six).toBeChecked();
    await six.uncheck();
    await settings.getByRole('button', { name: 'บันทึก' }).click();
    await expect(settings.getByRole('status')).toHaveText('บันทึกการตั้งค่าแล้ว');
    await checkScreen(admin, info, 'admin-settings');

    const student = await (await browser.newContext({ viewport: info.project.use.viewport ?? undefined })).newPage();
    const home = await studentHome(student);
    await student.goto(`${home}/worksheet`);
    await expect(student.getByRole('link', { name: '10 ช่อง' })).toBeVisible();
    await expect(student.getByRole('link', { name: '8 ช่อง' })).toBeVisible();
    await expect(student.getByRole('link', { name: '6 ช่อง' })).toHaveCount(0);
    await student.goto(`${home}/worksheet?format=6`);
    await expect(student.getByText('โรงเรียนยังไม่เปิดใช้กระดาษทำการแบบ 6 ช่อง')).toBeVisible();

    await admin.reload();
    await six.check();
    await settings.getByRole('button', { name: 'บันทึก' }).click();
    await expect(settings.getByRole('status')).toHaveText('บันทึกการตั้งค่าแล้ว');
    await admin.goto('/admin/audit');
    await expect(admin.getByRole('heading').first()).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await restore();
  }
});
