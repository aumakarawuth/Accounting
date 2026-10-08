import { randomUUID } from 'node:crypto';
import { test, expect, type TestInfo } from '@playwright/test';
import { checkScreen, studentHome, watchErrors } from './helpers';

// เฟส 2.4 ภาษี: รายงานภาษีขาย/ซื้อของเดือน → ปิดภาษี (ภ.พ.30) → ลงเอกสารย้อนในเดือนที่ปิดไม่ได้ → บันทึกชำระ
// · ภ.ง.ด.53 จากหนังสือรับรอง → นำส่ง
// ปิดภาษีต้องเรียงเดือนและบริษัทเดียวกันทุกจอ แต่ละจอจึงใช้เดือนถัดจากเดือนล่าสุดที่ปิดไว้ (เริ่ม ม.ค. 2568) รันซ้ำบนฐานเดิมได้

function taxId(first12: string) {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(first12[i]) * (13 - i);
  return first12 + ((11 - (sum % 11)) % 10);
}
const tag = (info: TestInfo) => info.project.name.toUpperCase().replace(/[^A-Z0-9]/g, '');
const nextMonth = (m: string) => {
  const [y, mo] = m.split('-').map(Number) as [number, number];
  return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
};
const MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
const thaiMonth = (m: string) => `${MONTHS[Number(m.slice(5)) - 1]} ${Number(m.slice(0, 4)) + 543}`;

test('ภ.พ.30: รายงานภาษีขาย/ซื้อ → ปิดภาษี → ลงย้อนไม่ได้ → ชำระ · ภ.ง.ด.53 นำส่ง', async ({ page }, info) => {
  const errors = watchErrors(page);
  const home = await studentHome(page);
  const co = home.split('/')[2]!;
  const t = tag(info);
  const api = `/api/companies/${co}`;
  await page.context().setExtraHTTPHeaders({ origin: new URL(page.url()).origin });
  const idem = () => ({ 'idempotency-key': randomUUID() });

  const profile = await (await page.request.get(`${api}/profile`)).json();
  if (!profile.taxId || !profile.vatRegistered) {
    expect((await page.request.patch(`${api}/profile`, { data: { version: profile.version, taxId: taxId('010555801234'), vatRegistered: true, address: '99 ถนนสุขุมวิท กรุงเทพฯ' } })).ok()).toBe(true);
  }
  for (const r of [
    await page.request.post(`${api}/parties`, { data: { code: `TC-${t}`, name: `ลูกค้าภาษี ${t}`, isCustomer: true, isVendor: false } }),
    await page.request.post(`${api}/parties`, { data: { code: `TV-${t}`, name: `บริษัท ที่ปรึกษาภาษี ${t} จำกัด`, isCustomer: false, isVendor: true,
      vatRegistered: true, taxId: taxId('010555900099'), whtKind: 'service' } }),
    await page.request.post(`${api}/items`, { data: { code: `TG-${t}`, name: 'สินค้าทดสอบภาษี', unit: 'ชิ้น', isService: false, salePrice: '1000' } }),
    await page.request.post(`${api}/items`, { data: { code: `TS-${t}`, name: 'ค่าที่ปรึกษา', unit: 'งาน', isService: true, purchasePrice: '2000' } }),
  ]) expect([201, 409]).toContain(r.status());

  // เดือนถัดจากเดือนล่าสุดที่ปิดภาษีไว้
  const latest = ((await (await page.request.get(`${api}/tax/vat?month=2025-01`)).json()).history as { month: string; voidedAt: string | null }[])
    .filter((h) => !h.voidedAt).map((h) => h.month).sort().at(-1);
  const month = latest && latest >= '2025-01' ? nextMonth(latest) : '2025-01';
  const label = thaiMonth(month);

  expect((await page.request.post(`${api}/sales/invoice`, { headers: idem(), data: {
    date: `${month}-05`, partyCode: `TC-${t}`, lines: [{ itemCode: `TG-${t}`, qty: '10', unitPrice: '1000' }] } })).status()).toBe(201);
  expect((await page.request.post(`${api}/purchases/cash-purchase`, { headers: idem(), data: {
    date: `${month}-06`, partyCode: `TV-${t}`, vendorDocNo: `TAX-${randomUUID().slice(0, 6)}`, whtKind: 'service',
    lines: [{ itemCode: `TS-${t}`, qty: '1', unitPrice: '2000' }] } })).status()).toBe(201);

  // รายงาน + สรุปก่อนปิด
  await page.goto(`${home}/tax/vat?month=${month}`);
  await expect(page.getByRole('heading', { name: `ภาษีมูลค่าเพิ่ม ภ.พ.30 · ${label}` })).toBeVisible();
  const summary = page.getByRole('region', { name: 'สรุป ภ.พ.30' });
  await expect(summary).toContainText('ภาษีขายเดือนนี้700.00');
  await expect(summary).toContainText('ภาษีซื้อเดือนนี้140.00');
  await expect(summary).toContainText('ภาษีที่ต้องชำระ560.00');
  await expect(summary).toContainText('ยังไม่ได้ปิด');
  await expect(page.getByRole('region', { name: 'รายงานภาษีขาย' }).getByText(`ลูกค้าภาษี ${t}`).filter({ visible: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'รายงานภาษีซื้อ' }).getByText(`บริษัท ที่ปรึกษาภาษี ${t} จำกัด`).filter({ visible: true })).toBeVisible();
  await checkScreen(page, info, 'tax-vat');

  // ปิดภาษี
  await page.getByRole('button', { name: 'ปิดภาษีเดือนนี้' }).click();
  await page.getByRole('button', { name: 'ยืนยันปิดภาษี' }).click();
  await expect(summary).toContainText(/ปิดภาษีแล้ว รายการปิด VC-\d{4}/);

  // ลงเอกสารที่มีภาษีลงวันที่ในเดือนที่ปิดไม่ได้
  const late = await page.request.post(`${api}/sales/cash-sale`, { headers: idem(), data: {
    date: `${month}-20`, partyCode: `TC-${t}`, lines: [{ itemCode: `TG-${t}`, qty: '1', unitPrice: '100' }] } });
  expect(late.status()).toBe(409);
  expect((await late.json()).message).toContain('ปิดแล้ว');

  // ชำระภาษี (วันที่ตั้งต้น = วันนี้ ซึ่งหลังสิ้นเดือนภาษี)
  await page.getByRole('button', { name: 'บันทึกชำระภาษี' }).click();
  await page.getByRole('button', { name: 'ยืนยัน', exact: true }).click();
  await expect(summary).toContainText(/ชำระแล้ว .* รายการ TX-\d{4}/);
  await expect(page.getByRole('button', { name: 'ยกเลิกการปิดภาษี' })).toHaveCount(0);
  await checkScreen(page, info, 'tax-vat-closed');

  // ภ.ง.ด.53: หนังสือรับรองของเดือน → นำส่ง
  await page.goto(`${home}/tax/wht?month=${month}`);
  const pnd53 = page.getByRole('region', { name: 'ภ.ง.ด.53', exact: true });
  await expect(pnd53.getByText(`บริษัท ที่ปรึกษาภาษี ${t} จำกัด`).filter({ visible: true })).toBeVisible();
  await expect(pnd53).toContainText('60.00');
  await expect(page.getByRole('region', { name: 'ภ.ง.ด.3', exact: true })).toContainText('เดือนนี้ไม่มีการหักภาษีแบบนี้');
  await pnd53.getByRole('button', { name: 'นำส่ง ภ.ง.ด.53' }).click();
  await pnd53.getByRole('button', { name: 'ยืนยัน', exact: true }).click();
  await expect(pnd53).toContainText(/นำส่งแล้ว .* รายการ TX-\d{4} \(1 ใบ\)/);
  await checkScreen(page, info, 'tax-wht');
  expect(errors).toEqual([]);
});
