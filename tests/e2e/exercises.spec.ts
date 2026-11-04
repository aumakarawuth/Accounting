import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test, expect, type Browser, type Page, type TestInfo } from '@playwright/test';
import { checkScreen, env, isPhone, login, watchErrors } from './helpers';

// เฟส 4: ครูสร้างชุดโจทย์ (หน้าจอ) → มอบหมายเป็นการสอบ → นักเรียนเริ่มสอบ ลงรายการ → ครูเห็นคะแนน เปิดเฉลย → นักเรียนเห็นผลและเฉลย
// · ส่งออกคะแนน/รายงาน PDF และ Excel · โหมดสาธิต (ลงรายการตามเฉลย ตัวอักษรใหญ่) ทุกจอ
// ชื่อบริษัทมีชื่อจอ + เลขสุ่ม รันซ้ำบนฐานเดิมได้ · ปิดสอบทุกครั้งตอนจบ (ไม่ให้นักเรียนค้างโหมด 1 เซสชัน)

const tag = (info: TestInfo) => `${info.project.name.toUpperCase().replace(/[^A-Z0-9]/g, '')}-${randomUUID().slice(0, 4)}`;

async function contexts(browser: Browser, info: TestInfo) {
  const opts = { viewport: info.project.use.viewport, hasTouch: info.project.use.hasTouch, isMobile: info.project.use.isMobile,
    userAgent: info.project.use.userAgent, deviceScaleFactor: info.project.use.deviceScaleFactor };
  const tctx = await browser.newContext(opts);
  const sctx = await browser.newContext(opts);
  return { tctx, sctx, teacher: await tctx.newPage(), student: await sctx.newPage() };
}

const originOf = (page: Page) => new URL(page.url()).origin;

async function fillItem(page: Page, no: number, date: string, narrative: string, lines: [string, string, 'D' | 'C'][]) {
  const item = page.getByRole('listitem', { name: `ข้อ ${no}`, exact: true });
  await item.getByLabel('วันที่').fill(date);
  await item.getByLabel('รายการค้า').fill(narrative);
  for (const [k, [code, amount, side]] of lines.entries()) {
    const box = item.getByRole('combobox', { name: `ข้อ ${no} รหัสบัญชี ${k + 1}` });
    await box.fill(code);
    await box.press('Escape');
    await item.getByLabel(`ข้อ ${no} ${side === 'D' ? 'เดบิต' : 'เครดิต'} ${k + 1}`).fill(amount);
  }
}

test('ครูสร้างโจทย์ → สอบ → นักเรียนเริ่มสอบ → ครูเปิดเฉลย → ผลและไฟล์ส่งออก', async ({ browser }, info) => {
  test.setTimeout(180_000);
  const t = tag(info);
  const { tctx, sctx, teacher, student } = await contexts(browser, info);
  const errors = [...watchErrors(teacher), ...watchErrors(student)];
  let assignmentId = '';
  try {
    // ---- ครูสร้างชุดโจทย์บนหน้าจอ ----
    await login(teacher, 'staff', env.teacherEmail, env.teacherPassword);
    await teacher.waitForURL('**/teacher');
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
    await teacher.getByLabel('ชื่อบริษัท', { exact: true }).fill(`สอบ E2E ${t}`);
    await teacher.getByLabel('เวลาสอบ (นาที)').fill('30');
    await teacher.getByLabel('นักเรียนเห็นผลตรวจ').selectOption('answers');
    await checkScreen(teacher, info, 'teacher-assign');
    await teacher.getByRole('button', { name: 'มอบหมายและเปิดบริษัท' }).click();
    await teacher.waitForURL(/\/teacher\/assignments\/[0-9a-f-]{36}$/);
    assignmentId = teacher.url().split('/').pop()!;
    await expect(teacher.getByText('ยังไม่เปิดเฉลย')).toBeVisible();

    // ---- นักเรียนเริ่มสอบ ----
    await login(student, 'student', env.studentCode, env.studentPassword);
    await expect(student.getByRole('heading', { name: 'เลือกบริษัท' }).or(student.locator('main'))).toBeVisible();
    await student.context().setExtraHTTPHeaders({ origin: originOf(student) });
    const mine = await (await student.request.get('/api/me/companies')).json() as { id: string; name: string }[];
    const co = mine.find((c) => c.name === `สอบ E2E ${t}`)!.id;
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
    const row = isPhone(info) ? teacher.locator('li').filter({ hasText: env.studentCode }) : teacher.getByRole('row').filter({ hasText: env.studentCode });
    await expect(row.first()).toContainText('1.00/3.00');
    await checkScreen(teacher, info, 'teacher-assignment');
    await teacher.getByRole('button', { name: 'เปิดเฉลย' }).click();
    await expect(teacher.getByText('เปิดเฉลยแล้ว')).toBeVisible();
    await teacher.context().setExtraHTTPHeaders({ origin: originOf(teacher) });
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
