import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { checkScreen, freshStudentHome, isPhone, watchErrors } from './helpers';

// สมุดรายวันเฉพาะ (docs/phase6-spec.md ข้อ 1) ทุกจอ: ลงทุน → ขายเชื่อ → รับชำระ → จ่ายค่าเช่า → ปรับปรุง
// แต่ละรายการอยู่เล่มเดียว ยอดผ่านบัญชีดุล และส่งออก PDF/Excel ได้

function taxId() {
  const first12 = `1${String(Date.now()).slice(-11)}`;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(first12[i]) * (13 - i);
  return first12 + ((11 - (sum % 11)) % 10);
}

test('สมุดรายวันขาย/รับเงิน/จ่ายเงิน/ทั่วไป: แบบฟอร์มหลายช่อง + ยอดรวมผ่านบัญชีแยกประเภท', async ({ page, browser, baseURL }, info) => {
  test.setTimeout(120_000);
  const errors = watchErrors(page);
  const { home, co } = await freshStudentHome(page, browser, info, new URL(baseURL!).origin, 'สมุดเฉพาะ');
  const api = async (path: string, data: object) => {
    const r = await page.request.post(`/api/companies/${co}${path}`, { headers: { 'idempotency-key': randomUUID() }, data });
    expect(r.status(), await r.text()).toBeLessThan(300);
    return r.json();
  };
  const jv = (date: string, description: string, dr: string, cr: string, amount: string) =>
    api('/journal', { date, description, lines: [{ account_code: dr, debit: amount }, { account_code: cr, credit: amount }] });
  const prof = await (await page.request.get(`/api/companies/${co}/profile`)).json();
  const r = await page.request.patch(`/api/companies/${co}/profile`, { headers: { 'idempotency-key': randomUUID() },
    data: { version: prof.version, taxId: taxId(), address: 'กรุงเทพฯ' } });
  expect(r.status(), await r.text()).toBeLessThan(300);
  await api('/parties', { code: 'C1', name: 'ร้าน ลูกค้าหนึ่ง', isCustomer: true, isVendor: false, creditDays: 30 });
  await api('/items', { code: 'G', name: 'สินค้าทั่วไป', unit: 'ชิ้น', isService: false });
  await jv('2026-03-01', 'นำเงินมาลงทุน', '1110', '3110', '50000');
  const iv = await api('/sales/invoice', { date: '2026-03-05', partyCode: 'C1', lines: [{ itemCode: 'G', qty: '4', unitPrice: '250' }] });
  await api('/receipts', { date: '2026-03-15', partyCode: 'C1', cashAccount: '1110', allocations: [{ documentId: iv.id, amount: '600' }] });
  await jv('2026-03-20', 'จ่ายค่าเช่า', '5220', '1110', '3000');
  await jv('2026-03-31', 'ค่าไฟค้างจ่าย', '5230', '2310', '450');

  await page.goto(`${home}/books?month=2026-03&book=sales`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('สมุดรายวันขาย');
  const tabs = page.getByRole('navigation', { name: 'สมุดรายวันเฉพาะ' });
  await expect(tabs.getByRole('link', { name: 'ขาย (1)' })).toHaveAttribute('aria-current', 'page');
  await expect(tabs.getByRole('link', { name: 'รับเงิน (2)' })).toBeVisible();
  await expect(tabs.getByRole('link', { name: 'จ่ายเงิน (1)' })).toBeVisible();
  await expect(tabs.getByRole('link', { name: 'ทั่วไป (1)' })).toBeVisible();
  const posting = page.getByRole('region', { name: 'ยอดรวมผ่านไปบัญชีแยกประเภท' });
  await expect(posting.getByRole('row', { name: /1210 ลูกหนี้การค้า/ })).toContainText('1,070.00');
  await expect(posting.getByRole('status')).toHaveText('เดบิตรวม 1,070.00 = เครดิตรวม 1,070.00 ดุล');
  if (isPhone(info)) await expect(page.getByRole('list', { name: 'สมุดรายวันขาย' })).toContainText('ร้าน ลูกค้าหนึ่ง');
  else await expect(page.getByRole('region', { name: 'สมุดรายวันขาย' })).toContainText('ร้าน ลูกค้าหนึ่ง');
  await checkScreen(page, info, 'books-sales');

  await tabs.getByRole('link', { name: 'รับเงิน (2)' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('สมุดรายวันรับเงิน');
  await expect(posting.getByRole('row', { name: /1110 เงินสด/ })).toContainText('50,600.00');
  await expect(posting.getByRole('row', { name: /3110 ทุน/ })).toContainText('รายตัว');
  await expect(posting.getByRole('status')).toHaveText('เดบิตรวม 50,600.00 = เครดิตรวม 50,600.00 ดุล');
  await checkScreen(page, info, 'books-receipts');

  await tabs.getByRole('link', { name: 'จ่ายเงิน (1)' }).click();
  await expect(posting.getByRole('row', { name: /5220 ค่าเช่า/ })).toContainText('3,000.00');
  await tabs.getByRole('link', { name: 'ทั่วไป (1)' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('สมุดรายวันทั่วไป');
  await expect(posting.getByRole('row', { name: /2310 ค่าใช้จ่ายค้างจ่าย/ })).toContainText('450.00');
  await checkScreen(page, info, 'books-general');

  for (const ext of ['pdf', 'xlsx']) {
    const r = await page.request.get(`/export/company/${co}/journal-receipts.${ext}?month=2026-03`);
    expect(r.status()).toBe(200);
    expect((await r.body()).length).toBeGreaterThan(1000);
  }
  expect(errors).toEqual([]);
});
