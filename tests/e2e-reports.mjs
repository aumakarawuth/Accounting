// สคริปต์ตรวจบนเครื่อง: ครูเปิดบริษัททั้งห้อง → นักเรียนเลือกบริษัท ลงรายการ → งบทดลอง/แยกประเภท 3 ขนาดจอ
// node tests/e2e-reports.mjs <base> <อีเมลครู> <รหัสครู> <รหัสนักเรียน> <รหัสผ่านนักเรียน> <โฟลเดอร์ภาพ>
import { chromium } from 'playwright';
import { randomUUID } from 'node:crypto';
const [base, tEmail, tPw, sCode, sPw, out] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
const sizes = { phone: { width: 390, height: 844 }, ipad: { width: 1180, height: 820 }, pc: { width: 1440, height: 900 } };
const COMPANY = `บริษัท ข. การค้า ${randomUUID().slice(0, 4)} จำกัด`;

async function login(page, kind, id, pw) {
  await page.goto(`${base}${kind === 'staff' ? '/login/staff' : '/login'}`);
  await page.getByLabel(kind === 'staff' ? 'อีเมล' : 'รหัสนักเรียน').fill(id);
  await page.getByLabel('รหัสผ่าน', { exact: true }).fill(pw);
  await page.getByRole('button', { name: 'เข้าใช้งาน' }).click();
}

// 1) ครูเปิดบริษัทให้ทั้งห้อง
let ctx = await browser.newContext({ viewport: sizes.pc });
let page = await ctx.newPage();
await login(page, 'staff', tEmail, tPw);
await page.waitForURL('**/teacher');
const form = page.locator('form', { hasText: 'เปิดบริษัทจำลองให้ทั้งห้อง' }).first();
await form.getByRole('textbox').fill(COMPANY);
await form.getByRole('button', { name: 'เปิดบริษัท' }).click();
console.log(`teacher: ${await page.getByText(/เปิดบริษัทใหม่ \d+ คน/).textContent()}`);
await page.screenshot({ path: `${out}/teacher-open-pc.png` });
await ctx.close();

// 2) นักเรียน: เลือกบริษัท แล้วลงรายการผ่าน API (ใช้เซสชันเดียวกับเบราว์เซอร์)
ctx = await browser.newContext({ viewport: sizes.phone });
page = await ctx.newPage();
await login(page, 'student', sCode, sPw);
await page.getByRole('heading', { name: 'เลือกบริษัท' }).waitFor();
await page.screenshot({ path: `${out}/choose-phone.png` });
await page.getByRole('link', { name: new RegExp(COMPANY) }).click();
await page.waitForURL(/\/c\/[0-9a-f-]+$/);
const companyId = page.url().split('/c/')[1];
const post = async (date, description, lines) => {
  const r = await page.request.post(`${base}/api/companies/${companyId}/journal`, {
    headers: { origin: base, 'idempotency-key': randomUUID() }, data: { date, description, lines },
  });
  if (!r.ok()) throw new Error(await r.text());
  return r.json();
};
await post('2026-09-01', 'นำเงินสดมาลงทุน', [{ account_code: '1110', debit: '100000' }, { account_code: '3110', credit: '100000' }]);
await post('2026-10-05', 'รับเงินค่าบริการ', [{ account_code: '1110', debit: '12500' }, { account_code: '4120', credit: '12500' }]);
const wrong = await post('2026-10-08', 'จ่ายค่าไฟฟ้า (ลงผิดจำนวน)', [{ account_code: '5230', debit: '1250' }, { account_code: '1110', credit: '1250' }]);
const rv = await page.request.post(`${base}/api/companies/${companyId}/journal/${wrong.id}/reverse`, {
  headers: { origin: base, 'idempotency-key': randomUUID() }, data: { date: '2026-10-09' },
});
console.log(`reverse: ${rv.status()} ${(await rv.json()).docNo}`);
await post('2026-10-09', 'จ่ายค่าไฟฟ้า', [{ account_code: '5230', debit: '1520' }, { account_code: '1110', credit: '1520' }]);
await post('2026-10-12', 'จ่ายค่าเช่าสำนักงาน', [{ account_code: '5220', debit: '4800' }, { account_code: '1110', credit: '4800' }]);
await post('2026-10-15', 'ขายสินค้าเป็นเงินเชื่อ IV-0007', [{ account_code: '1210', debit: '13375' }, { account_code: '4110', credit: '12500' }, { account_code: '2210', credit: '875' }]);
const state = await ctx.storageState();
await ctx.close();

// 3) งบทดลองและแยกประเภท 3 ขนาดจอ
for (const [name, viewport] of Object.entries(sizes)) {
  ctx = await browser.newContext({ viewport, storageState: state });
  page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`${name} pageerror: ${e.message}`));
  await page.goto(`${base}/c/${companyId}/trial-balance?month=2026-10`);
  const status = await page.getByRole('status').textContent();
  console.log(`${name} trial balance: ${status}`);
  await page.screenshot({ path: `${out}/tb-${name}.png`, fullPage: true });
  await page.goto(`${base}/c/${companyId}/ledger?month=2026-10`);
  await page.screenshot({ path: `${out}/ledger-list-${name}.png`, fullPage: true });
  await page.getByRole('link', { name: /1110\s*เงินสด/ }).click();
  await page.getByRole('heading', { name: /บัญชีแยกประเภท · 1110/ }).waitFor();
  await page.screenshot({ path: `${out}/ledger-1110-${name}.png`, fullPage: true });
  await ctx.close();
}
await browser.close();
