import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../apps/api/src/app';
import { devAuth } from '../apps/api/src/auth';
import { authConfigFromEnv } from '../apps/api/src/config';
import { createPool } from '../apps/api/src/db';
import { createMetrics } from '../apps/api/src/metrics';
import { pgListenBus } from '../apps/api/src/realtime';
import { apiUrl, testUrl } from './global-setup';
import { pool as db, newSchool, newUser } from './helpers';

// ตัวชี้วัด Prometheus ของ API (infra/monitoring) ใช้แม่แบบ route ไม่มี id จริง เปิดที่พอร์ตแยกเท่านั้น
const apiPool = createPool(apiUrl());
const bus = pgListenBus(testUrl());
const metrics = createMetrics(apiPool);
const app = buildApp({ pool: apiPool, auth: devAuth(), bus, metrics, cfg: { ...authConfigFromEnv({}), allowedOrigins: false } });
afterAll(async () => { await app.close(); await bus.close(); await apiPool.end(); await db.end(); });
const text = () => metrics.registry.metrics();

describe('ตัวชี้วัด API', () => {
  it('นับคำขอด้วยแม่แบบ route + status ไม่มี id ใน label และไม่นับ /health', async () => {
    const u = await newUser(await newSchool(), 'student');
    const other = randomUUID();
    await app.inject({ method: 'GET', url: '/health' });
    await app.inject({ method: 'GET', url: '/me/companies', headers: { 'x-dev-user-id': u } });
    await app.inject({ method: 'GET', url: `/companies/${other}`, headers: { 'x-dev-user-id': u } });
    await app.inject({ method: 'GET', url: '/ไม่มีหน้านี้' });
    const t = await text();
    expect(t).toMatch(/http_requests_total\{method="GET",route="\/me\/companies",status="200"\} 1/);
    expect(t).toMatch(/http_requests_total\{method="GET",route="\/companies\/:companyId",status="404"\} 1/);
    expect(t).toMatch(/route="unmatched",status="404"/);
    expect(t).toContain('http_request_duration_seconds_bucket');
    expect(t).not.toContain(other);
    expect(t).not.toContain(u);
    expect(t).not.toContain('route="/health"');
    expect(t).toMatch(/pg_pool_connections\{state="total"\} \d+/);
    expect(t).toContain('process_resident_memory_bytes');
  });

  it('นับสตรีมดูสด SSE ที่เปิดอยู่ และลดเมื่อปิด', async () => {
    const u = await newUser(await newSchool(), 'student');
    const base = await app.listen({ port: 0, host: '127.0.0.1' });
    const ctrl = new AbortController();
    const res = await fetch(`${base}/realtime?channel=student:${u}`, { headers: { 'x-dev-user-id': u }, signal: ctrl.signal });
    expect(res.status).toBe(200);
    expect(await text()).toMatch(/realtime_connections\{transport="sse"\} 1/);
    ctrl.abort();
    for (let i = 0; i < 50 && !/realtime_connections\{transport="sse"\} 0/.test(await text()); i++) await new Promise((r) => setTimeout(r, 20));
    expect(await text()).toMatch(/realtime_connections\{transport="sse"\} 0/);
  });

  it('พอร์ต metrics ตอบเฉพาะ /metrics', async () => {
    const server = await metrics.listen(0, '127.0.0.1');
    const { port } = server.address() as { port: number };
    try {
      const ok = await fetch(`http://127.0.0.1:${port}/metrics`);
      expect(ok.status).toBe(200);
      expect(ok.headers.get('content-type')).toContain('text/plain');
      expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(404);
    } finally {
      server.close();
    }
  });
});
