import { test, expect } from '@playwright/test';

// CSP แบบ nonce (apps/web/proxy.ts, docs/owasp-top10.md): สคริปต์ของ Next ทำงาน · สคริปต์ inline ที่ไม่มี nonce (เช่น onerror ใน HTML ที่ถูกแทรก) ถูกบล็อก
test('CSP: nonce ใหม่ทุกคำขอ สคริปต์ของหน้าใช้ nonce ตรงกัน HTML ที่ถูกแทรกรันสคริปต์ไม่ได้', async ({ page, request }) => {
  const nonceOf = (h: string) => /'nonce-([^']+)'/.exec(h)?.[1] ?? '';
  const [a, b] = [await request.get('/login'), await request.get('/login')];
  const csp = a.headers()['content-security-policy'] ?? '';
  const script = csp.split(';').find((d) => d.trim().startsWith('script-src')) ?? '';
  expect(script).toContain("'strict-dynamic'");
  expect(script).not.toContain("'unsafe-inline'");
  expect(nonceOf(csp).length).toBeGreaterThanOrEqual(16);
  expect(nonceOf(b.headers()['content-security-policy'] ?? '')).not.toBe(nonceOf(csp));
  // ทุก <script> ในหน้ามี nonce ของคำขอนั้น
  const html = await a.text();
  const tags = html.match(/<script\b[^>]*>/g) ?? [];
  expect(tags.length).toBeGreaterThan(0);
  for (const t of tags) expect(t).toContain(`nonce="${nonceOf(csp)}"`);

  const violations: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error' && /Content Security Policy|CSPV/.test(m.text())) violations.push(m.text()); });
  await page.addInitScript(() => document.addEventListener('securitypolicyviolation', (e) => console.error('CSPV', e.violatedDirective)));
  await page.goto('/login');
  await expect(page.getByRole('button', { name: 'เข้าใช้งาน' })).toBeVisible();
  expect(violations).toEqual([]); // หน้าปกติไม่ละเมิด CSP
  // จำลอง XSS แบบที่พบจริง: HTML ที่ถูกแทรกพร้อม event handler แบบ inline (CSP เดิมที่มี 'unsafe-inline' ปล่อยให้ทำงาน)
  const ran = await page.evaluate(async () => {
    const w = window as unknown as { injected?: boolean };
    const box = document.createElement('div');
    box.innerHTML = '<img src="/no-such.png" onerror="window.injected = true">';
    document.body.appendChild(box);
    await new Promise((r) => setTimeout(r, 300));
    return w.injected === true;
  });
  expect(ran).toBe(false);
  await expect.poll(() => violations.length).toBeGreaterThan(0);
});

// OWASP ZAP 10024: ฟอร์มที่มีรหัสผ่านต้องส่งแบบ POST แม้สคริปต์ยังไม่โหลด (ไม่อย่างนั้นรหัสผ่านไปอยู่ใน URL)
test('ฟอร์มรหัสผ่านส่งแบบ POST: กดส่งก่อนสคริปต์โหลด รหัสผ่านไม่ไปอยู่ใน URL', async ({ browser }, info) => {
  const ctx = await browser.newContext({ javaScriptEnabled: false, viewport: info.project.use.viewport });
  const page = await ctx.newPage();
  try {
    for (const path of ['/login', '/login/staff']) {
      await page.goto(path);
      const form = page.locator('form:has(input[type=password])');
      await expect(form).toHaveAttribute('method', 'post');
      await page.locator('input[type=password]').fill('ความลับ-ห้ามอยู่ใน-url');
      await page.locator('input[name=identifier]').fill('12345');
      await Promise.all([page.waitForLoadState('domcontentloaded'), page.locator('button[type=submit]').click()]);
      expect(decodeURIComponent(page.url())).not.toContain('ความลับ');
    }
  } finally {
    await ctx.close();
  }
});
