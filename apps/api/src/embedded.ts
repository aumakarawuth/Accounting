import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { sessionAuth } from './auth.js';
import { authConfigFromEnv } from './config.js';
import { createPool } from './db.js';
import { pgListenBus } from './realtime.js';

// ใช้ตอนรันบน Vercel (ช่วงพัฒนา, PLAN.md ข้อ 3): API ตัวเดียวกันฝังใน Next.js เป็น /api/* โดเมนเดียวกับเว็บ
// cookie/CSRF ทำงานเหมือนเดิม · เครื่องตัวเอง/self-host ยังรัน server.ts แยกเหมือนเดิม
// 1 instance ของ function = Fastify 1 ตัว + pool เล็ก (ผ่าน pooler แบบ transaction) + LISTEN 1 การเชื่อมต่อ (session pooler)
let app: Promise<FastifyInstance> | null = null;

function get(): Promise<FastifyInstance> {
  app ??= (async () => {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('ต้องตั้ง DATABASE_URL (บทบาท app_rw ผ่าน pooler)');
    const cfg = authConfigFromEnv();
    const pool = createPool(url, Number(process.env.PG_POOL_MAX ?? 3));
    const bus = pgListenBus(process.env.REALTIME_DATABASE_URL ?? url, (m) => console.error(m));
    // function บน Vercel (Hobby) ถูกตัดที่ 300 วินาที: ปิดสตรีมดูสดเองที่ 280 วินาทีแล้วให้เบราว์เซอร์ต่อใหม่
    const streamMaxMs = Number(process.env.REALTIME_MAX_SECONDS ?? 280) * 1000;
    const a = buildApp({ pool, auth: sessionAuth(pool, cfg.cookieName), cfg, bus, logger: false, trustProxy: true, streamMaxMs });
    await a.ready();
    return a;
  })();
  return app;
}

/** ส่งคำขอ /api/... ของ Next (Node req/res) เข้า Fastify; รอจนตอบเสร็จ (SSE = จนผู้ฟังตัดหรือ function หมดเวลา) */
export async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const a = await get();
  req.url = (req.url ?? '/').replace(/^\/api(?=\/|$)/, '') || '/';
  await new Promise<void>((resolve) => {
    res.on('close', resolve);
    res.on('finish', resolve);
    a.server.emit('request', req, res);
  });
}

/** Server Component เรียก API ในตัว (ไม่ออกเน็ตแล้ววนกลับเข้ามา) พร้อม cookie ของผู้ใช้ */
export async function inject(path: string, cookie: string): Promise<{ status: number; body: unknown }> {
  const a = await get();
  const r = await a.inject({ method: 'GET', url: path, headers: { cookie } });
  let body: unknown;
  try { body = r.json(); } catch { body = { code: 'server', message: 'server' }; }
  return { status: r.statusCode, body };
}
