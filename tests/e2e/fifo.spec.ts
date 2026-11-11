import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { checkScreen, freshStudentHome, watchErrors } from './helpers';

// ต้นทุน FIFO (docs/phase5-spec.md ข้อ 7): ตั้งวิธีของบริษัท → ซื้อ 2 ราคา → ขาย → บัตรสต็อกแสดงชั้นต้นทุนที่เหลือ

function taxId(first12: string) {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(first12[i]) * (13 - i);
  return first12 + ((11 - (sum % 11)) % 10);
}

test('ตั้งวิธี FIFO แล้วดูชั้นต้นทุนในบัตรสต็อก', async ({ page, browser, baseURL }, info) => {
  test.setTimeout(120_000);
  const errors = watchErrors(page);
  const { home, co } = await freshStudentHome(page, browser, info, new URL(baseURL!).origin, 'ต้นทุน FIFO');
  const api = `/api/companies/${co}`;
  const post = async (path: string, data: object) => {
    const r = await page.request.post(`${api}${path}`, { headers: { 'idempotency-key': randomUUID() }, data });
    expect(r.status(), await r.text()).toBe(201);
    return r.json();
  };
  const profile = await (await page.request.get(`${api}/profile`)).json();
  expect((await page.request.patch(`${api}/profile`, { data: { version: profile.version, taxId: taxId('010555801234') } })).ok()).toBe(true);
  await post('/parties', { code: 'C1', name: 'ร้าน ลูกค้าหนึ่ง', isCustomer: true, isVendor: false });
  await post('/parties', { code: 'V1', name: 'ร้าน ผู้ขายหนึ่ง', isCustomer: false, isVendor: true });
  await post('/items', { code: 'F', name: 'ไส้กรองน้ำ', unit: 'ชิ้น', isService: false, trackInventory: true });

  // วิธีของบริษัท: ถัวเฉลี่ย → FIFO (ยังไม่มีความเคลื่อนไหว เปลี่ยนได้)
  await page.goto(`${home}/inventory`);
  const method = page.getByRole('region', { name: 'วิธีคิดต้นทุนของบริษัท' });
  await expect(method.getByRole('radio', { name: 'ถัวเฉลี่ยเคลื่อนที่' })).toBeChecked();
  await method.getByRole('radio', { name: 'เข้าก่อนออกก่อน (FIFO)' }).check();
  await method.getByRole('button', { name: 'บันทึกวิธีคิดต้นทุน' }).click();
  await expect(method.getByRole('status')).toHaveText('บันทึกแล้ว');

  const today = new Date().toISOString().slice(0, 10);
  await post('/purchases/invoice', { date: today, partyCode: 'V1', vendorDocNo: 'B-1', lines: [{ itemCode: 'F', qty: '10', unitPrice: '100' }] });
  await post('/purchases/invoice', { date: today, partyCode: 'V1', vendorDocNo: 'B-2', lines: [{ itemCode: 'F', qty: '10', unitPrice: '130' }] });
  await post('/sales/invoice', { date: today, partyCode: 'C1', lines: [{ itemCode: 'F', qty: '15', unitPrice: '300' }] });

  // ขาย 15: 10 × 100 + 5 × 130 = 1,650 · เหลือชั้น 5 × 130 = 650
  await page.goto(`${home}/inventory?item=F`);
  await expect(page.getByRole('row').filter({ hasText: 'ไส้กรองน้ำ' }).first()).toContainText('650.00');
  const layers = page.getByRole('region', { name: 'ชั้นต้นทุนคงเหลือ (FIFO)' });
  await expect(layers.getByRole('row').nth(1)).toContainText('130.00');
  await expect(layers.getByRole('row').nth(1)).toContainText('650.00');
  await expect(page.getByText('1,650.00').first()).toBeVisible();
  await expect(page.getByRole('radio', { name: 'เข้าก่อนออกก่อน (FIFO)' })).toBeChecked();
  await checkScreen(page, info, 'fifo-card');
  expect(errors).toEqual([]);
});
