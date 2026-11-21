import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { checkScreen, freshStudentHome, isPhone, watchErrors } from './helpers';

// งบแสดงการเปลี่ยนแปลงส่วนของเจ้าของ (docs/phase6-spec.md ข้อ 3) ทุกจอ:
// ลงทุน 80,000 · รายได้ 15,000 ค่าใช้จ่าย 6,000 (กำไร 9,000) · ถอนใช้ 1,500 → ปลายงวด 87,500 = งบแสดงฐานะการเงิน

test('งบแสดงการเปลี่ยนแปลงส่วนของเจ้าของ: ทุน + กำไร − ถอนใช้ ตรงงบแสดงฐานะการเงิน', async ({ page, browser, baseURL }, info) => {
  test.setTimeout(120_000);
  const errors = watchErrors(page);
  const { home, co } = await freshStudentHome(page, browser, info, new URL(baseURL!).origin, 'ส่วนของเจ้าของ');
  for (const [date, dr, cr, amount] of [
    ['2026-05-01', '1110', '3110', '80000'], ['2026-05-10', '1110', '4120', '15000'],
    ['2026-05-20', '5220', '1110', '6000'], ['2026-05-25', '3310', '1110', '1500'],
  ] as const) {
    const r = await page.request.post(`/api/companies/${co}/journal`, { headers: { 'idempotency-key': randomUUID() },
      data: { date, description: 'ทดสอบส่วนของเจ้าของ', lines: [{ account_code: dr, debit: amount }, { account_code: cr, credit: amount }] } });
    expect(r.status()).toBe(201);
  }
  await page.goto(`${home}/equity-changes?month=2026-05&scope=month`);
  const st = page.getByRole('article', { name: 'งบแสดงการเปลี่ยนแปลงส่วนของเจ้าของ' });
  if (isPhone(info)) {
    await expect(st.getByRole('listitem').filter({ hasText: 'ลงทุนเพิ่ม' })).toContainText('80,000.00');
    await expect(st.getByRole('listitem').filter({ hasText: 'ยอดคงเหลือปลายงวด' })).toContainText('87,500.00');
  } else {
    await expect(st.getByRole('row', { name: /ลงทุนเพิ่ม/ })).toContainText('80,000.00');
    await expect(st.getByRole('row', { name: /กำไร\(ขาดทุน\)สุทธิ/ })).toContainText('9,000.00');
    await expect(st.getByRole('row', { name: /^ถอนใช้ส่วนตัว/ })).toContainText('(1,500.00)');
    await expect(st.getByRole('row', { name: /ยอดคงเหลือปลายงวด/ })).toContainText('87,500.00');
  }
  await expect(st.getByRole('status')).toHaveText('รวมส่วนของเจ้าของปลายงวด 87,500.00 ตรงกับงบแสดงฐานะการเงิน');
  await checkScreen(page, info, 'equity-changes');
  for (const ext of ['pdf', 'xlsx']) {
    expect((await page.request.get(`/export/company/${co}/equity-changes.${ext}?month=2026-05&scope=month`)).status()).toBe(200);
  }
  expect(errors).toEqual([]);
});
