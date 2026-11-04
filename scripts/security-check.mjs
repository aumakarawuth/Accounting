#!/usr/bin/env node
// ทดสอบเจาะระบบเบื้องต้นกับเว็บที่ deploy แล้ว (docs/owasp-top10.md ข้อ "วิธีทดสอบซ้ำ")
// node scripts/security-check.mjs <base> <รหัสนักเรียน> <รหัสผ่าน> [id บริษัทของคนอื่น] [--with-lockout]
// - ใช้บัญชีทดสอบเท่านั้น ไม่เขียนข้อมูลบัญชีใด ๆ (มีแค่ล็อกอิน/ออกจากระบบ)
// - --with-lockout: ลองรหัสผิดด้วยรหัสนักเรียนสุ่มจนโดนล็อก/จำกัดอัตรา (IP ที่รันจะถูกจำกัดชั่วคราว)

const [base, code, password, otherCompany] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const withLockout = process.argv.includes('--with-lockout');
if (!base || !code || !password) {
  console.error('ใช้: node scripts/security-check.mjs <https://โดเมน> <รหัสนักเรียน> <รหัสผ่าน> [id บริษัทของคนอื่น] [--with-lockout]');
  process.exit(2);
}
const origin = new URL(base).origin;
const https = origin.startsWith('https:');
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: Boolean(ok), detail });

const get = (path, headers = {}) => fetch(`${origin}${path}`, { headers, redirect: 'manual' });
const post = (path, body, headers = {}) => fetch(`${origin}${path}`, {
  method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json', origin, ...headers }, body: JSON.stringify(body ?? {}),
});

// 1) header ความปลอดภัยของหน้าเว็บ (A05/A02)
const page = await get('/login');
const h = (n) => page.headers.get(n) ?? '';
const csp = h('content-security-policy');
check('CSP มี default-src self', csp.includes("default-src 'self'"), csp.slice(0, 80));
check("CSP frame-ancestors 'none'", csp.includes("frame-ancestors 'none'"));
check("CSP object-src 'none'", csp.includes("object-src 'none'"));
check('X-Frame-Options DENY', h('x-frame-options').toUpperCase() === 'DENY');
check('X-Content-Type-Options nosniff', h('x-content-type-options') === 'nosniff');
check('Referrer-Policy', h('referrer-policy') !== '');
check('ไม่มี X-Powered-By', !page.headers.has('x-powered-by'));
if (https) check('HSTS', /max-age=\d{6,}/.test(h('strict-transport-security')), h('strict-transport-security'));

// 2) API ไม่ให้ cache (A05) และต้องล็อกอิน (A01)
const health = await get('/api/health');
check('API Cache-Control no-store', health.headers.get('cache-control') === 'no-store', health.headers.get('cache-control') ?? '');
check('ไม่ล็อกอิน = 401', (await get('/api/me/companies')).status === 401);

// 3) CSRF (A01): origin ปลอม / Referer เสีย ถูกปฏิเสธก่อนถึงล็อกอิน
check('ล็อกอินจาก origin อื่น = 403', (await post('/api/auth/login', { kind: 'student', identifier: code, password }, { origin: 'https://evil.example' })).status === 403);
const badRef = await fetch(`${origin}/api/auth/logout`, { method: 'POST', headers: { referer: '::not a url' } });
check('Referer เสีย = 403 (ไม่ใช่ 500)', badRef.status === 403, String(badRef.status));

// 4) ล็อกอิน + cookie (A02/A07)
const login = await post('/api/auth/login', { kind: 'student', identifier: code, password });
const setCookie = login.headers.get('set-cookie') ?? '';
check('ล็อกอินบัญชีทดสอบได้', login.status === 200, String(login.status));
check('cookie HttpOnly', /httponly/i.test(setCookie));
check('cookie SameSite=Lax', /samesite=lax/i.test(setCookie));
if (https) check('cookie Secure + __Host-', /secure/i.test(setCookie) && setCookie.startsWith('__Host-'), setCookie.split(';')[0]?.split('=')[0]);
const cookie = setCookie.split(';')[0] ?? '';
const auth = { cookie };

if (login.status === 200) {
  const mine = await (await get('/api/me/companies', auth)).json();
  check('เห็นเฉพาะบริษัทของตัวเอง', Array.isArray(mine), `${mine.length} บริษัท`);
  check('นักเรียนเรียก API ของครูไม่ได้ = 403', (await get('/api/teacher/exercises', auth)).status === 403);
  check('นักเรียนส่งออกคะแนนไม่ได้', [403, 404].includes((await get(`/export/assignment/${crypto.randomUUID()}/scores.pdf`, auth)).status));
  // 5) IDOR (A01)
  const target = otherCompany ?? crypto.randomUUID();
  check('อ่านบริษัทของคนอื่น = 404', (await get(`/api/companies/${target}`, auth)).status === 404);
  check('ไฟล์รายงานของคนอื่น = 404', (await get(`/export/company/${target}/trial-balance.pdf?month=2026-10`, auth)).status === 404);
  check('เขียนสมุดรายวันบริษัทคนอื่นไม่ได้', [403, 404].includes((await post(`/api/companies/${target}/journal`,
    { date: '2026-10-01', description: 'x', lines: [{ account_code: '1110', debit: '1' }, { account_code: '3110', credit: '1' }] },
    { ...auth, 'idempotency-key': crypto.randomUUID() })).status));
  check('CSRF ด้วย cookie จริงแต่ origin อื่น = 403', (await post('/api/auth/logout', {}, { ...auth, origin: 'https://evil.example' })).status === 403);
  check('ออกจากระบบ', (await post('/api/auth/logout', {}, auth)).status === 200);
  check('cookie เดิมใช้ไม่ได้หลังออก', (await get('/api/me/companies', auth)).status === 401);
}

// 6) เดารหัส (A07)
if (withLockout) {
  const ident = `zz${Math.floor(Math.random() * 1e8)}`;
  let last = 0;
  for (let i = 0; i < 8; i++) last = (await post('/api/auth/login', { kind: 'student', identifier: ident, password: 'wrong-password' })).status;
  check('ผิดซ้ำแล้วถูกล็อก/จำกัดอัตรา (423/429)', [423, 429].includes(last), String(last));
}

const width = Math.max(...results.map((r) => r.name.length));
for (const r of results) console.log(`${r.ok ? 'ผ่าน   ' : 'ไม่ผ่าน'}  ${r.name.padEnd(width)}  ${r.detail}`);
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\nไม่ผ่าน ${failed} ข้อ จาก ${results.length}` : `\nผ่านทั้งหมด ${results.length} ข้อ`);
process.exit(failed ? 1 : 0);
