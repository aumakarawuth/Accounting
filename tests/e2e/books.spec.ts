import { test, expect, type Page } from '@playwright/test';
import { checkScreen, env, login, studentHome, watchErrors } from './helpers';

// หน้าดูรายการ + กลับรายการ, ผังบัญชี, ปิดงวด, นโยบายความเป็นส่วนตัว (รันซ้ำได้ทั้ง 3 จอบนฐานข้อมูลเดียวกัน)

async function postEntry(page: Page, home: string, opts: { date?: string; debit: string; credit: string; amount: string }) {
  await page.goto(`${home}/journal/new`);
  if (opts.date) await page.getByLabel('วันที่', { exact: true }).fill(opts.date);
  const codes = page.getByRole('combobox');
  await codes.nth(0).fill(opts.debit);
  await page.getByRole('option', { name: new RegExp(opts.debit) }).click();
  await codes.nth(1).fill(opts.credit);
  await page.getByRole('option', { name: new RegExp(opts.credit) }).click();
  const money = page.locator('input[inputmode=decimal]');
  await money.nth(0).fill(opts.amount);
  await money.nth(3).fill(opts.amount);
  await page.getByRole('button', { name: /ผ่านรายการ/ }).click();
  const done = page.getByText(/ผ่านรายการเลขที่ JV-\d{4}/);
  await expect(done).toBeVisible();
  return (await done.textContent())!.match(/JV-\d{4}/)![0];
}

test('สมุดรายวัน: เปิดดูรายการที่ผ่านแล้ว และกลับรายการ', async ({ page }, info) => {
  const errors = watchErrors(page);
  const home = await studentHome(page);
  const docNo = await postEntry(page, home, { debit: '5220', credit: '1110', amount: '321' });

  await page.getByRole('link', { name: 'ดูรายการ' }).click();
  await page.waitForURL(/\/journal\/[0-9a-f-]{36}$/);
  const main = page.locator('main');
  await expect(main.getByText(docNo, { exact: true })).toBeVisible();
  await expect(main.getByText('ค่าเช่า').filter({ visible: true }).first()).toBeVisible();
  await checkScreen(page, info, 'journal-entry');

  await main.getByRole('button', { name: 'กลับรายการ' }).click();
  await checkScreen(page, info, 'journal-reverse-form');
  await main.getByRole('button', { name: `ยืนยันกลับรายการ ${docNo}` }).click();
  await expect(main.getByText('รายการนี้กลับรายการ')).toBeVisible();
  await expect(main.getByRole('link', { name: docNo })).toBeVisible();
  await expect(main.getByText(/^RV-\d{4}$/)).toBeVisible();
  await expect(main.getByText(/เป็นการกลับรายการ กลับซ้ำไม่ได้/)).toBeVisible();
  await checkScreen(page, info, 'journal-reversal');

  // กลับไปรายการเดิม: บอกว่ากลับแล้วด้วยเลขที่ไหน และไม่มีปุ่มกลับรายการอีก
  await main.getByRole('link', { name: docNo }).click();
  await expect(main.getByText('กลับรายการแล้วด้วย')).toBeVisible();
  await expect(main.getByRole('button', { name: 'กลับรายการ' })).toHaveCount(0);

  await page.goto(`${home}/journal`);
  await expect(page.getByRole('link', { name: `เปิดรายการ ${docNo}` }).first()).toBeVisible();
  await checkScreen(page, info, 'journal-list');
  expect(errors).toEqual([]);
});

test('ผังบัญชี: เพิ่มบัญชี แก้ชื่อ และปิดใช้บัญชีที่ยังไม่มีรายการ', async ({ page }, info) => {
  const errors = watchErrors(page);
  const home = await studentHome(page);
  await page.goto(`${home}/accounts`);
  await expect(page.getByRole('region', { name: 'สินทรัพย์' })).toBeVisible();
  await checkScreen(page, info, 'accounts');

  const code = `59${String(Date.now()).slice(-6)}`;
  await page.getByRole('button', { name: 'เพิ่มบัญชี' }).click();
  await page.getByLabel('รหัสบัญชี', { exact: true }).fill(code);
  await page.getByLabel('ชื่อบัญชี', { exact: true }).fill('ค่าทดสอบ');
  await expect(page.getByLabel('หมวด')).toHaveValue('expense');
  await checkScreen(page, info, 'accounts-add');
  await page.locator('form').getByRole('button', { name: 'เพิ่มบัญชี' }).click();
  await expect(page.getByRole('status').filter({ hasText: `เพิ่มบัญชี ${code} ค่าทดสอบ แล้ว` })).toBeVisible();

  const row = page.locator('li').filter({ hasText: code });
  await row.getByRole('button', { name: 'แก้ชื่อ' }).click();
  await row.getByLabel(`ชื่อบัญชี ${code}`).fill('ค่าทดสอบระบบ');
  await row.getByRole('button', { name: 'บันทึก' }).click();
  await expect(row).toContainText('ค่าทดสอบระบบ');

  await row.getByRole('button', { name: 'ปิดใช้' }).click();
  await expect(row).toHaveCount(0);
  await page.getByRole('button', { name: /แสดงบัญชีที่ปิดใช้/ }).click();
  await expect(row).toContainText('ปิดใช้แล้ว');
  // บัญชีที่มีรายการแล้วไม่มีปุ่มปิดใช้
  await expect(page.locator('li').filter({ hasText: /^1110/ }).getByRole('button', { name: 'ปิดใช้' })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('ปิดงวด: นักเรียนปิดงวดเก่าสุด ลงย้อนหลังไม่ได้ ครูเปิดคืน', async ({ browser }, info) => {
  test.setTimeout(90_000);
  const opts = { viewport: info.project.use.viewport, hasTouch: info.project.use.hasTouch, isMobile: info.project.use.isMobile };
  const sctx = await browser.newContext(opts);
  const tctx = await browser.newContext(opts);
  const student = await sctx.newPage();
  const teacher = await tctx.newPage();
  const errors = [...watchErrors(student), ...watchErrors(teacher)];

  // งวด ม.ค. 2563 ไกลพอที่จะเป็นงวดเก่าสุดเสมอ และไม่กระทบเทสต์อื่นที่ลงรายการเดือนปัจจุบัน
  const home = await studentHome(student);
  await postEntry(student, home, { date: '15/01/2563', debit: '1110', credit: '3110', amount: '50' });
  await student.goto(`${home}/closing`);
  const close = student.getByRole('button', { name: 'ปิดงวด ม.ค. 2563' });
  await close.click();
  await expect(student.getByRole('button', { name: 'ยืนยันปิดงวด ม.ค. 2563' })).toBeVisible();
  await checkScreen(student, info, 'closing-confirm');
  await student.getByRole('button', { name: 'ยืนยันปิดงวด ม.ค. 2563' }).click();
  await expect(student.getByText('ปิดงวด ม.ค. 2563 แล้ว')).toBeVisible();
  await expect(student.getByRole('row', { name: /ม.ค. 2563.*ปิดแล้ว/ })).toBeVisible();
  await checkScreen(student, info, 'closing-done');

  await student.goto(`${home}/journal/new`);
  await student.getByLabel('วันที่', { exact: true }).fill('20/01/2563');
  const codes = student.getByRole('combobox');
  await codes.nth(0).fill('1110');
  await student.getByRole('option', { name: /1110/ }).click();
  await codes.nth(1).fill('3110');
  await student.getByRole('option', { name: /3110/ }).click();
  const money = student.locator('input[inputmode=decimal]');
  await money.nth(0).fill('1');
  await money.nth(3).fill('1');
  await student.getByRole('button', { name: /ผ่านรายการ/ }).click();
  await expect(student.getByRole('alert').filter({ hasText: 'ปิดแล้ว ลงรายการไม่ได้' })).toBeVisible();

  await login(teacher, 'staff', env.teacherEmail, env.teacherPassword);
  await teacher.waitForURL('**/teacher');
  await teacher.goto(`/teacher/review/${home.split('/')[2]}`);
  const periods = teacher.getByRole('region', { name: 'งวดบัญชี' });
  await periods.getByRole('button', { name: 'เปิดงวด ม.ค. 2563 คืน' }).click();
  await periods.getByRole('button', { name: 'ยืนยันเปิดงวด ม.ค. 2563 คืน' }).click();
  await expect(periods.getByText('เปิดงวด ม.ค. 2563 คืนแล้ว')).toBeVisible();
  await checkScreen(teacher, info, 'teacher-periods');

  await student.getByRole('button', { name: /ผ่านรายการ/ }).click();
  await expect(student.getByText(/ผ่านรายการเลขที่ JV-\d{4}/)).toBeVisible();
  expect(errors).toEqual([]);
  await sctx.close();
  await tctx.close();
});

test('นโยบายความเป็นส่วนตัว เปิดได้โดยไม่ต้องล็อกอิน', async ({ page }, info) => {
  const errors = watchErrors(page);
  await page.goto('/login');
  await page.getByRole('link', { name: 'นโยบายความเป็นส่วนตัว' }).click();
  await expect(page.getByRole('heading', { name: 'นโยบายความเป็นส่วนตัว' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'ข้อมูลที่เก็บ' })).toBeVisible();
  await expect(page.getByText(/ไม่เก็บเลขบัตรประชาชน/)).toBeVisible();
  await checkScreen(page, info, 'privacy');
  expect(errors).toEqual([]);
});
