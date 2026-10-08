import { test, expect, type Page } from '@playwright/test';
import { checkScreen, env, login, studentHome, watchErrors } from './helpers';

// ลิงก์ทุกอันในเมนูต้องเปิดได้จริง (ไม่มี 404/500 ไม่มี error ในหน้า): นักเรียน (แถบข้าง แถบล่าง เมนูทั้งหมด) และครู
// เทสต์นี้ไม่ผูกกับรายการเมนูตายตัว อ่านลิงก์จากหน้าจริง เพิ่มเมนูใหม่แล้วถูกตรวจเอง

async function linksOn(page: Page, scope: string) {
  return page.locator(`${scope} a[href^="/"]`).evaluateAll((as) => [...new Set(as.map((a) => (a as HTMLAnchorElement).getAttribute('href')!))]);
}

async function visitAll(page: Page, hrefs: string[]) {
  const bad: string[] = [];
  for (const href of hrefs) {
    const r = await page.goto(href);
    const status = r?.status() ?? 0;
    const notFound = await page.getByText('ไม่พบหน้านี้').or(page.getByText('This page could not be found')).count();
    if (status >= 400 || notFound > 0) bad.push(`${href} → ${status}`);
  }
  return bad;
}

test('นักเรียน: ทุกลิงก์ในเมนูเปิดได้', async ({ page }) => {
  const errors = watchErrors(page);
  const home = await studentHome(page);
  await page.goto(`${home}/menu`);
  const hrefs = [...new Set([...(await linksOn(page, 'main')), ...(await linksOn(page, 'nav'))])]
    .filter((h) => h.startsWith(home) || h === '/');
  expect(hrefs.length).toBeGreaterThan(20);
  expect(await visitAll(page, hrefs)).toEqual([]);
  expect(errors).toEqual([]);
});

test('ครู: ทุกลิงก์ในหน้าครูเปิดได้', async ({ page }) => {
  const errors = watchErrors(page);
  await login(page, 'staff', env.teacherEmail, env.teacherPassword);
  await page.waitForURL(/\/teacher/);
  const hrefs = (await linksOn(page, 'body')).filter((h) => h.startsWith('/teacher') || h === '/privacy');
  expect(hrefs.length).toBeGreaterThan(2);
  expect(await visitAll(page, hrefs)).toEqual([]);
  expect(errors).toEqual([]);
});

test('หน้ารายงานรวมลิงก์ทุกรายงาน · หน้างานของฉันบอกสถานะงาน', async ({ page }, info) => {
  const errors = watchErrors(page);
  const home = await studentHome(page);
  await page.goto(`${home}/reports`);
  for (const name of ['แยกประเภท', 'งบทดลอง', 'กระดาษทำการ', 'งบการเงิน', 'ลูกหนี้คงค้าง', 'เจ้าหนี้คงค้าง', 'ภาษีมูลค่าเพิ่ม ภ.พ.30', 'ภาษีหัก ณ ที่จ่าย']) {
    await expect(page.getByRole('main').getByRole('link', { name: new RegExp(`^${name}`) })).toBeVisible();
  }
  await checkScreen(page, info, 'reports');
  await page.goto(`${home}/work`);
  await expect(page.getByRole('heading', { name: /^งานของฉัน/ })).toBeVisible();
  await expect(page.getByRole('region', { name: 'รายการที่ครูคอมเมนต์' })).toBeVisible();
  await checkScreen(page, info, 'my-work');
  expect(errors).toEqual([]);
});
