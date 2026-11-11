import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, type Browser, type Page, type TestInfo } from '@playwright/test';

export const env = {
  studentCode: process.env.E2E_STUDENT_CODE ?? '65012',
  studentPassword: process.env.E2E_STUDENT_PASSWORD ?? 'ลงบัญชีทุกวัน',
  teacherEmail: process.env.E2E_TEACHER_EMAIL ?? 'teacher@example.test',
  teacherPassword: process.env.E2E_TEACHER_PASSWORD ?? 'ครูบัญชีห้องห้า',
  adminEmail: process.env.E2E_ADMIN_EMAIL ?? 'admin-e2e@example.test',
  adminPassword: process.env.E2E_ADMIN_PASSWORD ?? 'ผู้ดูแลโรงเรียนทดสอบ',
  company: process.env.E2E_COMPANY ?? 'บริษัท ก. จำกัด',
};

/** เก็บ error ของหน้าเว็บทั้งหมด (pageerror + console.error) เพื่อยืนยันตอนจบว่าไม่มี */
export function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => {
    // WebKit รายงาน prefetch ของ Next (?_rsc= หรือ &_rsc= เมื่อลิงก์มี query อยู่แล้ว) ที่ถูกยกเลิกเพราะเทสต์ page.goto ออกจากหน้ากลางคัน ว่า "access control checks"
    // ไม่ใช่ปัญหาของแอป (ผู้ใช้จริงเปลี่ยนหน้าผ่านลิงก์ ไม่ unload หน้า) จึงข้ามเฉพาะข้อความนี้กับคำขอ _rsc เท่านั้น
    if (/[?&]_rsc=.*due to access control checks/.test(e.message)) return;
    errors.push(`pageerror: ${e.message}`);
  });
  page.on('console', (m) => {
    // 401/404 ที่ตั้งใจทดสอบ (เช่น รหัสผิด) เบราว์เซอร์รายงานเป็น console error ของ network
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`);
  });
  return errors;
}

/**
 * กติกาหลายอุปกรณ์ (PLAN.md ข้อ 8) ที่ตรวจอัตโนมัติได้:
 * ไม่มีเลื่อนแนวนอนเกินจอ · ช่องกรอก ≥ 16px (กัน iOS ซูม) · บนจอสัมผัส ปุ่ม ≥ 44px
 * แล้วถ่ายภาพเก็บไว้ให้เจ้าของโปรเจกต์ดูก่อน merge
 */
export async function checkScreen(page: Page, info: TestInfo, name: string) {
  // ไม่ใช้ networkidle: หน้าที่เปิด SSE ค้างไว้ (ป้ายครูกำลังดู) ไม่มีวันนิ่ง
  await page.waitForLoadState('load');
  // เทียบกับความกว้างจอที่ตั้งไว้ ไม่ใช่ innerWidth: มือถือจำลองขยาย layout viewport ตามเนื้อหาที่ล้น (ย่อทั้งหน้า) innerWidth จึงโตตาม
  const width = page.viewportSize()!.width;
  const r = await page.evaluate(({ touch, width }) => {
    const visible = (el: Element) => {
      const b = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return b.width > 0 && b.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    };
    const label = (el: Element) => (el.getAttribute('aria-label') || el.textContent || el.getAttribute('name') || el.tagName).trim().slice(0, 40);
    return {
      overflow: document.documentElement.scrollWidth - width,
      smallInputs: [...document.querySelectorAll('input:not([type=file]):not([type=hidden]), select, textarea')]
        .filter(visible).filter((el) => parseFloat(getComputedStyle(el).fontSize) < 16).map(label),
      smallButtons: touch
        ? [...document.querySelectorAll('button')].filter(visible)
            .filter((el) => el.getBoundingClientRect().height < 43.5).map(label)
        : [],
    };
  }, { touch: info.project.use.hasTouch === true, width });
  // tests/e2e-results/screens/<จอ>/<ชื่อ>.png (CI อัปโหลดเป็น artifact)
  const file = path.resolve(info.config.rootDir, '..', 'e2e-results', 'screens', info.project.name, `${name}.png`);
  // WebKit ถ่ายภาพได้ไม่เกิน 32,767 พิกเซลต่อด้าน (หน้ายาว × ความละเอียดจอ 3 เท่าของ iPhone) → เก็บภาพเฉพาะส่วนบนที่ถ่ายได้
  // การตรวจด้านบน (เลื่อนแนวนอน ขนาดช่อง/ปุ่ม) ยังตรวจทั้งหน้า
  const { height, dpr } = await page.evaluate(() => ({ height: document.documentElement.scrollHeight, dpr: window.devicePixelRatio }));
  const maxCss = Math.floor(32000 / dpr);
  await page.screenshot({ path: file, fullPage: true, ...(height > maxCss ? { clip: { x: 0, y: 0, width, height: maxCss } } : {}) });
  expect(r.overflow, `${name}: เลื่อนแนวนอนเกินจอ ${r.overflow}px`).toBeLessThanOrEqual(1);
  expect(r.smallInputs, `${name}: ช่องกรอกเล็กกว่า 16px`).toEqual([]);
  expect(r.smallButtons, `${name}: ปุ่มเตี้ยกว่า 44px บนจอสัมผัส`).toEqual([]);
}

export async function login(page: Page, kind: 'student' | 'staff', id: string, password: string) {
  await page.goto(kind === 'staff' ? '/login/staff' : '/login');
  await page.getByLabel(kind === 'staff' ? 'ชื่อผู้ใช้' : 'รหัสนักเรียน').fill(id);
  await page.getByLabel('รหัสผ่าน', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'เข้าใช้งาน' }).click();
}

/** นักเรียนเข้าแล้วไปที่บริษัทที่ทดสอบ (มีบริษัทเดียวจะถูกพาไปเอง หลายบริษัทเลือกจากหน้าแรก) */
export async function studentHome(page: Page): Promise<string> {
  await login(page, 'student', env.studentCode, env.studentPassword);
  const chooser = page.getByRole('heading', { name: 'เลือกบริษัท' });
  await expect(chooser.or(page.locator('main'))).toBeVisible();
  if (await chooser.isVisible()) {
    await page.getByRole('link', { name: new RegExp(`^${env.company.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) }).first().click();
  }
  await page.waitForURL(/\/c\/[0-9a-f-]{36}$/);
  return new URL(page.url()).pathname;
}

/** จอมือถือ (แถบล่าง + เมนูทั้งหมด แทนแถบข้าง) ใช้ได้ทั้ง Chromium และ Safari */
export const isPhone = (info: TestInfo) => (info.project.use.viewport?.width ?? 1280) < 640;

const tag = (info: TestInfo) => `${info.project.name.toUpperCase().replace(/[^A-Z0-9]/g, '')}-${randomUUID().slice(0, 4)}`;

/**
 * ผู้ดูแลสร้างครู + ห้องใหม่ → ครูนำเข้านักเรียนใหม่ 1 คน แล้วเปิดบริษัทให้ (โหมดฝึกหัด)
 * ใช้กับเทสต์ที่ลงรายการซึ่งกระทบเทสต์อื่น (เช่น ปิดบัญชีสิ้นปี) แทนบริษัทตัวอย่างที่ใช้ร่วมกัน
 */
export async function freshStudent(browser: Browser, info: TestInfo, origin: string, label: string) {
  const t = tag(info);
  const actx = await browser.newContext({ extraHTTPHeaders: { origin } });
  const admin = actx.request;
  expect((await admin.post(`${origin}/api/auth/login`, { data: { kind: 'staff', identifier: env.adminEmail, password: env.adminPassword } })).status()).toBe(200);
  const username = `ye-${t.toLowerCase()}`;
  const staff = await admin.post(`${origin}/api/admin/staff`, { data: { email: username, name: `ครู${label} ${t}`, role: 'teacher' } });
  expect(staff.status()).toBe(201);
  const { id: teacherId, tempPassword } = await staff.json() as { id: string; tempPassword: string };
  const room = await admin.post(`${origin}/api/admin/classrooms`, { data: { name: `ห้อง${label} ${t}`, teacherId } });
  expect(room.status()).toBe(201);
  const roomId = (await room.json()).id as string;
  await actx.close();

  const tctx = await browser.newContext({ extraHTTPHeaders: { origin } });
  const teacher = tctx.request;
  expect((await teacher.post(`${origin}/api/auth/login`, { data: { kind: 'staff', identifier: username, password: tempPassword } })).status()).toBe(200);
  expect((await teacher.post(`${origin}/api/auth/change-password`, { data: { newPassword: `ครูปิดบัญชี-${randomUUID().slice(0, 8)}` } })).status()).toBe(200);
  const code = `Y${randomUUID().replace(/-/g, '').slice(0, 10)}`;
  const temp = `ชั่วคราว-${randomUUID().slice(0, 8)}`;
  expect((await teacher.post(`${origin}/api/classrooms/${roomId}/import`, { data: { rows: [{ studentCode: code, name: `นักเรียน ${t}`, password: temp }] } })).status()).toBe(200);
  expect((await teacher.post(`${origin}/api/classrooms/${roomId}/companies`, { data: { name: `ร้าน${label} ${t}`, mode: 'practice' } })).status()).toBeLessThan(300);
  await tctx.close();
  return { code, temp };
}


/** นักเรียนใหม่ (freshStudent) เข้าครั้งแรก เปลี่ยนรหัส แล้วไปที่บริษัทของตัวเอง คืน path หน้าบริษัทและ id */
export async function freshStudentHome(page: Page, browser: Browser, info: TestInfo, origin: string, label: string) {
  const { code, temp } = await freshStudent(browser, info, origin, label);
  await login(page, 'student', code, temp);
  await page.waitForURL('**/change-password');
  await page.context().setExtraHTTPHeaders({ origin });
  expect((await page.request.post('/api/auth/change-password', { data: { newPassword: `${label}-${randomUUID().slice(0, 8)}` } })).status()).toBe(200);
  await page.goto('/');
  await page.waitForURL(/\/c\/[0-9a-f-]{36}$/);
  const home = new URL(page.url()).pathname;
  return { home, co: home.split('/').pop()! };
}
