import { test, expect, type Browser, type TestInfo } from '@playwright/test';
import { checkScreen, env, login, studentHome, watchErrors } from './helpers';

// รหัสห้อง/QR และคอมเมนต์ปากกาแดง (รันซ้ำได้ทั้ง 3 จอบนฐานข้อมูลเดียวกัน)
const ROOM = process.env.E2E_ROOM ?? 'ม.5/2 บัญชี';

async function contexts(browser: Browser, info: TestInfo) {
  const opts = { viewport: info.project.use.viewport, hasTouch: info.project.use.hasTouch, isMobile: info.project.use.isMobile };
  const sctx = await browser.newContext(opts);
  const tctx = await browser.newContext(opts);
  return { sctx, tctx, student: await sctx.newPage(), teacher: await tctx.newPage() };
}

test('รหัสห้อง: ครูสร้างรหัสและฉาย QR นักเรียนเปิดลิงก์ ล็อกอิน แล้วเข้าห้อง', async ({ browser }, info) => {
  const { sctx, tctx, student, teacher } = await contexts(browser, info);
  const errors = [...watchErrors(student), ...watchErrors(teacher)];

  await login(teacher, 'staff', env.teacherEmail, env.teacherPassword);
  await teacher.waitForURL('**/teacher');
  const room = teacher.locator('section').filter({ has: teacher.getByRole('heading', { name: new RegExp(ROOM.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }) });
  const create = room.getByRole('button', { name: 'สร้างรหัสห้อง' });
  if (await create.isVisible()) {
    await create.click();
  } else {
    await room.getByRole('button', { name: 'เปลี่ยนรหัสใหม่' }).click();
    await room.getByRole('button', { name: 'ยืนยันเปลี่ยนรหัส (รหัสเดิมใช้ไม่ได้)' }).click();
  }
  const codeText = room.getByText(/^[A-HJ-NP-Z2-9]{6}$/);
  await expect(codeText).toBeVisible();
  const code = (await codeText.textContent())!;
  await checkScreen(teacher, info, 'teacher-join-code');

  await room.getByRole('link', { name: 'แสดง QR ขึ้นจอ' }).click();
  await expect(teacher.getByRole('heading', { name: `เข้าห้อง ${ROOM}` })).toBeVisible();
  await expect(teacher.getByText(code, { exact: true })).toBeVisible();
  await expect(teacher.getByRole('img', { name: new RegExp(`/join/${code}$`) }).locator('svg')).toBeVisible();
  await checkScreen(teacher, info, 'teacher-qr');

  // ปลายทางของ QR: ยังไม่ล็อกอิน → ล็อกอินแล้วกลับมาหน้าเข้าห้อง (นักเรียนคนนี้อยู่ในห้องแล้ว)
  await student.goto(`/join/${code}`);
  await expect(student.getByText(`เข้าสู่ระบบก่อน แล้วจะกลับมาที่หน้าเข้าห้องด้วยรหัส ${code}`)).toBeVisible();
  await checkScreen(student, info, 'join-login');
  await student.getByLabel('รหัสนักเรียน').fill(env.studentCode);
  await student.getByLabel('รหัสผ่าน', { exact: true }).fill(env.studentPassword);
  await student.getByRole('button', { name: 'เข้าใช้งาน' }).click();
  await student.waitForURL(`**/join/${code}`);
  await student.getByRole('button', { name: `เข้าห้องด้วยรหัส ${code}` }).click();
  await expect(student.getByRole('status')).toHaveText(`อยู่ในห้อง ${ROOM} อยู่แล้ว`);
  await checkScreen(student, info, 'join-done');

  // พิมพ์รหัสเอง: รหัสที่ไม่มีบอกตรง ๆ
  await student.goto('/join');
  await student.getByLabel('รหัสห้อง').fill('zzzz22');
  await student.getByRole('button', { name: 'เข้าห้องด้วยรหัส ZZZZ22' }).click();
  await expect(student.getByRole('alert').filter({ hasText: 'ไม่พบห้อง' })).toHaveText('ไม่พบห้องที่ใช้รหัสนี้ ตรวจรหัสกับครูอีกครั้ง');
  await checkScreen(student, info, 'join-wrong');
  expect(errors).toEqual([]);
  await sctx.close();
  await tctx.close();
});

test('คอมเมนต์ปากกาแดง: ครูติดคอมเมนต์ที่บรรทัด นักเรียนเห็นที่ขอบสมุด', async ({ browser }, info) => {
  test.setTimeout(90_000);
  const { sctx, tctx, student, teacher } = await contexts(browser, info);
  const errors = [...watchErrors(student), ...watchErrors(teacher)];

  const home = await studentHome(student);
  await student.goto(`${home}/journal/new`);
  const codes = student.getByRole('combobox');
  await codes.nth(0).fill('5230');
  await student.getByRole('option', { name: /5230/ }).click();
  await codes.nth(1).fill('1110');
  await student.getByRole('option', { name: /1110/ }).click();
  const money = student.locator('input[inputmode=decimal]');
  await money.nth(0).fill('640');
  await money.nth(3).fill('640');
  await student.getByRole('button', { name: /ผ่านรายการ/ }).click();
  const done = student.getByText(/ผ่านรายการเลขที่ JV-\d{4}/);
  await expect(done).toBeVisible();
  const docNo = (await done.textContent())!.match(/JV-\d{4}/)![0];
  await student.getByRole('link', { name: 'ดูรายการ' }).click();
  await student.waitForURL(/\/journal\/[0-9a-f-]{36}$/);

  await login(teacher, 'staff', env.teacherEmail, env.teacherPassword);
  await teacher.waitForURL('**/teacher');
  await teacher.goto(`/teacher/review/${home.split('/')[2]}`);
  await teacher.getByRole('link', { name: `ตรวจรายการ ${docNo}` }).click();
  const note = `ค่าน้ำกับค่าไฟควรแยกบัญชี ${info.project.name}`;
  await teacher.getByLabel('คอมเมนต์ที่').selectOption({ label: 'บรรทัด 1 · 5230 ค่าน้ำ ค่าไฟ' });
  await teacher.getByLabel('ข้อความถึงนักเรียน').fill(note);
  await teacher.getByRole('button', { name: 'ติดคอมเมนต์' }).click();
  await expect(teacher.getByRole('status')).toHaveText('ติดคอมเมนต์แล้ว นักเรียนเห็นที่รายการนี้');
  await expect(teacher.getByText(note).filter({ visible: true })).toBeVisible();
  await checkScreen(teacher, info, 'teacher-comment');

  // นักเรียนที่เปิดรายการค้างไว้เห็นคอมเมนต์เองผ่าน realtime (ไม่ต้องโหลดหน้าใหม่) และไม่เห็นชื่อครู
  const pen = student.getByText(note).filter({ visible: true });
  await expect(pen).toBeVisible({ timeout: 15_000 });
  await expect(pen.locator('xpath=..')).toContainText('— ครู ·');
  await checkScreen(student, info, 'student-comment');

  await student.goto(`${home}/journal`);
  await expect(student.getByText('1 คอมเมนต์').filter({ visible: true }).first()).toBeVisible();

  // ครูลบคอมเมนต์ของตัวเองได้
  await teacher.getByText(note).filter({ visible: true }).locator('xpath=..').getByRole('button', { name: 'ลบ' }).click();
  await expect(teacher.getByText(note).filter({ visible: true })).toHaveCount(0);
  expect(errors).toEqual([]);
  await sctx.close();
  await tctx.close();
});
