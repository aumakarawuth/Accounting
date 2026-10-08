// สคริปต์ตรวจบนเครื่อง: ล็อกอินจริง → เปลี่ยนรหัสครั้งแรก → ลงรายการ → ครูรีเซ็ตรหัส แล้วถ่ายภาพ 3 ขนาดจอ
// node tests/e2e-smoke.mjs <base> <รหัสนักเรียน> <รหัสชั่วคราว> <อีเมลครู> <รหัสครู> <โฟลเดอร์ภาพ>
import { chromium } from 'playwright';
const [base, code, tempPw, teacherEmail, teacherPw, out] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
const sizes = { phone: { width: 390, height: 844 }, ipad: { width: 1180, height: 820 }, pc: { width: 1440, height: 900 } };
const log = [];
const newPw = 'ลงบัญชีทุกวัน';
let first = true;

async function login(page, kind, id, pw) {
  await page.goto(`${base}${kind === 'staff' ? '/login/staff' : '/login'}`);
  await page.getByLabel(kind === 'staff' ? 'อีเมล' : 'รหัสนักเรียน').fill(id);
  await page.getByLabel('รหัสผ่าน', { exact: true }).fill(pw);
  await page.getByRole('button', { name: 'เข้าใช้งาน' }).click();
}

for (const [name, viewport] of Object.entries(sizes)) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => log.push(`${name} pageerror: ${e.message}`));

  // ผิดหนึ่งครั้ง: ต้องบอกจำนวนครั้งที่เหลือ
  await login(page, 'student', code, 'ผิดแน่นอน');
  const err = page.getByText(/ไม่ถูกต้อง/);
  await err.waitFor();
  log.push(`${name} wrong: ${await err.textContent()}`);
  await page.screenshot({ path: `${out}/login-error-${name}.png` });

  if (first) {
    await login(page, 'student', code, tempPw);
    await page.waitForURL('**/change-password');
    await page.getByLabel('รหัสผ่านใหม่', { exact: true }).fill('qwerty123');
    await page.getByLabel('พิมพ์รหัสผ่านใหม่อีกครั้ง').fill('qwerty123');
    await page.getByRole('button', { name: 'ตั้งรหัสผ่าน' }).click();
    await page.getByText('อยู่ในรายการรหัสที่คนใช้บ่อยและเดาง่าย').waitFor();
    await page.screenshot({ path: `${out}/change-password-common-${name}.png` });
    await page.getByLabel('รหัสผ่านใหม่', { exact: true }).fill(newPw);
    await page.getByLabel('พิมพ์รหัสผ่านใหม่อีกครั้ง').fill(newPw);
    await page.getByRole('button', { name: 'ตั้งรหัสผ่าน' }).click();
    first = false;
  } else {
    await login(page, 'student', code, newPw);
  }
  await page.waitForURL(/\/c\/[0-9a-f-]+$/);
  log.push(`${name} student home: ${page.url().replace(base, '')}`);

  await page.goto(`${page.url()}/journal/new`);
  const codes = page.getByRole('combobox');
  await codes.nth(0).fill('111');
  await page.getByRole('option', { name: /1110/ }).click();
  await codes.nth(1).fill('4120');
  await page.getByRole('option', { name: /4120/ }).click();
  const money = page.locator('input[inputmode=decimal]');
  await money.nth(0).fill('500');
  await money.nth(3).fill('500');
  await page.getByRole('button', { name: /ผ่านรายการ/ }).click();
  await page.getByText(/ผ่านรายการเลขที่ JV-\d{4}/).waitFor();
  log.push(`${name} posted: ${await page.getByText(/ผ่านรายการเลขที่/).textContent()}`);
  await ctx.close();
}

// ครู: ล็อกอินด้วยอีเมล (ไม่มี 2FA) → รีเซ็ตรหัสนักเรียน (กดสองจังหวะ)
for (const [name, viewport] of Object.entries(sizes)) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  await login(page, 'staff', teacherEmail, teacherPw);
  await page.waitForURL('**/teacher');
  if (name === 'pc') {
    await page.getByRole('button', { name: 'รีเซ็ตรหัสผ่าน' }).first().click();
    await page.getByRole('button', { name: /ยืนยันรีเซ็ต/ }).click();
    await page.getByText(/รหัสชั่วคราว/).waitFor();
    log.push(`teacher reset: ${await page.getByText(/รหัสชั่วคราว/).textContent()}`);
  }
  await page.screenshot({ path: `${out}/teacher-${name}.png` });
  await ctx.close();
}
await browser.close();
console.log(log.join('\n'));
