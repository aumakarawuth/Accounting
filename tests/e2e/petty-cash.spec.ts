import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { checkScreen, freshStudentHome, watchErrors } from './helpers';

// เงินสดย่อย + ฝาก/ถอน/โอนเงิน (docs/phase5-spec.md ข้อ 9): ฝากเงิน → ตั้งวงเงิน → จ่ายใบสำคัญ → เบิกชดเชย

test('ฝากเงิน ตั้งวงเงินสดย่อย จ่าย แล้วเบิกชดเชย', async ({ page, browser, baseURL }, info) => {
  test.setTimeout(120_000);
  const errors = watchErrors(page);
  const { home, co } = await freshStudentHome(page, browser, info, new URL(baseURL!).origin, 'เงินสดย่อย');
  const r = await page.request.post(`/api/companies/${co}/journal`, {
    headers: { 'idempotency-key': randomUUID() },
    data: { date: '2026-01-02', description: 'นำเงินมาลงทุน', lines: [{ account_code: '1110', debit: '50000' }, { account_code: '3110', credit: '50000' }] },
  });
  expect(r.status(), await r.text()).toBe(201);

  // ฝากเงินสด 20,000 เข้ากระแสรายวัน ค่าธรรมเนียม 10
  await page.goto(`${home}/cash/transfers`);
  const tf = page.getByRole('form', { name: 'บันทึกการย้ายเงิน' });
  await tf.getByRole('combobox', { name: 'จากบัญชี' }).selectOption('1110');
  await tf.getByRole('combobox', { name: 'เข้าบัญชี' }).selectOption('1120');
  await expect(tf.getByRole('heading')).toHaveText('บันทึกการย้ายเงิน · ฝากเงิน');
  await tf.getByLabel('จำนวนเงิน').fill('20000');
  await tf.getByLabel('ค่าธรรมเนียม (ถ้ามี)').fill('10');
  await tf.getByRole('button', { name: 'บันทึก', exact: true }).click();
  await expect(tf.getByRole('status')).toHaveText('บันทึกแล้ว เลขที่ BT-0001');
  await expect(page.getByRole('region', { name: 'รายการย้ายเงิน' })).toContainText('ค่าธรรมเนียม 10.00 (5260)');
  await checkScreen(page, info, 'cash-transfers');

  // ตั้งวงเงิน 3,000
  await page.goto(`${home}/cash/petty-cash`);
  await page.getByRole('button', { name: 'ตั้งวงเงิน' }).click();
  const fund = page.getByRole('region', { name: 'ตั้ง/ปรับวงเงินสดย่อย' });
  await fund.getByLabel('วงเงินใหม่').fill('3000');
  await fund.getByLabel('ผู้รักษาเงินสดย่อย').fill('นางสาวขวัญใจ');
  await fund.getByRole('button', { name: 'ยืนยัน' }).click();
  await expect(fund.getByRole('status')).toHaveText('บันทึกแล้ว เลขที่ PC-0001');
  await fund.getByRole('button', { name: 'ยกเลิก', exact: true }).click();

  // จ่ายใบสำคัญ 2 ใบ
  const vf = page.getByRole('form', { name: 'จ่ายเงินสดย่อย' });
  for (const [payee, desc, amount, no] of [['นายสมชาย', 'ค่าแท็กซี่', '150', 'PCV-0001'], ['ร้านเครื่องเขียน', 'ปากกา', '85.50', 'PCV-0002']]) {
    await vf.getByLabel('จ่ายให้').fill(payee!);
    await vf.getByLabel('รายการ').fill(desc!);
    await vf.getByLabel('จำนวนเงิน').fill(amount!);
    await vf.getByRole('button', { name: 'บันทึกใบสำคัญจ่าย' }).click();
    await expect(vf.getByRole('status')).toHaveText(`บันทึกแล้ว เลขที่ ${no}`);
  }
  const summary = page.getByRole('region', { name: 'วงเงิน', exact: true });
  await expect(summary).toContainText('235.50');
  await expect(summary).toContainText('2,764.50');

  // เบิกชดเชยทั้ง 2 ใบจากกระแสรายวัน
  const rf = page.getByRole('form', { name: 'เบิกชดเชย' });
  await rf.getByRole('checkbox').nth(0).check();
  await rf.getByRole('checkbox').nth(1).check();
  await expect(rf.getByText('เลือก 2 ใบ รวม 235.50')).toBeVisible();
  await rf.getByRole('combobox', { name: 'จ่ายชดเชยจากบัญชี' }).selectOption('1120');
  await rf.getByRole('button', { name: 'บันทึกการเบิกชดเชย' }).click();
  await expect(rf.getByRole('status')).toHaveText('บันทึกแล้ว เลขที่ PC-0002');
  await expect(summary).toContainText('3,000.00');
  await expect(page.getByRole('region', { name: 'ใบสำคัญจ่ายเงินสดย่อย' }).getByText('เบิกแล้ว')).toHaveCount(2);
  await checkScreen(page, info, 'petty-cash');
  expect(errors).toEqual([]);
});
