// สคริปต์ตรวจบนเครื่อง: ผู้ดูแล → สร้างครู/ห้อง → ครูนำเข้า CSV → พิมพ์ใบรหัสผ่าน → นักเรียนเข้าใช้
// node tests/e2e-admin.mjs <base> <อีเมลผู้ดูแล> <รหัสชั่วคราวผู้ดูแล> <โฟลเดอร์ csv> <โฟลเดอร์ภาพ>
import { chromium } from 'playwright';
const [base, adminEmail, adminTemp, csvDir, out] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
const log = [];
const PC = { width: 1440, height: 900 }, PHONE = { width: 390, height: 844 };
const pw = (t) => t.match(/[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}/)[0];

async function login(page, kind, id, password) {
  await page.goto(`${base}${kind === 'staff' ? '/login/staff' : '/login'}`);
  await page.getByLabel(kind === 'staff' ? 'อีเมล' : 'รหัสนักเรียน').fill(id);
  await page.getByLabel('รหัสผ่าน', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'เข้าใช้งาน' }).click();
}
async function firstChange(page, newPw) {
  await page.waitForURL('**/change-password');
  await page.getByLabel('รหัสผ่านใหม่', { exact: true }).fill(newPw);
  await page.getByLabel('พิมพ์รหัสผ่านใหม่อีกครั้ง').fill(newPw);
  await page.getByRole('button', { name: 'ตั้งรหัสผ่าน' }).click();
}

// 1) ผู้ดูแล
let ctx = await browser.newContext({ viewport: PC });
let page = await ctx.newPage();
page.on('pageerror', (e) => console.log(`pageerror: ${e.message}`));
await login(page, 'staff', adminEmail, adminTemp);
await firstChange(page, 'ผู้ดูแลระบบโรงเรียน');
await page.waitForURL('**/admin');
await page.getByLabel('อีเมล').fill('wichai@example.test');
await page.getByLabel('ชื่อ', { exact: true }).fill('ครูวิชัย');
await page.getByRole('button', { name: 'เพิ่มบัญชี' }).click();
const created = await page.getByText(/สร้างบัญชี ครูวิชัย แล้ว/).textContent();
const teacherTemp = pw(created);
console.log(`admin created teacher: ${created}`);
await page.getByLabel('ชื่อห้อง').fill('ม.4/1 บัญชี');
await page.locator('form').nth(1).locator('select').selectOption({ label: 'ครูวิชัย' });
await page.getByRole('button', { name: 'เพิ่มห้อง' }).click();
await page.getByRole('cell', { name: 'ม.4/1 บัญชี' }).waitFor();
await page.screenshot({ path: `${out}/admin-pc.png`, fullPage: true });
await ctx.close();

// 2) ครูนำเข้า CSV (มือถือ): ไฟล์ผิดก่อน แล้วไฟล์ถูก
ctx = await browser.newContext({ viewport: PHONE });
page = await ctx.newPage();
await login(page, 'staff', 'wichai@example.test', teacherTemp);
await firstChange(page, 'ครูวิชัยสอนบัญชี');
await page.waitForURL('**/teacher');
await page.getByRole('button', { name: 'นำเข้ารายชื่อ (CSV)' }).click();
await page.locator('input[type=file]').setInputFiles(`${csvDir}/room41-bad.csv`);
await page.getByText(/มีปัญหา 3 แถว/).waitFor();
console.log(`bad file: ${await page.getByText(/พร้อมนำเข้า/).first().textContent()} | button disabled=${await page.getByRole('button', { name: /^นำเข้า \d+ คน/ }).isDisabled()}`);
await page.screenshot({ path: `${out}/import-bad-phone.png`, fullPage: true });
await page.locator('input[type=file]').setInputFiles(`${csvDir}/room41.csv`);
await page.getByRole('button', { name: 'นำเข้า 4 คน' }).click();
const done = await page.getByText(/สร้างบัญชีใหม่ \d+ คน ·/).textContent();
console.log(`import: ${done}`);
await page.getByRole('heading', { name: 'ใบรหัสผ่าน 4 ใบ' }).waitFor();
const slipText = await page.locator('article').nth(2).innerText(); // คนที่ 3: ขั้นถัดไปรีเซ็ตแค่ 2 คนแรก
const studentTemp = pw(slipText);
await page.screenshot({ path: `${out}/import-done-phone.png`, fullPage: true });
await ctx.close();

// 3) ใบรหัสผ่านตอนพิมพ์ (A4)
ctx = await browser.newContext({ viewport: PC });
page = await ctx.newPage();
await login(page, 'staff', 'wichai@example.test', 'ครูวิชัยสอนบัญชี');
await page.waitForURL('**/teacher');
const rooms = await page.locator('section h2').allInnerTexts();
console.log(`teacher rooms: ${rooms.join(' | ')}`);
const first = page.getByRole('button', { name: 'รีเซ็ตรหัสผ่าน' });
for (let i = 0; i < 2; i++) {
  await first.nth(i).click();
  await page.getByRole('button', { name: /ยืนยันรีเซ็ต/ }).click();
  await page.getByText(/^รหัสชั่วคราว .* แสดงครั้งเดียว/).nth(i).waitFor(); // รอแถวนี้เสร็จก่อนนับปุ่มใหม่
}
await page.getByRole('heading', { name: 'ใบรหัสผ่าน 2 ใบ' }).waitFor();
await page.emulateMedia({ media: 'print' });
await page.screenshot({ path: `${out}/slips-print.png`, fullPage: true });
await page.pdf({ path: `${out}/slips.pdf`, format: 'A4', printBackground: true });
await ctx.close();

// 4) นักเรียนจากใบรหัส (คนที่ 3 ไม่ถูกรีเซ็ต) เข้าใช้
ctx = await browser.newContext({ viewport: PHONE });
page = await ctx.newPage();
const slipCode = slipText.match(/66\d{3}/)[0];
console.log(`slip student ${slipCode}`);
console.log(`slip text: ${slipText.replace(/\s+/g, ' ')} → temp ${studentTemp}`);
await login(page, 'student', slipCode, studentTemp);
await Promise.race([page.waitForURL('**/change-password'), page.getByText(/ไม่ถูกต้อง|ล็อก/).waitFor()]);
console.log(`page says: ${(await page.locator('form').innerText()).replace(/\s+/g, ' ').slice(0, 200)}`);
console.log(`student after login: ${page.url().replace(base, '')}`);
await ctx.close();

// 5) audit log
ctx = await browser.newContext({ viewport: PC });
page = await ctx.newPage();
await login(page, 'staff', adminEmail, 'ผู้ดูแลระบบโรงเรียน');
await page.waitForURL('**/admin');
await page.goto(`${base}/admin/audit`);
console.log(`audit first rows: ${(await page.locator('tbody tr').allInnerTexts()).slice(0, 4).map((t) => t.replace(/\s+/g, ' ')).join(' || ')}`);
await page.screenshot({ path: `${out}/audit-pc.png` });
await browser.close();
console.log(log.join('\n'));
