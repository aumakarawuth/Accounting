import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { checkScreen, freshStudentHome, watchErrors } from './helpers';

// แม่แบบรายการ / รายการประจำเดือน (docs/phase7-spec.md ข้อ 5) ทุกจอ:
// บันทึกรายการค่าเช่าเป็นรายการประจำทุกวันที่ 31 → เดือน ก.พ. ค้าง (ถึงกำหนด 28) → นักเรียนกดลงเอง แก้ยอดได้ → ไม่ค้างแล้ว
test('บันทึกเป็นแม่แบบประจำเดือน แล้วกดยืนยันลงเอง', async ({ page, browser, baseURL }, info) => {
  test.setTimeout(120_000);
  const errors = watchErrors(page);
  const { home, co } = await freshStudentHome(page, browser, info, new URL(baseURL!).origin, 'แม่แบบ');
  const r = await page.request.post(`/api/companies/${co}/journal`, { headers: { 'idempotency-key': randomUUID() },
    data: { date: '2027-01-31', description: 'จ่ายค่าเช่าร้าน', lines: [{ account_code: '5220', debit: '8000' }, { account_code: '1110', credit: '8000' }] } });
  expect(r.status()).toBe(201);
  const entry = (await r.json()).id as string;

  await page.goto(`${home}/journal/${entry}`);
  await page.getByRole('button', { name: 'บันทึกเป็นแม่แบบ' }).click();
  const save = page.getByRole('form', { name: 'บันทึกเป็นแม่แบบ' });
  await save.getByLabel('ชื่อแม่แบบ').fill('ค่าเช่ารายเดือน');
  await save.getByLabel('ลงทุกเดือน (รายการประจำ)').check();
  await save.getByLabel(/^วันที่ของเดือน/).fill('31');
  await save.getByRole('button', { name: 'บันทึกแม่แบบ' }).click();
  await expect(save.getByRole('status')).toContainText('บันทึกแม่แบบ ค่าเช่ารายเดือน แล้ว');

  await page.goto(`${home}/templates?month=2027-02`);
  const due = page.getByRole('region', { name: /^รายการประจำที่ยังไม่ได้ลง/ });
  const item = due.getByRole('listitem', { name: 'ค่าเช่ารายเดือน' });
  await expect(item).toContainText('ถึงกำหนด 28/02/2570');
  await checkScreen(page, info, 'templates-due');
  await item.getByRole('button', { name: 'ลงรายการ' }).click();
  const panel = item.getByRole('region', { name: 'ลงรายการจากแม่แบบ ค่าเช่ารายเดือน' });
  await panel.getByLabel('เดบิต').fill('8500');
  await expect(panel).toContainText('ไม่ดุล ผลต่าง 500.00');
  await panel.getByLabel('เครดิต').fill('8500');
  await panel.getByRole('button', { name: 'ลงรายการ' }).click();
  await expect(page.getByRole('region', { name: 'แม่แบบทั้งหมด' })).toContainText(/เดือนนี้ลงแล้ว JV-\d{4}/);
  await expect(due).toContainText('รายการประจำของเดือนนี้ลงครบแล้ว');
  await checkScreen(page, info, 'templates-posted');
  expect(errors).toEqual([]);
});
