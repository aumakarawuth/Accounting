import { randomUUID } from 'node:crypto';
import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { checkScreen, studentHome, watchErrors } from './helpers';

// เฟส 3.3–3.4: รับชำระเป็นเช็คลงวันที่ล่วงหน้า → นำฝาก → เช็คผ่าน · จ่ายเช็คเอง → เช็คคืน (กลับรายการ)
// · ลงทะเบียนสินทรัพย์ → ลงค่าเสื่อมเดือนแรก (AJ) → ขายพร้อมกำไร
// บริษัทเดียวกันทุกจอ แต่ละจอใช้เดือนของตัวเองในปี 2574 (2031) รหัส/เลขที่เช็คสุ่ม รันซ้ำบนฐานเดิมได้

function taxId(first12: string) {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(first12[i]) * (13 - i);
  return first12 + ((11 - (sum % 11)) % 10);
}
const tag = (info: TestInfo) => info.project.name.toUpperCase().replace(/[^A-Z0-9]/g, '');
const PROJECT_MONTH: Record<string, number> = { phone: 1, ipad: 3, pc: 5, 'iphone-safari': 7, 'ipad-safari': 9 };
const MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
const monthOf = (info: TestInfo) => PROJECT_MONTH[info.project.name] ?? 11;
const iso = (m: number, d: number) => `2031-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const thai = (m: number, d: number) => `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/2574`;

async function setup(page: Page, info: TestInfo) {
  const home = await studentHome(page);
  const co = home.split('/')[2]!;
  await page.context().setExtraHTTPHeaders({ origin: new URL(page.url()).origin });
  const api = `/api/companies/${co}`;
  // ใบกำกับภาษีต้องมีเลขผู้เสียภาษีของบริษัท (เหมือนเทสต์ขาย/ซื้อ)
  const profile = await (await page.request.get(`${api}/profile`)).json();
  if (!profile.taxId || !profile.vatRegistered) {
    expect((await page.request.patch(`${api}/profile`, { data: { version: profile.version, taxId: taxId('010555801234'), vatRegistered: true, address: '99 ถนนสุขุมวิท กรุงเทพฯ' } })).ok()).toBe(true);
  }
  return { home, api, t: tag(info) };
}

/** แถวของเช็ค/สินทรัพย์ที่มองเห็น (ตารางบนคอม/iPad หรือรายการบนมือถือ) */
const rowOf = (page: Page, text: string) => page.locator('tr, li').filter({ hasText: text }).filter({ visible: true }).first();

test('รับชำระเป็นเช็คลงวันที่ล่วงหน้า → นำฝาก → ผ่าน · จ่ายเช็ค → เช็คคืน', async ({ page }, info) => {
  const errors = watchErrors(page);
  const { home, api, t } = await setup(page, info);
  const m = monthOf(info);
  for (const r of [
    await page.request.post(`${api}/parties`, { data: { code: `QC-${t}`, name: `ลูกค้าเช็ค ${t}`, isCustomer: true, isVendor: false, creditDays: 30 } }),
    await page.request.post(`${api}/items`, { data: { code: `QG-${t}`, name: 'สินค้าทดสอบเช็ค', unit: 'ชิ้น', isService: false, salePrice: '1000' } }),
  ]) expect([201, 409]).toContain(r.status());
  const inv = await page.request.post(`${api}/sales/invoice`, { headers: { 'idempotency-key': randomUUID() }, data: {
    date: iso(m, 2), partyCode: `QC-${t}`, lines: [{ itemCode: `QG-${t}`, qty: '1', unitPrice: '1000' }] } });
  expect(inv.status()).toBe(201);
  const invId = (await inv.json()).id as string;
  // บริษัททดสอบอาจจด VAT แล้ว (เทสต์ภาษี) ยอดเช็คจึงอ่านจากใบจริง
  const invDoc = await (await page.request.get(`${api}/sales/documents/${invId}`)).json();
  const total = Number(invDoc.total).toLocaleString('en-US', { minimumFractionDigits: 2 });

  // รับชำระ: เลือก "รับเป็นเช็ค" เช็คลงวันที่ล่วงหน้า → ใบเสร็จลง 1221
  const no = String(Math.floor(Math.random() * 1e9));
  await page.goto(`${home}/sales/receipts/new?party=QC-${t}&doc=${invId}`);
  await expect(page.getByRole('checkbox', { name: /^รับครั้งนี้ IV-/ })).toBeChecked();
  await page.getByLabel('วันที่', { exact: true }).fill(thai(m, 10));
  await page.getByRole('checkbox', { name: 'รับเป็นเช็ค' }).check();
  await page.getByLabel('เลขที่เช็ค').fill(no);
  await page.getByLabel('ธนาคาร').fill('ธนาคารกรุงไทย');
  await page.getByLabel('วันที่หน้าเช็ค (วว/ดด/ปปปป)').fill(thai(m, 20));
  await expect(page.getByText('ลงบัญชี: เดบิต 1221 / เครดิต 1210')).toBeVisible();
  await checkScreen(page, info, 'receipt-by-cheque');
  await page.getByRole('button', { name: /^ผ่านรายการ/ }).click();
  await page.waitForURL(/\/sales\/documents\/[0-9a-f-]{36}$/);

  // ทะเบียนเช็ครับ: รอนำฝาก → นำฝาก → รอเรียกเก็บ → เช็คผ่าน
  await page.goto(`${home}/cheques`);
  await expect(page.getByRole('heading', { name: /^ทะเบียนเช็ค/ })).toBeVisible();
  let row = rowOf(page, no);
  await expect(row).toContainText('รอนำฝาก');
  await expect(row).toContainText('ลงวันที่ล่วงหน้า');
  await expect(row).toContainText(total);
  await checkScreen(page, info, 'cheques-received');
  await row.getByRole('button', { name: 'นำฝาก' }).click();
  const deposit = page.getByRole('region', { name: `นำฝาก เลขที่ ${no}` });
  await expect(deposit.getByLabel('วันที่ (วว/ดด/ปปปป)')).toHaveValue(thai(m, 20));
  await deposit.getByLabel('นำฝากเข้าบัญชี').selectOption('1120');
  await deposit.getByRole('button', { name: 'ยืนยัน' }).click();
  row = rowOf(page, no);
  await expect(row).toContainText('รอเรียกเก็บ');
  await expect(row).toContainText('นำฝากเข้า 1120');
  await row.getByRole('button', { name: 'เช็คผ่าน' }).click();
  await page.getByRole('region', { name: `เช็คผ่าน เลขที่ ${no}` }).getByRole('button', { name: 'ยืนยัน' }).click();
  row = rowOf(page, no);
  await expect(row).toContainText('ผ่านแล้ว');
  await expect(row.getByRole('link', { name: /^CQ-\d{4}$/ })).toBeVisible();

  // เช็คจ่าย: ลงทะเบียนเอง (ค่าเช่า) → เช็คคืน = กลับรายการ
  await page.goto(`${home}/cheques?dir=paid`);
  await page.getByRole('button', { name: 'จ่ายเช็ค' }).click();
  const form = page.getByRole('region', { name: 'จ่ายเช็ค (ลงทะเบียนเช็คจ่าย)' });
  const pno = `P${no.slice(0, 8)}`;
  await form.getByLabel('เลขที่เช็ค').fill(pno);
  await form.getByLabel('ธนาคาร', { exact: true }).fill('ธนาคารกสิกรไทย');
  await form.getByLabel('วันที่หน้าเช็ค (วว/ดด/ปปปป)').fill(thai(m, 25));
  await form.getByLabel('วันที่จ่ายเช็ค (วว/ดด/ปปปป)').fill(thai(m, 25));
  await form.getByLabel('จำนวนเงิน').fill('4500');
  await form.getByLabel('ผู้รับเงิน').fill(`เจ้าของตึก ${t}`);
  await form.getByLabel('เดบิตบัญชี').selectOption('5220');
  await form.getByLabel('สั่งจ่ายจากบัญชี').selectOption('1120');
  await expect(form.getByText('ลงบัญชี: เดบิต 5220 / เครดิต 2120')).toBeVisible();
  await checkScreen(page, info, 'cheques-paid-new');
  await form.getByRole('button', { name: 'ลงทะเบียนเช็ค' }).click();
  await expect(form.getByRole('status')).toContainText(new RegExp(`ลงทะเบียนเช็คเลขที่ ${pno} รายการ CQ-\\d{4}`));
  await form.getByRole('button', { name: 'ยกเลิก' }).click();
  row = rowOf(page, pno);
  await expect(row).toContainText('รอเรียกเก็บ');
  await row.getByRole('button', { name: 'เช็คคืน' }).click();
  await page.getByRole('region', { name: `เช็คคืน เลขที่ ${pno}` }).getByRole('button', { name: 'ยืนยัน' }).click();
  row = rowOf(page, pno);
  await expect(row).toContainText('เช็คคืน');
  await expect(row.getByRole('link', { name: /^RV-\d{4}$/ })).toBeVisible();
  await checkScreen(page, info, 'cheques-paid');
  expect(errors).toEqual([]);
});

test('ทะเบียนทรัพย์สิน: ลงทะเบียน → ค่าเสื่อมเดือนแรก (AJ) → ขายมีกำไร', async ({ page }, info) => {
  const errors = watchErrors(page);
  const { home, t } = await setup(page, info);
  const m = monthOf(info);
  const code = `FA${t.slice(0, 4)}-${randomUUID().slice(0, 4).toUpperCase()}`;
  const month = `2031-${String(m).padStart(2, '0')}`;

  await page.goto(`${home}/fixed-assets?month=${month}`);
  await expect(page.getByRole('heading', { name: new RegExp(`ทะเบียนทรัพย์สิน .* ณ สิ้นเดือน ${MONTHS[m - 1]} 2574`) })).toBeVisible();
  await page.getByRole('button', { name: 'ลงทะเบียนสินทรัพย์' }).click();
  const form = page.getByRole('region', { name: 'ลงทะเบียนสินทรัพย์ถาวร' });
  await form.getByLabel('รหัสสินทรัพย์').fill(code);
  await form.getByLabel('ชื่อสินทรัพย์').fill(`เครื่องพิมพ์ ${t}`);
  await form.getByLabel('วันที่ได้มา (วว/ดด/ปปปป)').fill(thai(m, 3));
  await form.getByLabel('ราคาทุน').fill('12500');
  await form.getByLabel('ราคาซาก').fill('500');
  await form.getByLabel('อายุใช้งาน (ปี)').fill('1');
  await form.getByLabel('บันทึกการได้มา').selectOption('1110');
  await expect(form.getByText('ค่าเสื่อมต่อเดือน 1,000.00 · เดือนสุดท้าย 1,000.00')).toBeVisible();
  await checkScreen(page, info, 'fixed-asset-new');
  await form.getByRole('button', { name: 'บันทึกทะเบียน' }).click();
  let row = rowOf(page, code);
  await expect(row).toContainText('12,500.00');
  await expect(row).toContainText('ลงแล้ว 0/12 เดือน');

  // ค่าเสื่อมเดือนนี้: AJ วันสิ้นเดือน
  await page.getByRole('button', { name: `ลงค่าเสื่อมราคาเดือน ${MONTHS[m - 1]} 2574` }).click();
  const dep = page.getByRole('region', { name: `ลงค่าเสื่อมราคาเดือน ${MONTHS[m - 1]} 2574` });
  await dep.getByRole('button', { name: 'ยืนยัน' }).click();
  await expect(dep.getByRole('status')).toContainText(/ลงค่าเสื่อมราคาแล้ว รายการ AJ-\d{4}/);
  row = rowOf(page, code);
  await expect(row).toContainText('ลงแล้ว 1/12 เดือน');
  await expect(row).toContainText('11,500.00');
  await expect(page.getByRole('region', { name: 'รายการค่าเสื่อมราคา' }).getByRole('link', { name: /^AJ-\d{4}$/ }).first()).toBeVisible();
  await checkScreen(page, info, 'fixed-assets');

  // ขายต้นเดือนถัดไป 12,000 → มูลค่าตามบัญชี 11,500 กำไร 500
  await row.getByRole('button', { name: 'จำหน่าย / ขาย' }).click();
  const sell = page.getByRole('region', { name: `จำหน่ายสินทรัพย์ ${code}` });
  await sell.getByLabel('ราคาขาย (ไม่มี = ตัดจำหน่าย)').fill('12000');
  await expect(sell.getByText('มูลค่าตามบัญชี 11,500.00 · กำไร(ขาดทุน) 500.00')).toBeVisible();
  await sell.getByRole('button', { name: 'ยืนยัน' }).click();
  await expect(sell).toBeHidden();
  const next = m === 12 ? '2032-01' : `2031-${String(m + 1).padStart(2, '0')}`;
  // หลังยืนยัน หน้าอาจรีเฟรชเดือนเดิมอยู่ (Safari) รอให้นิ่งก่อนเปลี่ยนเดือน
  await page.waitForLoadState('networkidle');
  await expect(async () => {
    await page.goto(`${home}/fixed-assets?month=${next}`);
    await expect(page).toHaveURL(new RegExp(`month=${next}$`));
  }).toPass();
  row = rowOf(page, code);
  await expect(row).toContainText('จำหน่ายแล้ว');
  await expect(row).toContainText('กำไร(ขาดทุน) 500.00');
  await expect(row.getByRole('link', { name: 'ดูรายการ FD' })).toBeVisible();
  await checkScreen(page, info, 'fixed-assets-disposed');
  expect(errors).toEqual([]);
});
