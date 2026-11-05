import { createServer, type Server } from 'node:http';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import client from 'prom-client';

/**
 * ตัวชี้วัดของ API แบบ Prometheus (self-host: infra/monitoring) ใช้เฉพาะ server.ts — Vercel ไม่ import ไฟล์นี้
 * เปิดที่พอร์ตแยก (METRICS_PORT) ในเครือข่ายภายใน Caddy ไม่ส่งต่อพอร์ตนี้ คนนอกจึงอ่านไม่ได้
 * ป้าย route ใช้แม่แบบของ route (/companies/:companyId/...) ไม่ใช่ URL จริง: ไม่มี id ของใครหลุดเข้า metrics และจำนวนชุดข้อมูลไม่บวม
 */
export type Metrics = ReturnType<typeof createMetrics>;

export function createMetrics(pool: pg.Pool) {
  const registry = new client.Registry();
  client.collectDefaultMetrics({ register: registry });

  const requests = new client.Counter({
    name: 'http_requests_total', help: 'คำขอ HTTP ที่ตอบแล้ว', labelNames: ['method', 'route', 'status'] as const, registers: [registry],
  });
  const duration = new client.Histogram({
    name: 'http_request_duration_seconds', help: 'เวลาตอบคำขอ HTTP', labelNames: ['method', 'route'] as const,
    buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5], registers: [registry],
  });
  const realtime = new client.Gauge({
    name: 'realtime_connections', help: 'การเชื่อมต่อดูสดที่เปิดอยู่', labelNames: ['transport'] as const, registers: [registry],
  });
  realtime.set({ transport: 'ws' }, 0);
  realtime.set({ transport: 'sse' }, 0);
  new client.Gauge({
    name: 'pg_pool_connections', help: 'การเชื่อมต่อใน pool ของ API (ผ่าน PgBouncer)', labelNames: ['state'] as const, registers: [registry],
    collect() {
      this.set({ state: 'total' }, pool.totalCount);
      this.set({ state: 'idle' }, pool.idleCount);
      this.set({ state: 'waiting' }, pool.waitingCount);
    },
  });

  return {
    registry,
    /** เปิด/ปิดสตรีมดูสด (+1/-1) */
    stream(transport: 'ws' | 'sse', delta: 1 | -1) { realtime.inc({ transport }, delta); },
    /** hook ของ Fastify: นับทุกคำขอ (ยกเว้น /health ที่ถูกเรียกทุก 10 วินาทีโดย healthcheck) */
    register(app: FastifyInstance) {
      app.addHook('onResponse', async (req, reply) => {
        const route = req.routeOptions.url ?? 'unmatched';
        if (route === '/health') return;
        const labels = { method: req.method, route };
        requests.inc({ ...labels, status: String(reply.statusCode) });
        duration.observe(labels, reply.elapsedTime / 1000);
      });
    },
    listen(port: number, host = '0.0.0.0'): Promise<Server> {
      const server = createServer((req, res) => {
        if (req.url !== '/metrics') { res.writeHead(404).end(); return; }
        registry.metrics().then(
          (body) => res.writeHead(200, { 'content-type': registry.contentType }).end(body),
          () => res.writeHead(500).end(),
        );
      });
      return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
    },
  };
}
