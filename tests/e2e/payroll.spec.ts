import { test, expect } from '@playwright/test';
import { checkScreen, freshStudentHome, watchErrors } from './helpers';

// เงินเดือนแบบง่าย (docs/phase7-spec.md ข้อ 3) ทุกจอ: เพิ่มพนักงาน → ลงเงินเดือน (ประกันสังคมเพดาน 17,500) → นำส่ง → รายงาน
test('ทะเบียนพนักงาน ลงเงินเดือน นำส่งประกันสังคมและ ภ.ง.ด.1', async ({ page, browser, baseURL }, info) => {
  test.setTimeout(120_000);
  const errors = watchErrors(page);
  const { home, co } = await freshStudentHome(page, browser, info, new URL(baseURL!).origin, 'เงินเดือน');
  await page.goto(`${home}/payroll?month=2027-01`);
  const staff = page.getByRole('region', { name: 'ทะเบียนพนักงาน' });
  for (const [code, name, salary] of [['E1', 'นายหนึ่ง', '20000'], ['E2', 'นางสาวสอง', '12345']]) {
    await staff.getByRole('button', { name: 'เพิ่มพนักงาน' }).click();
    const f = staff.getByRole('form', { name: 'เพิ่มพนักงาน' });
    await f.getByLabel('รหัส').fill(code!);
    await f.getByLabel('ชื่อ-สกุล').fill(name!);
    await f.getByLabel('เงินเดือน').fill(salary!);
    await f.getByRole('button', { name: 'บันทึกพนักงาน' }).click();
    await expect(staff).toContainText(name!);
  }

  const run = page.getByRole('form', { name: /^เงินเดือนประจำเดือน/ });
  const e1 = run.getByRole('listitem', { name: 'E1 นายหนึ่ง' });
  await e1.getByLabel('เงินได้อื่น (OT ค่าคอมฯ)').fill('2000');
  await e1.getByLabel('ภาษีหัก ณ ที่จ่าย').fill('500');
  await expect(e1).toContainText('875.00');
  await expect(e1).toContainText('20,625.00');
  await expect(run.getByRole('listitem', { name: 'E2 นางสาวสอง' })).toContainText('617.00');
  await checkScreen(page, info, 'payroll-form');
  await run.getByRole('button', { name: 'ผ่านรายการเงินเดือน' }).click();
  await expect(page.getByRole('region', { name: /^เงินเดือนประจำเดือน/ })).toContainText('34,345.00');

  const remit = page.getByRole('region', { name: 'นำส่ง' });
  const sso = remit.getByRole('listitem', { name: 'ประกันสังคม สปส.1-10 (ลูกจ้าง + นายจ้าง)' });
  await expect(sso).toContainText('2,984.00');
  await sso.getByRole('button', { name: 'นำส่ง' }).click();
  await sso.getByLabel('วันที่นำส่ง (วว/ดด/ปปปป)').fill('15/02/2570');
  await sso.getByRole('button', { name: 'ยืนยัน' }).click();
  await expect(sso).toContainText('นำส่งแล้ว');
  await expect(page.getByRole('region', { name: /^สรุปทั้งปี 2570/ })).toContainText('22,000.00');
  await checkScreen(page, info, 'payroll-posted');
  expect((await page.request.get(`/export/company/${co}/payroll.xlsx?month=2027-01`)).status()).toBe(200);
  expect(errors).toEqual([]);
});
