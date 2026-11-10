import { randomUUID } from 'node:crypto';
import { test, expect, type Browser, type TestInfo } from '@playwright/test';
import { checkScreen, env, login, watchErrors } from './helpers';

// ปิดบัญชีสิ้นปี (docs/phase5-spec.md ข้อ 1) ทุกจอ: ปีก่อนยังไม่ปิด = เตือนในงบทดลองปีใหม่
// → ดูรายการปิดบัญชีก่อนยืนยัน → CL-0001 → งบทดลองหลังปิดบัญชี → งบการเงินปีใหม่ไม่มีรายได้ปีก่อน
// ครู ห้อง นักเรียน และบริษัทใหม่ต่อการรัน (ปิดปีแล้วลงรายการในปีนั้นไม่ได้ จึงไม่ใช้บริษัทตัวอย่างที่เทสต์อื่นใช้)

const tag = (info: TestInfo) => `${info.project.name.toUpperCase().replace(/[^A-Z0-9]/g, '')}-${randomUUID().slice(0, 4)}`;

async function setup(browser: Browser, info: TestInfo, origin: string) {
  const t = tag(info);
  const actx = await browser.newContext({ extraHTTPHeaders: { origin } });
  const admin = actx.request;
  expect((await admin.post(`${origin}/api/auth/login`, { data: { kind: 'staff', identifier: env.adminEmail, password: env.adminPassword } })).status()).toBe(200);
  const username = `ye-${t.toLowerCase()}`;
  const staff = await admin.post(`${origin}/api/admin/staff`, { data: { email: username, name: `ครูปิดบัญชี ${t}`, role: 'teacher' } });
  expect(staff.status()).toBe(201);
  const { id: teacherId, tempPassword } = await staff.json() as { id: string; tempPassword: string };
  const room = await admin.post(`${origin}/api/admin/classrooms`, { data: { name: `ห้องปิดบัญชี ${t}`, teacherId } });
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
  expect((await teacher.post(`${origin}/api/classrooms/${roomId}/companies`, { data: { name: `ร้านปิดบัญชี ${t}`, mode: 'practice' } })).status()).toBeLessThan(300);
  await tctx.close();
  return { code, temp };
}

test('ปิดบัญชีสิ้นปี: ตรวจรายการ → CL → งบทดลองหลังปิดบัญชี → ปีใหม่ไม่มีรายได้ปีก่อน', async ({ page, browser, baseURL }, info) => {
  test.setTimeout(120_000);
  const errors = watchErrors(page);
  const origin = new URL(baseURL!).origin;
  const { code, temp } = await setup(browser, info, origin);
  await login(page, 'student', code, temp);
  await page.waitForURL('**/change-password');
  await page.context().setExtraHTTPHeaders({ origin });
  expect((await page.request.post('/api/auth/change-password', { data: { newPassword: `ปิดบัญชี-${randomUUID().slice(0, 8)}` } })).status()).toBe(200);
  await page.goto('/');
  await page.waitForURL(/\/c\/[0-9a-f-]{36}$/);
  const home = new URL(page.url()).pathname;
  const co = home.split('/').pop()!;

  // ปี 2568: ทุน 100,000 · รายได้บริการ 30,000 · ค่าเช่า 12,000 · ค่าเสื่อม (AJ) 1,250 → กำไร 16,750 · ปีใหม่: รายได้ 5,000
  for (const [date, dr, cr, amount, adjusting] of [
    ['2025-01-02', '1110', '3110', '100000', false], ['2025-03-10', '1110', '4120', '30000', false],
    ['2025-06-15', '5220', '1110', '12000', false], ['2025-12-31', '5250', '1631', '1250', true],
    ['2026-01-05', '1110', '4120', '5000', false],
  ] as const) {
    const r = await page.request.post(`/api/companies/${co}/journal`, { headers: { 'idempotency-key': randomUUID() },
      data: { date, description: 'ทดสอบปิดบัญชี', adjusting, lines: [{ account_code: dr, debit: amount }, { account_code: cr, credit: amount }] } });
    expect(r.status()).toBe(201);
  }

  await page.goto(`${home}/trial-balance?month=2026-01`);
  await expect(page.getByRole('note').filter({ hasText: 'ยังไม่ได้ปิดบัญชีปีก่อน (สิ้นสุด 31/12/2568)' })).toBeVisible();
  await expect(page.getByText('35,000.00').filter({ visible: true }).first()).toBeVisible(); // ยังรวมรายได้ปีก่อน
  await checkScreen(page, info, 'year-end-tb-prior-unclosed');

  await page.goto(`${home}/closing`);
  const panel = page.getByRole('region', { name: 'ปิดบัญชีสิ้นปี' });
  await expect(panel.getByRole('row').filter({ hasText: '01/01/2568 – 31/12/2568' })).toContainText('ยังไม่ปิดบัญชี');
  await panel.getByRole('button', { name: 'ปิดบัญชีปีบัญชี 01/01/2568 – 31/12/2568' }).click();
  const confirm = panel.getByRole('region', { name: 'ปิดบัญชีปีบัญชี 01/01/2568 – 31/12/2568' });
  await expect(confirm.getByText('ระบบจะลงรายการด้านล่างวันที่ 31/12/2568')).toBeVisible();
  await expect(confirm.getByRole('row').filter({ hasText: 'กำไรสะสม' })).toContainText('16,750.00');
  await expect(confirm.getByRole('row').filter({ hasText: 'รายได้จากการบริการ' })).toContainText('30,000.00');
  await expect(confirm.getByText('กำไรสุทธิ 16,750.00')).toBeVisible();
  await checkScreen(page, info, 'year-end-preview');
  await confirm.getByRole('button', { name: 'ยืนยันปิดบัญชี' }).click();
  await expect(panel.getByRole('status')).toHaveText('ผ่านรายการเลขที่ CL-0001 ปิดบัญชีปีบัญชี 01/01/2568 – 31/12/2568 แล้ว');
  await expect(panel.getByRole('row').filter({ hasText: '01/01/2568 – 31/12/2568' })).toContainText('ปิดบัญชีแล้ว CL-0001');
  await expect(panel.getByLabel('ปีบัญชีเริ่มเดือน')).toBeDisabled();
  await checkScreen(page, info, 'year-end-closed');

  await page.goto(`${home}/trial-balance?month=2025-12`);
  await page.getByRole('link', { name: 'หลังปิดบัญชี' }).click();
  await expect(page.getByText('รวมรายการปิดบัญชี CL-0001')).toBeVisible();
  await expect(page.getByText('16,750.00').filter({ visible: true }).first()).toBeVisible();
  await expect(page.getByText('รายได้จากการบริการ').filter({ visible: true })).toHaveCount(0);
  await checkScreen(page, info, 'year-end-tb-after');

  await page.goto(`${home}/trial-balance?month=2026-01`);
  await expect(page.getByText('ยังไม่ได้ปิดบัญชีปีก่อน')).toHaveCount(0);
  await page.goto(`${home}/statements?month=2026-01&scope=ytd`);
  const income = page.getByRole('article', { name: 'งบกำไรขาดทุน' });
  await expect(income.getByText('รวมรายได้').locator('..')).toContainText('5,000.00');
  const position = page.getByRole('article', { name: 'งบแสดงฐานะการเงิน' });
  await expect(position.getByText('กำไรสะสม').locator('..')).toContainText('16,750.00');
  await expect(position.getByText('กำไร(ขาดทุน)สุทธิปีนี้').locator('..')).toContainText('5,000.00');
  await expect(position.getByText('กำไร(ขาดทุน)ปีก่อนที่ยังไม่ได้ปิดบัญชี')).toHaveCount(0);
  await checkScreen(page, info, 'year-end-statements-new-year');
  expect(errors).toEqual([]);
});
