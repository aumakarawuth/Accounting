import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import { checkScreen, freshStudentHome, watchErrors } from './helpers';

// ภาษีเงินได้นิติบุคคล (docs/phase7-spec.md ข้อ 2) ทุกจอ: ภ.ง.ด.51 ประมาณการ → ภ.ง.ด.50 สิ้นปี → ชำระ
const jv = async (page: Page, co: string, date: string, lines: { account_code: string; debit?: string; credit?: string }[]) => {
  const r = await page.request.post(`/api/companies/${co}/journal`, { headers: { 'idempotency-key': randomUUID() }, data: { date, description: 'รายการค้า', lines } });
  expect(r.status(), await r.text()).toBe(201);
};

test('ภ.ง.ด.51 และ ภ.ง.ด.50 ของบริษัท SME', async ({ page, browser, baseURL }, info) => {
  test.setTimeout(120_000);
  const errors = watchErrors(page);
  const { home, co } = await freshStudentHome(page, browser, info, new URL(baseURL!).origin, 'ภาษีนิติ', { type: 'company', parValue: '10' });
  await jv(page, co, '2026-01-02', [{ account_code: '1110', debit: '1000000' }, { account_code: '3110', credit: '1000000' }]);
  await jv(page, co, '2026-03-10', [{ account_code: '1110', debit: '1500000' }, { account_code: '4120', credit: '1500000' }]);
  await jv(page, co, '2026-04-30', [{ account_code: '5220', debit: '900000' }, { account_code: '1110', credit: '900000' }]);

  await page.goto(`${home}/tax/income-tax?year=2026-12-31`);
  const f51 = page.getByRole('form', { name: 'ภ.ง.ด.51 ภาษีครึ่งปี (ประมาณการ)' });
  await expect(f51.getByLabel('ประมาณการกำไรสุทธิทั้งปี')).toHaveValue('1200000.00');
  await expect(f51).toContainText('67,500.00');
  await f51.getByLabel('วันที่ชำระ (วว/ดด/ปปปป)').fill('20/08/2569');
  await checkScreen(page, info, 'income-tax-51');
  await f51.getByRole('button', { name: 'ผ่านรายการ ภ.ง.ด.51' }).click();
  await expect(f51.getByRole('status')).toHaveText(/JV-\d{4}/);

  await jv(page, co, '2026-09-15', [{ account_code: '1110', debit: '2000000' }, { account_code: '4120', credit: '2000000' }]);
  await jv(page, co, '2026-10-15', [{ account_code: '5220', debit: '600000' }, { account_code: '1110', credit: '600000' }]);
  await page.goto(`${home}/tax/income-tax?year=2026-12-31`);
  const f50 = page.getByRole('form', { name: 'ภ.ง.ด.50 ภาษีสิ้นปี' });
  await expect(f50).toContainText('255,000.00');
  await expect(f50).toContainText('187,500.00');
  await f50.getByRole('button', { name: 'ผ่านรายการ ภ.ง.ด.50' }).click();
  await expect(f50.getByRole('status')).toHaveText(/AJ-\d{4}/);

  const list = page.getByRole('region', { name: 'แบบที่ยื่นแล้ว' });
  await list.getByRole('button', { name: 'ชำระภาษีค้างจ่าย' }).click();
  await list.getByLabel('วันที่ชำระ (วว/ดด/ปปปป)').fill('30/05/2570');
  await list.getByRole('button', { name: 'ยืนยัน' }).click();
  await expect(list).toContainText('ชำระแล้ว');
  await checkScreen(page, info, 'income-tax-list');

  await page.goto(`${home}/statements?month=2026-12&scope=ytd`);
  await expect(page.getByRole('article', { name: 'งบกำไรขาดทุน' })).toContainText('1,745,000.00');
  expect(errors).toEqual([]);
});
