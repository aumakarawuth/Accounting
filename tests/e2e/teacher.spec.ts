import { test, expect } from '@playwright/test';
import { checkScreen, env, login, studentHome, watchErrors } from './helpers';

test('ดูสด: ครูเห็นร่างที่นักเรียนพิมพ์ และนักเรียนเห็นป้ายครูกำลังดูอยู่', async ({ browser }, info) => {
  test.setTimeout(180_000); // โหมดถามเป็นรอบ (Vercel) รอป้ายได้ถึง 40 วินาทีสองช่วง
  const opts = { viewport: info.project.use.viewport, hasTouch: info.project.use.hasTouch, isMobile: info.project.use.isMobile };
  const sctx = await browser.newContext(opts);
  const tctx = await browser.newContext(opts);
  const student = await sctx.newPage();
  const teacher = await tctx.newPage();
  const errors = [...watchErrors(student), ...watchErrors(teacher)];
  // ป้าย "กำลังดูอยู่" ต้องมาทาง WebSocket /api/ws เมื่อ API รันแบบ server แยก (CI ตั้ง E2E_WS=1; Vercel ใช้ SSE)
  const wsFrames: string[] = [];
  student.on('websocket', (ws) => {
    if (new URL(ws.url()).pathname === '/api/ws') ws.on('framereceived', (f) => wsFrames.push(String(f.payload)));
  });
  // นักเรียนไม่เปิดสตรีม SSE ค้าง (บน Vercel ถาม /me/watchers ทุก 30 วินาทีแทน: docs/performance.md) · push มาทาง WebSocket เท่านั้น
  const sseOpened: string[] = [];
  student.on('request', (r) => { if (new URL(r.url()).pathname === '/api/realtime') sseOpened.push(r.url()); });
  const badgeWait = process.env.E2E_WS === '1' ? 10_000 : 40_000; // push ทันที / ถามเป็นรอบทุก 30 วินาที

  const home = await studentHome(student);
  await student.goto(`${home}/journal/new`);
  // เริ่มจากสถานะสะอาด: การดูสดที่ค้างจากรอบก่อน (ครูปิดเบราว์เซอร์ทิ้ง) หมดอายุเองใน 45 วินาที
  await expect(student.getByText(/กำลังดูอยู่/)).toHaveCount(0, { timeout: 50_000 });
  const codes = student.getByRole('combobox');
  await codes.nth(0).fill('5220');
  await student.getByRole('option', { name: /5220/ }).click();
  await student.locator('input[inputmode=decimal]').nth(0).fill('777');

  await login(teacher, 'staff', env.teacherEmail, env.teacherPassword);
  await teacher.waitForURL('**/teacher');
  await teacher.goto('/teacher/live');
  const row = teacher.getByRole('button', { name: new RegExp(env.studentCode) });
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.click();
  await expect(teacher.getByText('ร่างที่กำลังพิมพ์ (ยังไม่ได้ผ่านรายการ)')).toBeVisible();
  await expect(teacher.getByRole('cell', { name: '777.00' }).first()).toBeVisible({ timeout: 10_000 });
  await checkScreen(teacher, info, 'teacher-live');

  await expect(student.getByText(/กำลังดูอยู่/)).toBeVisible({ timeout: badgeWait });
  if (process.env.E2E_WS === '1') expect(wsFrames.some((f) => JSON.parse(f).k === 'watch')).toBe(true);
  await checkScreen(student, info, 'student-watched');

  await teacher.goto('/teacher');
  await expect(student.getByText(/กำลังดูอยู่/)).toHaveCount(0, { timeout: badgeWait });
  expect(sseOpened).toEqual([]);
  expect(errors).toEqual([]);
  await sctx.close();
  await tctx.close();
});

test('หน้างานที่ส่ง', async ({ page }, info) => {
  await login(page, 'staff', env.teacherEmail, env.teacherPassword);
  await page.waitForURL('**/teacher');
  await page.goto('/teacher/submissions');
  await expect(page.getByRole('heading', { name: 'งานที่ส่ง' })).toBeVisible();
  await checkScreen(page, info, 'teacher-submissions');
});
