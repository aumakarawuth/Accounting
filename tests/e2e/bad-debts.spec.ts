import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { checkScreen, freshStudentHome, watchErrors } from './helpers';

// ค่าเผื่อหนี้สงสัยจะสูญ · ตัดหนี้สูญ · ได้รับคืน (docs/phase6-spec.md ข้อ 4) ทุกจอ
// ขายเชื่อ 2 ใบ 10,700 + 5,350 = 16,050 → ค่าเผื่อ 2% ของลูกหนี้ = 321.00 → ตัด IV ใบที่สองทั้งใบ → ได้รับคืน 1,000

function taxId() {
  const first12 = `1${String(Date.now()).slice(-11)}`;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(first12[i]) * (13 - i);
  return first12 + ((11 - (sum % 11)) % 10);
}

test('ค่าเผื่อหนี้สงสัยจะสูญ → ตัดหนี้สูญรายใบ → ได้รับคืน: ลูกหนี้รายใบตรงบัญชีคุม', async ({ page, browser, baseURL }, info) => {
  test.setTimeout(120_000);
  const errors = watchErrors(page);
  const { home, co } = await freshStudentHome(page, browser, info, new URL(baseURL!).origin, 'หนี้สูญ');
  const api = async (method: 'post' | 'patch', path: string, data: object) => {
    const r = await page.request[method](`/api/companies/${co}${path}`, { headers: { 'idempotency-key': randomUUID() }, data });
    expect(r.status(), await r.text()).toBeLessThan(300);
    return r.json();
  };
  const prof = await (await page.request.get(`/api/companies/${co}/profile`)).json();
  await api('patch', '/profile', { version: prof.version, taxId: taxId(), address: 'กรุงเทพฯ' });
  await api('post', '/parties', { code: 'C1', name: 'ร้าน ลูกค้าหนึ่ง', isCustomer: true, isVendor: false, creditDays: 30 });
  await api('post', '/parties', { code: 'C2', name: 'ร้าน ลูกค้าสอง', isCustomer: true, isVendor: false, creditDays: 30 });
  await api('post', '/items', { code: 'G', name: 'สินค้าทั่วไป', unit: 'ชิ้น', isService: false });
  await api('post', '/sales/invoice', { date: '2026-06-05', partyCode: 'C1', lines: [{ itemCode: 'G', qty: '10', unitPrice: '1000' }] });
  await api('post', '/sales/invoice', { date: '2026-06-10', partyCode: 'C2', lines: [{ itemCode: 'G', qty: '5', unitPrice: '1000' }] });

  await page.goto(`${home}/sales/bad-debts?month=2026-06`);
  const summary = page.getByRole('region', { name: 'ยอดลูกหนี้และค่าเผื่อ' });
  await expect(summary.getByRole('status')).toHaveText('ลูกหนี้รายใบรวม 16,050.00 ตรงกับบัญชีคุม 1210');
  const form = page.getByRole('form', { name: 'ตั้งค่าเผื่อหนี้สงสัยจะสูญ' });
  await form.getByLabel('อัตราร้อยละ').fill('2');
  await form.getByRole('button', { name: 'ดูรายการก่อนลง' }).click();
  await expect(form.getByText('จะลง AJ: เดบิต 5270 หนี้สงสัยจะสูญ / เครดิต 1211 ค่าเผื่อหนี้สงสัยจะสูญ 321.00')).toBeVisible();
  await checkScreen(page, info, 'bad-debts-allowance');
  await form.getByRole('button', { name: 'ผ่านรายการปรับปรุง' }).click();
  await expect(form.getByRole('status')).toHaveText(/^ผ่านรายการเลขที่ AJ-\d{4}$/);
  await expect(summary).toContainText('321.00');

  const wo = page.getByRole('region', { name: 'ตัดหนี้สูญรายใบ' });
  await wo.getByLabel('ใบขายเชื่อ / ใบเพิ่มหนี้ที่ค้าง').selectOption({ label: 'IV-0002 ร้าน ลูกค้าสอง · ค้าง 5,350.00' });
  await wo.getByLabel('วันที่ (วว/ดด/ปปปป)').fill('25/06/2569');
  await wo.getByLabel('เหตุผล').fill('ลูกหนี้ปิดกิจการ');
  await wo.getByRole('button', { name: 'ตัดเป็นหนี้สูญ' }).click();
  await expect(wo.getByRole('status')).toHaveText(/^ผ่านรายการเลขที่ JV-\d{4}$/);
  await expect(summary.getByRole('status')).toHaveText('ลูกหนี้รายใบรวม 10,700.00 ตรงกับบัญชีคุม 1210');

  const list = page.getByRole('region', { name: 'รายการตัดหนี้สูญ' });
  await list.getByRole('button', { name: 'บันทึกหนี้สูญได้รับคืน' }).click();
  await list.getByLabel('จำนวนที่ได้รับคืน').fill('1000');
  await list.getByLabel('วันที่ (วว/ดด/ปปปป)').fill('28/06/2569');
  await list.getByRole('button', { name: 'บันทึกหนี้สูญได้รับคืน' }).last().click();
  await expect(list).toContainText('ยังไม่ได้รับคืน 4,350.00');
  await expect(summary.getByRole('status')).toHaveText('ลูกหนี้รายใบรวม 11,700.00 ตรงกับบัญชีคุม 1210');
  await checkScreen(page, info, 'bad-debts-writeoff');
  expect(errors).toEqual([]);
});
