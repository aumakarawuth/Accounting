import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildApp } from '../apps/api/src/app';
import { devAuth } from '../apps/api/src/auth';
import { authConfigFromEnv } from '../apps/api/src/config';
import { createPool } from '../apps/api/src/db';
import { apiUrl } from './global-setup';

// เฟส 4 ทดสอบเจาะระบบเบื้องต้น (docs/owasp-top10.md): สิ่งที่พบแล้วแก้ ต้องไม่กลับมาอีก
const apiPool = createPool(apiUrl());
const app = buildApp({ pool: apiPool, auth: devAuth(), cfg: { ...authConfigFromEnv({}), allowedOrigins: ['https://school.example'] } });
afterAll(async () => { await app.close(); await apiPool.end(); });

describe('API', () => {
  it('Referer ปลอม/เสีย = 403 (เดิม 500) · ไม่มีที่มา = 403 · origin ถูก = ผ่านด่าน CSRF', async () => {
    for (const referer of ['::not a url', 'http://[bad', '%%%']) {
      const r = await app.inject({ method: 'POST', url: '/auth/logout', headers: { referer } });
      expect(r.statusCode, referer).toBe(403);
      expect(r.json().code).toBe('csrf');
    }
    expect((await app.inject({ method: 'POST', url: '/auth/logout' })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/auth/logout', headers: { referer: 'https://school.example/c/x' } })).statusCode).toBe(200);
  });

  it('ทุกคำตอบห้าม cache และห้ามเดาชนิดไฟล์ (รวมคำตอบ error)', async () => {
    for (const url of ['/health', '/auth/me', '/companies/not-a-uuid']) {
      const r = await app.inject({ method: 'GET', url });
      expect(r.headers['cache-control'], url).toBe('no-store');
      expect(r.headers['x-content-type-options'], url).toBe('nosniff');
    }
  });
});

describe('เว็บ', () => {
  it('CSP จาก proxy.ts: nonce ไม่มี unsafe-inline/unsafe-eval ใน production และ next.config ยังตั้ง HSTS ทุกหน้า', async () => {
    const { csp } = await import('../apps/web/proxy');
    const prod = csp('abcdefghijklmnopqrstuvwx', false);
    for (const d of ["default-src 'self'", "frame-ancestors 'none'", "object-src 'none'", "base-uri 'self'", "form-action 'self'",
      "script-src 'self' 'nonce-abcdefghijklmnopqrstuvwx' 'strict-dynamic'"]) expect(prod).toContain(d);
    // สคริปต์ห้าม inline (style อนุญาต inline เพราะ Safari: proxy.ts)
    expect(prod.split(';').find((x) => x.trim().startsWith('script-src'))).not.toContain('unsafe-inline');
    expect(prod).not.toContain('unsafe-eval');
    expect(csp('n', true)).toContain("'unsafe-eval'"); // next dev เท่านั้น
    const cfg = readFileSync(new URL('../apps/web/next.config.ts', import.meta.url), 'utf8');
    expect(cfg).toContain("key: 'Strict-Transport-Security'");
  });
});
