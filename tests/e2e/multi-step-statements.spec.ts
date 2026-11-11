import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { checkScreen, freshStudentHome, watchErrors } from './helpers';

// งบการเงินหลายขั้น + สินค้าปลายงวดระบบสิ้นงวด (docs/phase5-spec.md ข้อ 2) ทุกจอ:
// ยกมา 15,000 → ก.พ. ซื้อ 40,000 ส่งคืน 2,000 ขาย 60,000 ค่าเช่า 5,000 → ตรวจนับปลาย ก.พ. 18,240
// → ต้นทุนขาย 15,000 + 38,000 − 18,240 = 34,760 · กำไรขั้นต้น 25,240 · กำไรสุทธิ 20,240

test('ระบบสิ้นงวด: ตรวจนับปลายเดือน → งบกำไรขาดทุนหลายขั้น + ฐานะการเงินแยกหมุนเวียน', async ({ page, browser, baseURL }, info) => {
  test.setTimeout(120_000);
  const errors = watchErrors(page);
  const { home, co } = await freshStudentHome(page, browser, info, new URL(baseURL!).origin, 'งบหลายขั้น');
  for (const [date, dr, cr, amount] of [
    ['2025-01-02', '1110', '3110', '200000'], ['2025-01-02', '1310', '3110', '15000'], ['2025-01-03', '1630', '2610', '36000'],
    ['2025-02-05', '5110', '2110', '40000'], ['2025-02-08', '2110', '5140', '2000'], ['2025-02-15', '1110', '4110', '60000'],
    ['2025-02-20', '5220', '1110', '5000'],
  ] as const) {
    const r = await page.request.post(`/api/companies/${co}/journal`, { headers: { 'idempotency-key': randomUUID() },
      data: { date, description: 'ทดสอบงบหลายขั้น', lines: [{ account_code: dr, debit: amount }, { account_code: cr, credit: amount }] } });
    expect(r.status()).toBe(201);
  }

  await page.goto(`${home}/closing`);
  const panel = page.getByRole('region', { name: 'สินค้าคงเหลือปลายงวด (ระบบสิ้นงวด)' });
  await panel.getByLabel('สิ้นเดือน').selectOption('2025-02');
  await expect(panel.getByText('ยอดบัญชี 1310 ณ 28 ก.พ. 2568: 15,000.00')).toBeVisible();
  await panel.getByLabel('มูลค่าที่ตรวจนับได้ (บาท)').fill('18240');
  await expect(panel.getByText('จะลง: เดบิต 1310 สินค้าคงเหลือ / เครดิต 5130 ต้นทุนขาย 3,240.00')).toBeVisible();
  await checkScreen(page, info, 'ending-inventory');
  await panel.getByRole('button', { name: 'ผ่านรายการปรับปรุงสินค้าปลายงวด' }).click();
  await expect(panel.getByRole('status')).toHaveText(/^ผ่านรายการเลขที่ AJ-\d{4}$/);
  await expect(panel.getByText('ยอดบัญชี 1310 ณ 28 ก.พ. 2568: 18,240.00')).toBeVisible();

  await page.goto(`${home}/statements?month=2025-02&scope=month`);
  const income = page.getByRole('article', { name: 'งบกำไรขาดทุน' });
  const line = (label: string) => income.getByText(label, { exact: true }).locator('..');
  await expect(line('สินค้าคงเหลือต้นงวด')).toContainText('15,000.00');
  await expect(line('หัก ส่งคืนสินค้า')).toContainText('2,000.00');
  await expect(line('ซื้อสุทธิ')).toContainText('38,000.00');
  await expect(line('สินค้าที่มีไว้เพื่อขาย')).toContainText('53,000.00');
  await expect(line('หัก สินค้าคงเหลือปลายงวด')).toContainText('18,240.00');
  await expect(line('รวมต้นทุนขาย')).toContainText('34,760.00');
  await expect(line('กำไรขั้นต้น')).toContainText('25,240.00');
  await expect(line('กำไรสุทธิ')).toContainText('20,240.00');
  const position = page.getByRole('article', { name: 'งบแสดงฐานะการเงิน' });
  await expect(position.getByText('รวมสินทรัพย์หมุนเวียน').locator('..')).toContainText('273,240.00');
  await expect(position.getByText('รวมสินทรัพย์ไม่หมุนเวียน').locator('..')).toContainText('36,000.00');
  await expect(position.getByText('รวมหนี้สินหมุนเวียน').locator('..')).toContainText('38,000.00');
  await expect(position.getByText('รวมหนี้สินไม่หมุนเวียน').locator('..')).toContainText('36,000.00');
  await expect(position.getByText('สินทรัพย์เท่ากับหนี้สินและส่วนของเจ้าของ')).toBeVisible();
  await checkScreen(page, info, 'statements-multi-step');
  expect(errors).toEqual([]);
});
