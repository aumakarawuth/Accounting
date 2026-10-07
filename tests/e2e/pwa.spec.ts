import { test, expect, type Page } from '@playwright/test';
import { checkScreen, env, isPhone, login, studentHome, watchErrors } from './helpers';

// ร่างใน IndexedDB, ออฟไลน์, PWA (PLAN.md ข้อ 8: ร่างเก็บในเครื่อง แต่การลงบัญชีต้องออนไลน์เสมอ)

async function typeDraft(page: Page, home: string, note: string) {
  await page.goto(`${home}/journal/new`);
  await expect(page.getByText('กู้ร่างที่ยังไม่ได้ผ่านรายการ', { exact: false })).toHaveCount(0);
  await page.getByLabel('คำอธิบายรายการ').fill(note);
  const codes = page.getByRole('combobox');
  await codes.nth(0).fill('5240');
  await page.getByRole('option', { name: /5240/ }).click();
  await page.locator('input[inputmode=decimal]').nth(0).fill('77');
  await expect(page.getByRole('status').filter({ hasText: 'ร่างเก็บในเครื่องแล้ว' }).filter({ visible: true })).toBeVisible();
}

test('ร่างเก็บในเครื่อง: โหลดหน้าใหม่แล้วกู้คืน ทิ้งร่างได้ ผ่านรายการแล้วร่างหาย', async ({ page }, info) => {
  const errors = watchErrors(page);
  const home = await studentHome(page);
  const note = `ร่างค้าง ${info.project.name}`;
  await typeDraft(page, home, note);

  await page.reload();
  await expect(page.getByText('กู้ร่างที่ยังไม่ได้ผ่านรายการ', { exact: false })).toBeVisible();
  await expect(page.getByLabel('คำอธิบายรายการ')).toHaveValue(note);
  await expect(page.locator('input[inputmode=decimal]').nth(0)).toHaveValue('77');
  await checkScreen(page, info, 'draft-restored');

  await page.getByRole('button', { name: 'ทิ้งร่างนี้' }).click();
  await expect(page.getByLabel('คำอธิบายรายการ')).toHaveValue('');
  await page.reload();
  await expect(page.getByLabel('คำอธิบายรายการ')).toHaveValue('');
  await expect(page.getByText('กู้ร่างที่ยังไม่ได้ผ่านรายการ', { exact: false })).toHaveCount(0);

  // ร่างที่กู้มาผ่านรายการได้ตามปกติ แล้วไม่ค้างในเครื่อง
  await typeDraft(page, home, note);
  await page.reload();
  const codes = page.getByRole('combobox');
  await codes.nth(1).fill('1110');
  await page.getByRole('option', { name: /1110/ }).click();
  await page.locator('input[inputmode=decimal]').nth(3).fill('77');
  await page.getByRole('button', { name: /ผ่านรายการ/ }).click();
  await expect(page.getByText(/ผ่านรายการเลขที่ JV-\d{4}/)).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('คำอธิบายรายการ')).toHaveValue('');
  expect(errors).toEqual([]);
});

test('ออฟไลน์: แถบบนบอกสถานะ ผ่านรายการไม่ได้ เปิดหน้าใหม่ได้หน้าออฟไลน์ กลับมาออนไลน์แล้วทำต่อได้', async ({ page, context, browserName }, info) => {
  const home = await studentHome(page);
  // service worker คุมเฉพาะ /c/: โหลดหน้าบริษัทตรง ๆ (ไม่ใช่ผ่าน router จาก /login) รอติดตั้ง แล้วโหลดใหม่ให้มันคุมหน้า
  await page.goto(home);
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.reload();
  const note = `ร่างออฟไลน์ ${info.project.name}`;
  await typeDraft(page, home, note);
  const codes = page.getByRole('combobox');
  await codes.nth(1).fill('1110');
  await page.getByRole('option', { name: /1110/ }).click();
  await page.locator('input[inputmode=decimal]').nth(3).fill('77');
  // รอให้ร่างบรรทัดที่ 2 ลงเครื่องจริงก่อนตัดเน็ต (คนจริงพิมพ์แล้วออกจากหน้าเร็วขนาดเทสต์ไม่ได้)
  await expect.poll(() => page.evaluate(() => new Promise<number>((res) => {
    const r = indexedDB.open('accounting', 1);
    r.onsuccess = () => {
      const g = r.result.transaction('drafts').objectStore('drafts').getAll();
      g.onsuccess = () => { r.result.close(); res((g.result[0]?.lines ?? []).filter((l: { credit: string }) => l.credit === '77').length); };
    };
  }))).toBe(1);

  await context.setOffline(true);
  await expect(page.getByRole('status').filter({ hasText: 'ออฟไลน์ ร่างยังเก็บในเครื่อง' }).filter({ visible: true })).toBeVisible();
  await page.getByRole('button', { name: /ผ่านรายการ/ }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'ไม่มีอินเทอร์เน็ต ร่างยังเก็บในเครื่อง' })).toBeVisible();
  await checkScreen(page, info, 'journal-offline');

  // หน้าออฟไลน์จาก service worker: WebKit ของ Playwright ตัดการนำทางที่ชั้นเครือข่ายก่อนถึง service worker
  // (CI: page.goto ถูกปฏิเสธ หน้ายังอยู่ที่เดิมทั้งที่ service worker คุมหน้าอยู่) จึงตรวจขั้นนี้บน Chromium
  // ส่วน Safari จริงต้องลองบนเครื่อง: docs/device-test.md ข้อ 9
  if (browserName !== 'webkit') {
    await page.goto(`${home}/trial-balance`).catch(() => {});
    const seen = await page.evaluate(() => ({
      url: location.href, controlled: !!navigator.serviceWorker?.controller, title: document.title,
      text: document.body?.innerText.slice(0, 160),
    })).catch((e) => String(e));
    await expect(page.getByRole('heading', { name: 'ไม่มีอินเทอร์เน็ต' }), `หน้าออฟไลน์ไม่ขึ้น: ${JSON.stringify(seen)}`).toBeVisible();
    await checkScreen(page, info, 'offline-page');
  } else {
    info.annotations.push({ type: 'manual', description: 'หน้าออฟไลน์บน Safari ตรวจบนเครื่องจริง (docs/device-test.md ข้อ 9)' });
  }

  await context.setOffline(false);
  await page.goto(`${home}/journal/new`);
  await expect(page.getByLabel('คำอธิบายรายการ')).toHaveValue(note);
  await page.getByRole('button', { name: /ผ่านรายการ/ }).click();
  await expect(page.getByText(/ผ่านรายการเลขที่ JV-\d{4}/)).toBeVisible();
});

test('ออกจากระบบแล้วร่างในเครื่องถูกล้าง (เครื่องห้องคอมใช้ร่วมกัน)', async ({ page }, info) => {
  const home = await studentHome(page);
  await typeDraft(page, home, `ร่างก่อนออก ${info.project.name}`);
  if (isPhone(info)) await page.goto(`${home}/menu`);
  await page.getByRole('button', { name: 'ออกจากระบบ' }).filter({ visible: true }).first().click();
  await page.waitForURL('**/login');
  await login(page, 'student', env.studentCode, env.studentPassword);
  await page.waitForURL(/\/c\/[0-9a-f-]{36}$/); // รอ redirect ไปบริษัทจบก่อน (Safari เร็วจน goto ชนกับ redirect)
  await page.goto(`${home}/journal/new`);
  await expect(page.getByLabel('คำอธิบายรายการ')).toHaveValue('');
  await expect(page.getByText('กู้ร่างที่ยังไม่ได้ผ่านรายการ', { exact: false })).toHaveCount(0);
});

test('PWA: manifest และไอคอนพร้อมติดตั้ง', async ({ request }) => {
  const m = await request.get('/manifest.webmanifest');
  expect(m.ok()).toBe(true);
  const json = await m.json();
  expect(json).toMatchObject({ name: 'บัญชีห้องเรียน', start_url: '/', display: 'standalone', lang: 'th' });
  for (const icon of json.icons as { src: string }[]) {
    const r = await request.get(icon.src);
    expect(r.headers()['content-type']).toBe('image/png');
  }
  const sw = await request.get('/sw.js');
  expect(sw.headers()['cache-control']).toContain('no-cache');
});
