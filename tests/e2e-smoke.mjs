// สคริปต์ตรวจบนเครื่อง: ลงรายการจริงผ่าน UI แล้วถ่ายภาพ 3 ขนาดจอ
import { chromium } from 'playwright';
const [base, company, out] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
const sizes = { phone: { width: 390, height: 844 }, ipad: { width: 1180, height: 820 }, pc: { width: 1440, height: 900 } };
const log = [];
for (const [name, viewport] of Object.entries(sizes)) {
  const page = await browser.newPage({ viewport });
  page.on('pageerror', (e) => log.push(`${name} pageerror: ${e.message}`));
  await page.goto(`${base}/c/${company}/journal/new`);
  const codes = page.getByRole('combobox');
  await codes.nth(0).fill('111');
  await page.getByRole('option', { name: /1110/ }).click();
  await codes.nth(1).fill('รายได้จากการบ');
  await page.getByRole('option', { name: /4120/ }).click();
  const money = page.locator('input[inputmode=decimal]');
  await money.nth(0).fill('12500');
  await money.nth(3).fill('12000');
  await page.screenshot({ path: `${out}/journal-unbalanced-${name}.png` });
  const disabled = await page.getByRole('button', { name: /ผ่านรายการ/ }).isDisabled();
  await money.nth(3).fill('12500');
  await page.getByRole('button', { name: /ผ่านรายการ/ }).click();
  await page.getByText(/ผ่านรายการเลขที่ JV-\d{4}/).waitFor();
  log.push(`${name}: disabled-when-unbalanced=${disabled} posted="${await page.getByText(/ผ่านรายการเลขที่/).textContent()}"`);
  await page.screenshot({ path: `${out}/journal-posted-${name}.png` });
  await page.goto(`${base}/c/${company}`);
  await page.screenshot({ path: `${out}/home-${name}.png` });
  await page.goto(`${base}/login`);
  await page.screenshot({ path: `${out}/login-${name}.png` });
  await page.close();
}
await browser.close();
console.log(log.join('\n'));
