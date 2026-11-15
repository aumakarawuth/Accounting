import { randomUUID } from 'node:crypto';
import { test, expect, type TestInfo } from '@playwright/test';
import { checkScreen, env, login, watchErrors } from './helpers';

// งานเดียวหลายชุดโจทย์ (docs/assumptions.md ข้อ 52): ครูเลือกชุดเพิ่มบนหน้ามอบหมาย → เวียนตามรหัสนักเรียน
// นักเรียนรหัสน้อยกว่าได้ชุด ก อีกคนได้ชุด ข · แต่ละคนเห็นโจทย์ของชุดตัวเอง · ครูเห็นคอลัมน์ชุดและโจทย์ทั้งสองชุด
const tag = (info: TestInfo) => `${info.project.name.toUpperCase().replace(/[^A-Z0-9]/g, '')}-${randomUUID().slice(0, 4)}`;
const set = (title: string, narrative: string, amount: string) => ({
  title, companyName: 'ร้านสลับชุด', description: '',
  items: [{ date: '2026-10-01', narrative, points: '2', lines: [{ account_code: '1110', debit: amount }, { account_code: '3110', credit: amount }] }],
});

test('มอบหมายสองชุด เวียนตามรหัสนักเรียน: แต่ละคนเห็นโจทย์ชุดตัวเอง ครูเห็นว่าใครได้ชุดไหน', async ({ page, browser, baseURL }, info) => {
  test.setTimeout(120_000);
  const errors = watchErrors(page);
  const origin = new URL(baseURL!).origin;
  const t = tag(info);
  const actx = await browser.newContext({ extraHTTPHeaders: { origin } });
  expect((await actx.request.post(`${origin}/api/auth/login`, { data: { kind: 'staff', identifier: env.adminEmail, password: env.adminPassword } })).status()).toBe(200);
  const username = `sets-${t.toLowerCase()}`;
  const staff = await (await actx.request.post(`${origin}/api/admin/staff`, { data: { email: username, name: `ครูสลับชุด ${t}`, role: 'teacher' } })).json();
  const roomName = `ห้องสลับชุด ${t}`;
  const roomId = (await (await actx.request.post(`${origin}/api/admin/classrooms`, { data: { name: roomName, teacherId: staff.id } })).json()).id as string;
  await actx.close();

  const tctx = await browser.newContext({ extraHTTPHeaders: { origin } });
  const api = tctx.request;
  expect((await api.post(`${origin}/api/auth/login`, { data: { kind: 'staff', identifier: username, password: staff.tempPassword } })).status()).toBe(200);
  const password = `ครูสลับชุด-${randomUUID().slice(0, 8)}`;
  expect((await api.post(`${origin}/api/auth/change-password`, { data: { newPassword: password } })).status()).toBe(200);
  const base = `S${randomUUID().replace(/-/g, '').slice(0, 8)}`;
  const kids = [{ studentCode: `${base}-1`, name: `นักเรียนหนึ่ง ${t}`, password: `ชุดกอไก่-${t}` }, { studentCode: `${base}-2`, name: `นักเรียนสอง ${t}`, password: `ชุดขอไข่-${t}` }];
  expect((await api.post(`${origin}/api/classrooms/${roomId}/import`, { data: { rows: kids } })).status()).toBe(200);
  const mk = async (body: unknown) => (await (await api.post(`${origin}/api/teacher/exercises`, { data: body })).json()).id as string;
  const setA = await mk(set(`ชุดเงินทุนสี่หมื่น ${t}`, 'นำเงินสดมาลงทุน 40,000 บาท', '40000'));
  await mk(set(`ชุดเงินทุนหกหมื่น ${t}`, 'นำเงินสดมาลงทุน 60,000 บาท', '60000'));
  await tctx.close();

  // ---- ครูมอบหมายบนหน้าจอ เลือกชุดเพิ่ม ----
  await login(page, 'staff', username, password);
  await page.waitForURL('**/teacher');
  await page.goto(`/teacher/exercises/${setA}`);
  const form = page.getByRole('form', { name: 'มอบหมายให้ห้อง' });
  await form.getByRole('radio', { name: 'ฝึกหัด' }).check({ force: true });
  await form.getByRole('combobox', { name: 'ห้อง', exact: true }).selectOption({ label: roomName });
  await form.getByLabel('ชื่อบริษัท', { exact: true }).fill(`สลับชุด ${t}`);
  await form.getByRole('checkbox', { name: new RegExp(`ชุดเงินทุนหกหมื่น ${t}`) }).check();
  await expect(form.getByText(`ชุด ข · ชุดเงินทุนหกหมื่น ${t} (1 ข้อ 2.00 คะแนน)`)).toBeVisible();
  await expect(form.getByLabel('วิธีแจกชุด')).toHaveValue('rotate');
  await checkScreen(page, info, 'assign-two-sets');
  await form.getByRole('button', { name: 'มอบหมายและเปิดบริษัท' }).click();
  await page.waitForURL(/\/teacher\/assignments\/[0-9a-f-]{36}$/);
  const row = (code: string) => page.getByRole('row').filter({ hasText: code }).or(page.getByRole('listitem').filter({ hasText: code })).filter({ visible: true });
  await expect(row(kids[0]!.studentCode)).toContainText('ชุด ก');
  await expect(row(kids[1]!.studentCode)).toContainText('ชุด ข');
  await expect(page.getByRole('heading', { name: `ชุด ข · ชุดเงินทุนหกหมื่น ${t}` })).toBeVisible();
  await checkScreen(page, info, 'assignment-two-sets');

  // ---- นักเรียนคนที่สองเห็นโจทย์ชุด ข เท่านั้น ----
  const sctx = await browser.newContext({ viewport: info.project.use.viewport, isMobile: info.project.use.isMobile, hasTouch: info.project.use.hasTouch });
  const student = await sctx.newPage();
  errors.push(...watchErrors(student));
  await login(student, 'student', kids[1]!.studentCode, kids[1]!.password);
  await student.waitForURL(/\/c\/[0-9a-f-]{36}$/);
  await student.goto(`${new URL(student.url()).pathname}/work`);
  await expect(student.getByText('นำเงินสดมาลงทุน 60,000 บาท').filter({ visible: true }).first()).toBeVisible();
  await expect(student.getByText('นำเงินสดมาลงทุน 40,000 บาท')).toHaveCount(0);
  await sctx.close();
  expect(errors).toEqual([]);
});
