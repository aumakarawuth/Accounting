// สคริปต์ตรวจบนเครื่อง: ครูเปิดงานโหมดส่งงาน → นักเรียนลงรายการและส่งตรวจ (ถูกล็อก) → ครูตรวจและส่งกลับ → นักเรียนเห็นคอมเมนต์
// node tests/e2e-submit.mjs <base> <อีเมลครู> <รหัสครู> <รหัสนักเรียน> <รหัสผ่านนักเรียน> <โฟลเดอร์ภาพ>
import { chromium } from 'playwright';
import { randomUUID } from 'node:crypto';
const [base, tEmail, tPw, sCode, sPw, out] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
const PC = { width: 1440, height: 900 }, PHONE = { width: 390, height: 844 };
const WORK = `โจทย์ 1 รับ-จ่ายเงินสด ${randomUUID().slice(0, 4)}`;

async function login(page, kind, id, pw) {
  await page.goto(`${base}${kind === 'staff' ? '/login/staff' : '/login'}`);
  await page.getByLabel(kind === 'staff' ? 'อีเมล' : 'รหัสนักเรียน').fill(id);
  await page.getByLabel('รหัสผ่าน', { exact: true }).fill(pw);
  await page.getByRole('button', { name: 'เข้าใช้งาน' }).click();
}

// 1) ครูเปิดงานโหมดส่งงาน
const tctx = await browser.newContext({ viewport: PC });
const tp = await tctx.newPage();
tp.on('pageerror', (e) => console.log(`teacher pageerror: ${e.message}`));
await login(tp, 'staff', tEmail, tPw);
await tp.waitForURL('**/teacher');
const form = tp.locator('form', { hasText: 'เปิดบริษัทจำลองให้ทั้งห้อง' }).first();
await form.getByRole('textbox').fill(WORK);
await form.getByRole('button', { name: 'เปิดบริษัท' }).click();
console.log(`teacher open: ${await tp.getByText(/เปิดบริษัทใหม่ \d+ คน/).textContent()}`);

// 2) นักเรียน (มือถือ): ลงรายการผ่านฟอร์ม แล้วส่งตรวจสองจังหวะ
const sctx = await browser.newContext({ viewport: PHONE });
const sp = await sctx.newPage();
sp.on('pageerror', (e) => console.log(`student pageerror: ${e.message}`));
await login(sp, 'student', sCode, sPw);
await sp.getByRole('link', { name: new RegExp(WORK) }).click();
await sp.waitForURL(/\/c\/[0-9a-f-]+$/);
const home = sp.url();
console.log(`student topbar: ${(await sp.locator('header').first().innerText()).replace(/\s+/g, ' ')}`);
await sp.goto(`${home}/journal/new`);
const codes = sp.getByRole('combobox');
await codes.nth(0).fill('1110');
await sp.getByRole('option', { name: /1110/ }).click();
await codes.nth(1).fill('4120');
await sp.getByRole('option', { name: /4120/ }).click();
const money = sp.locator('input[inputmode=decimal]');
await money.nth(0).fill('2500');
await money.nth(3).fill('2500');
await sp.getByRole('button', { name: /ผ่านรายการ/ }).click();
await sp.getByText(/ผ่านรายการเลขที่ JV-\d{4}/).waitFor();
await sp.goto(home);
await sp.getByRole('button', { name: 'ส่งตรวจ (หลังส่งแก้ไม่ได้)' }).click();
await sp.getByRole('button', { name: 'ยืนยันส่งตรวจ' }).click();
await sp.getByText('งานนี้ส่งตรวจแล้ว แก้ไขไม่ได้จนกว่าครูจะส่งกลับให้แก้').waitFor();
await sp.screenshot({ path: `${out}/student-submitted-phone.png`, fullPage: true });
await sp.goto(`${home}/journal/new`);
console.log(`journal locked: banner=${await sp.getByRole('status').first().textContent()} postDisabled=${await sp.getByRole('button', { name: /ผ่านรายการ/ }).isDisabled()}`);
await sp.screenshot({ path: `${out}/journal-locked-phone.png` });

// 3) ครู: งานที่ส่ง → ตรวจ → ส่งกลับให้แก้
await tp.goto(`${base}/teacher/submissions`);
await tp.screenshot({ path: `${out}/teacher-submissions-pc.png`, fullPage: true });
await tp.getByRole('row', { name: new RegExp(WORK) }).getByRole('link', { name: 'ตรวจงาน' }).click();
await tp.waitForURL('**/teacher/review/**');
await tp.getByRole('button', { name: 'เริ่มตรวจ' }).click();
await tp.getByText('ครูกำลังตรวจ', { exact: true }).waitFor();
await tp.getByLabel(/คอมเมนต์ถึงนักเรียน/).fill('รายได้ค่าบริการถูกแล้ว แต่ยังไม่ได้บันทึกค่าใช้จ่ายตามโจทย์ข้อ 2');
await tp.screenshot({ path: `${out}/teacher-review-pc.png`, fullPage: true });
await tp.getByRole('button', { name: 'ส่งกลับให้แก้' }).click();
await tp.getByText('ส่งกลับให้แก้', { exact: true }).first().waitFor();
console.log(`teacher history: ${(await tp.locator('details ol').innerText()).replace(/\s+/g, ' ')}`);

// 4) นักเรียนเห็นคอมเมนต์ปากกาแดง และแก้ได้อีกครั้ง
await sp.goto(home);
await sp.getByText(/ยังไม่ได้บันทึกค่าใช้จ่าย/).first().waitFor();
await sp.screenshot({ path: `${out}/student-returned-phone.png`, fullPage: true });
await sp.goto(`${home}/journal/new`);
console.log(`after return: banner=${await sp.getByText('งานนี้ส่งตรวจแล้ว').count()}`);

// 5) งบการเงินของนักเรียน (คอม)
const pctx = await browser.newContext({ viewport: PC, storageState: await sctx.storageState() });
const pp = await pctx.newPage();
await pp.goto(`${home}/statements?month=2026-10`);
console.log(`statements: ${await pp.getByRole('status').last().textContent()}`);
await pp.screenshot({ path: `${out}/statements-pc.png`, fullPage: true });
await browser.close();
