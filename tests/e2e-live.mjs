// สคริปต์ตรวจบนเครื่อง: ครูเปิดดูสด ↔ นักเรียนพิมพ์ร่าง (สองเบราว์เซอร์พร้อมกัน, SSE ผ่าน Next rewrite)
// node tests/e2e-live.mjs <base> <อีเมลครู> <รหัสครู> <รหัสนักเรียน> <รหัสผ่านนักเรียน> <ชื่อบริษัท> <โฟลเดอร์ภาพ>
import { chromium } from 'playwright';
const [base, tEmail, tPw, sCode, sPw, company, out] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

async function login(page, kind, id, pw) {
  await page.goto(`${base}${kind === 'staff' ? '/login/staff' : '/login'}`);
  await page.getByLabel(kind === 'staff' ? 'อีเมล' : 'รหัสนักเรียน').fill(id);
  await page.getByLabel('รหัสผ่าน', { exact: true }).fill(pw);
  await page.getByRole('button', { name: 'เข้าใช้งาน' }).click();
}

const tctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const tp = await tctx.newPage();
const sctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const sp = await sctx.newPage();
for (const [n, p] of [['teacher', tp], ['student', sp]]) p.on('pageerror', (e) => log(`${n} pageerror: ${e.message}`));

await login(sp, 'student', sCode, sPw);
await sp.getByRole('link', { name: new RegExp(`^${company.replace(/\./g, '\\.')}`) }).click();
await sp.waitForURL(/\/c\/[0-9a-f-]+$/);
await sp.goto(`${sp.url()}/journal/new`);
const codes = sp.getByRole('combobox');
await codes.nth(0).fill('1110');
await sp.getByRole('option', { name: /1110/ }).click();
await codes.nth(1).fill('4120');
await sp.getByRole('option', { name: /4120/ }).click();
const money = sp.locator('input[inputmode=decimal]');
await money.nth(0).fill('12500');
await money.nth(3).fill('12000');
log('student typed unbalanced draft');

await login(tp, 'staff', tEmail, tPw);
await tp.waitForURL('**/teacher');
await tp.goto(`${base}/teacher/live`);
await tp.getByText('ต่าง 500.00').waitFor({ timeout: 15_000 });
log(`teacher dashboard: ${(await tp.locator('section p').first().innerText())}`);
await tp.getByRole('button', { name: new RegExp(sCode) }).click();
await tp.getByText('เดบิต 12,500.00 ไม่เท่าเครดิต 12,000.00 ผลต่าง 500.00').waitFor();
log('teacher sees draft lines and difference');

await sp.getByText(/กำลังดูอยู่/).waitFor({ timeout: 10_000 });
log(`student banner: ${await sp.getByText(/กำลังดูอยู่/).textContent()}`);
await sp.screenshot({ path: `${out}/student-watched-phone.png` });

await money.nth(3).fill('12500');
await tp.getByText('ผลต่าง 0.00 · ดุล').waitFor({ timeout: 10_000 });
log('teacher sees draft become balanced (SSE)');
await tp.screenshot({ path: `${out}/teacher-live-pc.png` });

await sp.getByRole('button', { name: /ผ่านรายการ/ }).click();
const posted = (await sp.getByText(/ผ่านรายการเลขที่ JV-\d{4}/).textContent()).match(/JV-\d{4}/)[0];
await tp.getByText(posted).first().waitFor({ timeout: 10_000 });
log(`teacher sees posted ${posted} (SSE)`);

await tp.goto(`${base}/teacher`);
await sp.getByText(/กำลังดูอยู่/).waitFor({ state: 'detached', timeout: 10_000 });
log('student banner gone after teacher left');
await browser.close();
