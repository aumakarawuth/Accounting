import { test, expect, type TestInfo } from '@playwright/test';
import { checkScreen, isPhone, studentHome, watchErrors } from './helpers';

// ร่างเอกสารขาย/ซื้อในเครื่อง: กรอกค้างไว้ → รีโหลด (เหมือนปิดแท็บ/แบตหมด) → กู้คืนครบพร้อมแถบแจ้ง → ทิ้งร่างได้
// และร่างที่ส่งให้ครูดูสดเป็นรายการบัญชีที่เอกสารจะสร้าง พร้อมชื่อเอกสาร

function taxId(first12: string) {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(first12[i]) * (13 - i);
  return first12 + ((11 - (sum % 11)) % 10);
}
const tag = (info: TestInfo) => info.project.name.toUpperCase().replace(/[^A-Z0-9]/g, '');

test('ร่างใบกำกับภาษีกู้คืนหลังรีโหลด ครูเห็นรายการบัญชีของร่าง ทิ้งร่างแล้วฟอร์มว่าง', async ({ page }, info) => {
  const errors = watchErrors(page);
  const home = await studentHome(page);
  const co = home.split('/')[2]!;
  const t = tag(info);
  const api = `/api/companies/${co}`;
  await page.context().setExtraHTTPHeaders({ origin: new URL(page.url()).origin });
  const profile = await (await page.request.get(`${api}/profile`)).json();
  if (!profile.taxId || !profile.vatRegistered) {
    expect((await page.request.patch(`${api}/profile`, { data: { version: profile.version, taxId: taxId('010555801234'), vatRegistered: true } })).ok()).toBe(true);
  }
  expect([201, 409]).toContain((await page.request.post(`${api}/parties`, { data: { code: `DR-${t}`, name: `ลูกค้าร่าง ${t}`, isCustomer: true, isVendor: false } })).status());

  await page.goto(`${home}/sales/new?kind=invoice`);
  await page.getByRole('textbox', { name: 'ลูกค้า', exact: true }).fill(`DR-${t}`);
  await page.getByRole('button', { name: new RegExp(`DR-${t}`) }).click();
  if (isPhone(info)) await page.getByRole('button', { name: 'ถัดไป: รายการ' }).click();
  await page.getByRole('combobox', { name: 'รายละเอียด 1' }).fill('ค่าจัดส่งพิเศษ');
  await page.getByLabel('ราคาต่อหน่วย').first().fill('1500');

  // ครูดูสด: ร่างที่ส่งออกไปเป็นรายการบัญชี (ลูกหนี้ / ขาย + ภาษีขาย) พร้อมชื่อเอกสาร
  await expect.poll(async () => (await (await page.request.get(`${api}/live`)).json()).presence?.draft?.title, { timeout: 10_000 })
    .toBe('ใบกำกับภาษี / ใบแจ้งหนี้ (ร่าง)');
  const live = (await (await page.request.get(`${api}/live`)).json()).presence;
  expect(live.draft.lines).toEqual([
    { account_code: '1210', debit: '1605.00', credit: '' },
    { account_code: '4110', debit: '', credit: '1500.00' },
    { account_code: '2210', debit: '', credit: '105.00' },
  ]);
  expect([live.draftDebit, live.draftCredit]).toEqual(['1605.00', '1605.00']);

  await page.waitForTimeout(300); // ให้ร่างลงเครื่องก่อน (หน่วง 150ms)
  await page.reload();
  await expect(page.getByText(/กู้ร่างที่ยังไม่ได้ผ่านรายการ/)).toBeVisible();
  if (isPhone(info)) await expect(page.getByText(`DR-${t}`)).toBeVisible();
  else await expect(page.getByText(`ลูกค้าร่าง ${t}`).first()).toBeVisible();
  if (isPhone(info)) await page.getByRole('button', { name: 'ถัดไป: รายการ' }).click();
  await expect(page.getByRole('combobox', { name: 'รายละเอียด 1' })).toHaveValue('ค่าจัดส่งพิเศษ');
  await expect(page.getByLabel('ราคาต่อหน่วย').first()).toHaveValue('1500');
  await checkScreen(page, info, 'doc-draft-restored');

  await page.getByRole('button', { name: 'ทิ้งร่างนี้' }).click();
  await expect(page.getByText(/กู้ร่างที่ยังไม่ได้ผ่านรายการ/)).toHaveCount(0);
  if (isPhone(info)) await page.getByRole('button', { name: 'ย้อนกลับ' }).click();
  await expect(page.getByRole('textbox', { name: 'ลูกค้า', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'ลูกค้า', exact: true })).toBeVisible();
  await expect(page.getByText(/กู้ร่างที่ยังไม่ได้ผ่านรายการ/)).toHaveCount(0);
  expect(errors).toEqual([]);
});
