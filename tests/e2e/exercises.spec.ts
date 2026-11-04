import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test, expect, type Browser, type Page, type TestInfo } from '@playwright/test';
import { checkScreen, env, isPhone, login, watchErrors } from './helpers';

// เฟส 4: ครูสร้างชุดโจทย์ (หน้าจอ) → มอบหมายเป็นการสอบ → นักเรียนเริ่มสอบ ลงรายการ → ครูเห็นคะแนน เปิดเฉลย → นักเรียนเห็นผลและเฉลย
// · ส่งออกคะแนน/รายงาน PDF และ Excel · โหมดสาธิต (ลงรายการตามเฉลย ตัวอักษรใหญ่) ทุกจอ
// ครู ห้อง และนักเรียนใหม่ต่อการรัน (ดู newClass) · ชื่อมีชื่อจอ + เลขสุ่ม รันซ้ำบนฐานเดิมได้ · ปิดสอบทุกครั้งตอนจบ

const tag = (info: TestInfo) => `${info.project.name.toUpperCase().replace(/[^A-Z0-9]/g, '')}-${randomUUID().slice(0, 4)}`;

async function contexts(browser: Browser, info: TestInfo) {
  const opts = { viewport: info.project.use.viewport, hasTouch: info.project.use.hasTouch, isMobile: info.project.use.isMobile,
    userAgent: info.project.use.userAgent, deviceScaleFactor: info.project.use.deviceScaleFactor };
  const tctx = await browser.newContext(opts);
  const sctx = await browser.newContext(opts);
  return { tctx, sctx, teacher: await tctx.newPage(), student: await sctx.newPage() };
}

const originOf = (page: Page) => new URL(page.url()).origin;

/**
 * ผู้ดูแลสร้างครูใหม่ + ห้องใหม่ → ครูเข้าครั้งแรก (เปลี่ยนรหัส) แล้วนำเข้านักเรียนใหม่ 1 คน
 * ครู/นักเรียนตัวอย่างจึงไม่ได้ห้องหรือบริษัทเพิ่ม (เทสต์อื่นคาดว่าครูมีห้องเดียว นักเรียนมีบริษัทเดียว)
 */
async function newClass(browser: Browser, teacher: Page, t: string) {
  const origin = new URL(teacher.url()).origin;
  const actx = await browser.newContext({ extraHTTPHeaders: { origin } });
  const admin = actx.request;
  expect((await admin.post(`${origin}/api/auth/login`, { data: { kind: 'staff', identifier: env.adminEmail, password: env.adminPassword } })).status()).toBe(200);
  const username = `exam-${t.toLowerCase()}`;
  const staff = await admin.post(`${origin}/api/admin/staff`, { data: { email: username, name: `ครูสอบ ${t}`, role: 'teacher' } });
  expect(staff.status()).toBe(201);
  const { id: teacherId, tempPassword } = await staff.json() as { id: string; tempPassword: string };
  const roomName = `ห้องสอบ ${t}`;
  const room = await admin.post(`${origin}/api/admin/classrooms`, { data: { name: roomName, teacherId } });
  expect(room.status()).toBe(201);
  const roomId = (await room.json()).id as string;
  await actx.close();

  await login(teacher, 'staff', username, tempPassword);
  await teacher.waitForURL('**/change-password');
  await teacher.context().setExtraHTTPHeaders({ origin });
  expect((await teacher.request.post('/api/auth/change-password', { data: { newPassword: `ครูสอบบัญชี-${randomUUID().slice(0, 8)}` } })).status()).toBe(200);
  const code = `E${randomUUID().replace(/-/g, '').slice(0, 10)}`;
  const temp = `ชั่วคราว-${randomUUID().slice(0, 8)}`;
  const imp = await teacher.request.post(`/api/classrooms/${roomId}/import`, { data: { rows: [{ studentCode: code, name: `นักเรียนสอบ ${t}`, password: temp }] } });
  expect(imp.status()).toBe(200);
  await teacher.goto('/teacher');
  return { roomName, code, temp, password: `สอบบัญชี-${randomUUID().slice(0, 8)}` };
}

test('ครูสร้างโจทย์ → สอบ → นักเรียนเริ่มสอบ → ครูเปิดเฉลย → ผลและไฟล์ส่งออก', async ({ browser }, info) => {
  test.setTimeout(180_000);
  const t = tag(info);
  const { tctx, sctx, teacher, student } = await contexts(browser, info);
  const errors = [...watchErrors(teacher), ...watchErrors(student)];
  let assignmentId = '';
  try {
    // ---- ครูสร้างชุดโจทย์บนหน้าจอ ----
    await teacher.goto('/login/staff');
    const room = await newClass(browser, teacher, t);
    await teacher.getByRole('link', { name: 'โจทย์', exact: true }).click();
    await expect(teacher.getByRole('heading', { name: 'โจทย์', exact: true })).toBeVisible();
    await teacher.getByRole('link', { name: 'สร้างชุดโจทย์' }).click();
    await teacher.getByLabel('ชื่อชุดโจทย์').fill(`สอบย่อย ${t}`);
    await teacher.getByLabel('ชื่อบริษัทของโจทย์').fill(`ร้านสอบ ${t}`);
    await fillItem(teacher, 1, '01/10/2569', 'นำเงินสดมาลงทุน 40,000 บาท', [['1110', '40000', 'D'], ['3110', '40000', 'C']]);
    await teacher.getByRole('button', { name: 'เพิ่มข้อ' }).click();
    await fillItem(teacher, 2, '04/10/2569', 'จ่ายค่าเช่าร้าน 6,000 บาท', [['5220', '6000', 'D'], ['1110', '5000', 'C']]);
    await expect(teacher.getByText('ข้อ 2: เฉลยเดบิต 6,000.00 ไม่เท่าเครดิต 5,000.00 ผลต่าง 1,000.00')).toBeVisible();
    await teacher.getByLabel('ข้อ 2 เครดิต 2').fill('6000');
    await teacher.getByRole('listitem', { name: 'ข้อ 2', exact: true }).getByLabel('คะแนน').fill('2');
    await checkScreen(teacher, info, 'teacher-exercise-editor');
    await teacher.getByRole('button', { name: 'บันทึกชุดโจทย์' }).click();
    await teacher.waitForURL(/\/teacher\/exercises\/[0-9a-f-]{36}$/);

    // ---- มอบหมายเป็นการสอบ 30 นาที ----
    await teacher.getByRole('radio', { name: 'สอบ' }).check({ force: true });
    await teacher.getByLabel('ห้อง', { exact: true }).selectOption({ label: room.roomName });
    await teacher.getByLabel('ชื่อบริษัท', { exact: true }).fill(`สอบ E2E ${t}`);
    await teacher.getByLabel('เวลาสอบ (นาที)').fill('30');
    await teacher.getByLabel('นักเรียนเห็นผลตรวจ').selectOption('answers');
    await checkScreen(teacher, info, 'teacher-assign');
    await teacher.getByRole('button', { name: 'มอบหมายและเปิดบริษัท' }).click();
    await teacher.waitForURL(/\/teacher\/assignments\/[0-9a-f-]{36}$/);
    assignmentId = teacher.url().split('/').pop()!;
    await expect(teacher.getByText('ยังไม่เปิดเฉลย')).toBeVisible();

    // ---- นักเรียนเริ่มสอบ ----
    await login(student, 'student', room.code, room.temp);
    await student.waitForURL('**/change-password');
    await student.context().setExtraHTTPHeaders({ origin: originOf(student) });
    expect((await student.request.post('/api/auth/change-password', { data: { newPassword: room.password } })).status()).toBe(200);
    await student.goto('/');
    await student.waitForURL(/\/c\/[0-9a-f-]{36}$/); // บริษัทเดียว (ของงานนี้) เข้าให้เลย
    const co = student.url().split('/').pop()!;
    await student.goto(`/c/${co}/work`);
    await expect(student.getByText(/^สอบ 30 นาที/)).toBeVisible();
    await expect(student.getByText('นำเงินสดมาลงทุน')).toHaveCount(0); // ยังไม่เริ่ม = ไม่เห็นโจทย์
    await checkScreen(student, info, 'student-exam-before');
    await student.getByRole('button', { name: 'เริ่มสอบ' }).click();
    await student.getByRole('button', { name: 'ยืนยันเริ่มสอบ (เวลาเริ่มนับทันที)' }).click();
    await expect(student.getByRole('timer')).toContainText(/เหลือเวลาสอบ (29|30):\d\d/);
    await expect(student.getByText('นำเงินสดมาลงทุน 40,000 บาท')).toBeVisible();
    await expect(student.getByText('ผลตรวจและเฉลยแสดงเมื่อครูเปิดเฉลย')).toBeVisible();
    // ลงรายการข้อ 1 ถูก (สลับบรรทัด) ข้อ 2 ผิดบัญชี (หน้าจอสมุดรายวันมีเทสต์ของตัวเองแล้ว)
    for (const lines of [
      [{ account_code: '3110', credit: '40000' }, { account_code: '1110', debit: '40000' }],
      [{ account_code: '5230', debit: '6000' }, { account_code: '1110', credit: '6000' }],
    ]) {
      const r = await student.request.post(`/api/companies/${co}/journal`, { headers: { 'idempotency-key': randomUUID() },
        data: { date: lines[0]!.account_code === '3110' ? '2026-10-01' : '2026-10-04', description: 'ตามโจทย์', lines } });
      expect(r.status()).toBe(201);
    }
    await student.reload();
    await expect(student.getByRole('timer')).toBeVisible();
    await checkScreen(student, info, 'student-exam-running');

    // ---- ครูเห็นคะแนนอัตโนมัติ เปิดเฉลย ส่งออกคะแนน ----
    await teacher.reload();
    const row = isPhone(info) ? teacher.locator('li').filter({ hasText: room.code }) : teacher.getByRole('row').filter({ hasText: room.code });
    await expect(row.first()).toContainText('1.00/3.00');
    await checkScreen(teacher, info, 'teacher-assignment');
    await teacher.getByRole('button', { name: 'เปิดเฉลย' }).click();
    await expect(teacher.getByText('เปิดเฉลยแล้ว')).toBeVisible();
    const pdf = await teacher.request.get(`/export/assignment/${assignmentId}/scores.pdf`);
    expect(pdf.status()).toBe(200);
    expect(pdf.headers()['content-type']).toBe('application/pdf');
    expect((await pdf.body()).subarray(0, 5).toString()).toBe('%PDF-');
    const xlsx = await teacher.request.get(`/export/assignment/${assignmentId}/scores.xlsx`);
    expect(xlsx.headers()['content-disposition']).toMatch(/^attachment; filename="scores-[0-9a-f]{8}\.xlsx"; filename\*=UTF-8''/);
    expect((await xlsx.body()).subarray(0, 2).toString()).toBe('PK');
    // นักเรียนส่งออกคะแนนของห้องไม่ได้
    expect((await student.request.get(`/export/assignment/${assignmentId}/scores.pdf`)).status()).toBe(403);
    if (!info.project.name.includes('safari')) {
      // กดลิงก์จริงแล้วได้ไฟล์ .xlsx (ชื่อไทยมาทาง filename* · Chromium แบบ headless ตั้งชื่อไฟล์ที่ไม่ใช่ ASCII เป็น "download" จึงตรวจเนื้อไฟล์แทน)
      const [download] = await Promise.all([teacher.waitForEvent('download'), teacher.getByRole('link', { name: 'ส่งออก Excel' }).click()]);
      expect(readFileSync((await download.path())!).subarray(0, 2).toString()).toBe('PK');
    }

    // ---- นักเรียนเห็นผลและเฉลย ----
    await student.reload();
    await expect(student.getByText('ได้ 1.00 จาก 3.00 คะแนน')).toBeVisible();
    await expect(student.getByText('บรรทัดที่ขาด')).toBeVisible();
    await expect(student.getByText(/เดบิต 5220 ค่าเช่า 6,000.00/).first()).toBeVisible();
    await checkScreen(student, info, 'student-exam-result');

    // ---- รายงานของบริษัทเป็นไฟล์ ----
    const tb = await student.request.get(`/export/company/${co}/trial-balance.xlsx?month=2026-10`);
    expect(tb.status()).toBe(200);
    expect((await tb.body()).subarray(0, 2).toString()).toBe('PK');
    for (const r of ['ledger', 'statements', 'worksheet']) {
      const f = await student.request.get(`/export/company/${co}/${r}.pdf?month=2026-10`);
      expect(f.status(), r).toBe(200);
      expect((await f.body()).subarray(0, 5).toString()).toBe('%PDF-');
    }
    expect((await student.request.get(`/export/company/${randomUUID()}/trial-balance.pdf?month=2026-10`)).status()).toBe(404);
    await student.goto(`/c/${co}/trial-balance?month=2026-10`);
    await expect(student.getByRole('link', { name: 'ส่งออก PDF' })).toHaveAttribute('href', `/export/company/${co}/trial-balance.pdf?month=2026-10`);
    expect(errors).toEqual([]);
  } finally {
    if (assignmentId) await teacher.request.post(`/api/teacher/assignments/${assignmentId}/actions`, { data: { action: 'close' } });
    await tctx.close();
    await sctx.close();
  }
});

test('โหมดสาธิต: ครูสร้างบริษัทสาธิตจากชุดโจทย์ ลงรายการตามเฉลย ตัวอักษรใหญ่', async ({ page }, info) => {
  test.setTimeout(120_000);
  const t = tag(info);
  const errors = watchErrors(page);
  await login(page, 'staff', env.teacherEmail, env.teacherPassword);
  await page.waitForURL('**/teacher');
  await page.context().setExtraHTTPHeaders({ origin: originOf(page) });
  const set = await page.request.post('/api/teacher/exercises', { data: {
    title: `สาธิต ${t}`, companyName: 'ร้านสาธิต', items: [
      { date: '2026-10-02', narrative: 'ซื้อสินค้าเป็นเงินสด 3,500 บาท', lines: [{ account_code: '5110', debit: '3500' }, { account_code: '1110', credit: '3500' }] }] } });
  expect(set.status()).toBe(201);

  await page.getByRole('link', { name: 'สาธิต', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'สาธิตหน้าห้อง' })).toBeVisible();
  await page.getByLabel('ชุดโจทย์').selectOption({ label: `สาธิต ${t}` });
  await page.getByLabel('ชื่อบริษัท').fill(`สาธิต ${t}`);
  await checkScreen(page, info, 'teacher-demo-create');
  await page.getByRole('button', { name: 'สร้างบริษัทสาธิต' }).click();
  await page.waitForURL(/\/c\/[0-9a-f-]{36}\/work$/);
  await expect(page.getByRole('group', { name: 'ขนาดตัวอักษร' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'ใหญ่', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => document.documentElement.style.fontSize)).toBe('125%');
  await expect(page.getByText('ซื้อสินค้าเป็นเงินสด 3,500 บาท')).toBeVisible();
  await checkScreen(page, info, 'teacher-demo-work');
  await page.getByRole('link', { name: 'ลงรายการตามเฉลย' }).click();
  await expect(page.getByLabel('คำอธิบายรายการ')).toHaveValue('ซื้อสินค้าเป็นเงินสด 3,500 บาท');
  await page.getByRole('button', { name: /^ผ่านรายการ/ }).click();
  await expect(page.getByText(/ผ่านรายการเลขที่ JV-0001/)).toBeVisible();
  await page.goto(page.url().replace(/\/journal\/new.*$/, '/work'));
  await expect(page.getByText('ถูก · รายการของคุณ JV-0001')).toBeVisible();
  expect(errors).toEqual([]);
});
