import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import { checkScreen, freshStudentHome, watchErrors } from './helpers';

// ประเภทกิจการ (docs/phase7-spec.md ข้อ 1) ทุกจอ: ห้างหุ้นส่วน (แบ่งกำไรตามสัญญา) และบริษัทจำกัด (ประกาศ/จ่ายเงินปันผล)
const jv = async (page: Page, co: string, date: string, lines: { account_code: string; debit?: string; credit?: string }[]) => {
  const r = await page.request.post(`/api/companies/${co}/journal`, { headers: { 'idempotency-key': randomUUID() }, data: { date, description: 'รายการค้า', lines } });
  expect(r.status(), await r.text()).toBe(201);
};

test('ห้างหุ้นส่วน: ผังรายหุ้นส่วน การแบ่งกำไรในงบการเงิน และงบส่วนของผู้เป็นหุ้นส่วน', async ({ page, browser, baseURL }, info) => {
  test.setTimeout(120_000);
  const errors = watchErrors(page);
  const { home, co } = await freshStudentHome(page, browser, info, new URL(baseURL!).origin, 'หุ้นส่วน', {
    type: 'partnership', partners: [{ name: 'นายเอก', ratio: '3', interestRate: '10', salary: '2000' }, { name: 'นายโท', ratio: '2', interestRate: '10', salary: '1000' }] });
  await jv(page, co, '2026-01-01', [{ account_code: '1110', debit: '160000' }, { account_code: '3110', credit: '100000' }, { account_code: '3120', credit: '60000' }]);
  await jv(page, co, '2026-01-15', [{ account_code: '1110', debit: '80000' }, { account_code: '4120', credit: '80000' }]);
  await jv(page, co, '2026-03-01', [{ account_code: '5220', debit: '20000' }, { account_code: '1110', credit: '20000' }]);
  await jv(page, co, '2026-07-01', [{ account_code: '1110', debit: '12000' }, { account_code: '3120', credit: '12000' }]);

  await page.goto(`${home}/settings`);
  const panel = page.getByRole('region', { name: 'ประเภทกิจการ' });
  await expect(panel).toContainText('ห้างหุ้นส่วน');
  await expect(panel.getByRole('listitem', { name: 'หุ้นส่วนคนที่ 2' }).getByLabel('ชื่อหุ้นส่วน')).toHaveValue('นายโท');
  await checkScreen(page, info, 'entity-settings');

  await page.goto(`${home}/statements?month=2026-12&scope=ytd`);
  const income = page.getByRole('article', { name: 'งบกำไรขาดทุน' });
  await expect(income).toContainText('การแบ่งกำไร(ขาดทุน)สุทธิตามสัญญา');
  await expect(income.getByRole('row', { name: /นายเอก/ })).toContainText('38,440.00');
  await expect(page.getByRole('article', { name: 'งบแสดงฐานะการเงิน' })).toContainText('รวมส่วนของผู้เป็นหุ้นส่วน');
  await checkScreen(page, info, 'entity-statements');

  await page.goto(`${home}/equity-changes?month=2026-12&scope=ytd`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('งบแสดงการเปลี่ยนแปลงส่วนของผู้เป็นหุ้นส่วน');
  await expect(page.getByText(/ปลายงวด 232,000.00 ตรงกับงบแสดงฐานะการเงิน/)).toBeVisible();
  await checkScreen(page, info, 'entity-equity-changes');
  expect(errors).toEqual([]);
});

test('บริษัทจำกัด: ประกาศจ่ายเงินปันผลพร้อมทุนสำรองตามกฎหมาย แล้วจ่าย', async ({ page, browser, baseURL }, info) => {
  test.setTimeout(120_000);
  const errors = watchErrors(page);
  const { home, co } = await freshStudentHome(page, browser, info, new URL(baseURL!).origin, 'บริษัท', { type: 'company', parValue: '10', registeredShares: '100000' });
  await jv(page, co, '2026-01-02', [{ account_code: '1110', debit: '600000' }, { account_code: '3110', credit: '500000' }, { account_code: '3120', credit: '100000' }]);
  await jv(page, co, '2026-05-01', [{ account_code: '1110', debit: '200000' }, { account_code: '4120', credit: '200000' }]);
  await jv(page, co, '2026-06-01', [{ account_code: '5220', debit: '80000' }, { account_code: '1110', credit: '80000' }]);
  expect((await page.request.post(`/api/companies/${co}/fiscal-years/2026-12-31/close`, { headers: { 'idempotency-key': randomUUID() }, data: {} })).status()).toBe(201);

  await page.goto(`${home}/dividends`);
  const form = page.getByRole('form', { name: 'ประกาศจ่ายเงินปันผล' });
  await form.getByLabel('วันที่ประกาศ (วว/ดด/ปปปป)').fill('15/03/2570');
  await expect(form.getByRole('region', { name: 'ข้อมูล ณ วันที่ประกาศ' })).toContainText('120,000.00');
  await expect(form.getByLabel('จัดสรรเป็นทุนสำรองตามกฎหมาย')).toHaveValue('6000.00');
  await form.getByLabel('เงินปันผลต่อหุ้น (บาท)').fill('1');
  await expect(form.getByText('50,000 หุ้น × 1 = 50,000.00')).toBeVisible();
  await checkScreen(page, info, 'dividends-form');
  await form.getByRole('button', { name: 'ผ่านรายการประกาศจ่าย' }).click();
  await expect(form.getByRole('status')).toHaveText(/^ผ่านรายการเลขที่ JV-\d{4}$/);

  const list = page.getByRole('region', { name: 'เงินปันผลที่ประกาศแล้ว' });
  await list.getByRole('button', { name: 'จ่ายเงินปันผล' }).click();
  await list.getByLabel('วันที่จ่าย (วว/ดด/ปปปป)').fill('10/04/2570');
  await list.getByRole('button', { name: 'ยืนยัน' }).click();
  await expect(list).toContainText('จ่ายแล้ว');
  await checkScreen(page, info, 'dividends-list');

  await page.goto(`${home}/equity-changes?month=2027-04&scope=ytd`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('งบแสดงการเปลี่ยนแปลงส่วนของผู้ถือหุ้น');
  await expect(page.getByText(/ปลายงวด 670,000.00 ตรงกับงบแสดงฐานะการเงิน/)).toBeVisible();
  expect(errors).toEqual([]);
});
