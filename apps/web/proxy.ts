import { NextResponse, type NextRequest } from 'next/server';

// CSP แบบ nonce (OWASP A03/A05: docs/owasp-top10.md) — สร้าง nonce ใหม่ทุกคำขอหน้าเว็บ
// Next อ่าน nonce จาก header Content-Security-Policy ของคำขอแล้วใส่ให้สคริปต์/สไตล์ของตัวเองเอง
// สคริปต์ที่ไม่มี nonce (เช่นที่ถูกฉีดเข้ามา) ทำงานไม่ได้ · 'strict-dynamic' ให้สคริปต์ที่มี nonce โหลด chunk ต่อได้
// ทุกหน้าต้องเรนเดอร์ตอนมีคำขอ (app/layout.tsx เรียก connection()) หน้า static ไม่มี nonce
export function csp(nonce: string, dev = process.env.NODE_ENV !== 'production') {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`,
    // style: Safari ไม่ยอมใช้ stylesheet ที่ Next ใส่ตอนเปลี่ยนหน้าแม้มี nonce (พบใน e2e iPhone/iPad Safari)
    // จึงอนุญาต inline style ส่วนสคริปต์ยังต้องมี nonce — CSS ที่ถูกแทรกรันโค้ดไม่ได้ ความเสี่ยงต่ำกว่าสคริปต์มาก
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(18))).toString('base64');
  const value = csp(nonce);
  const headers = new Headers(request.headers);
  headers.set('content-security-policy', value);
  const res = NextResponse.next({ request: { headers } });
  res.headers.set('content-security-policy', value);
  return res;
}

export const config = {
  matcher: [{
    // หน้าเว็บเท่านั้น: ไม่รวม API ไฟล์ static ไอคอน service worker และไฟล์ส่งออก (PDF/Excel)
    source: '/((?!api/|_next/static|_next/image|export/|sw\\.js|manifest\\.webmanifest|icon|apple-icon|favicon).*)',
    missing: [
      { type: 'header', key: 'next-router-prefetch' },
      { type: 'header', key: 'purpose', value: 'prefetch' },
    ],
  }],
};
