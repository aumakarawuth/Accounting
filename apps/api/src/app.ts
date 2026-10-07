import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import type pg from 'pg';
import type { AuthAdapter } from './auth.js';
import type { AuthConfig } from './config.js';
import { HttpError, toHttp } from './errors.js';
import { memoryLimiter, type RateLimiter } from './ratelimit.js';
import { adminRoutes } from './routes/admin.js';
import { authRoutes } from './routes/auth.js';
import { companyRoutes } from './routes/companies.js';
import { liveRoutes } from './routes/live.js';
import { masterDataRoutes } from './routes/masterdata.js';
import type { RealtimeBus } from './realtime.js';
import { teacherRoutes } from './routes/teacher.js';

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

export function buildApp(opts: {
  pool: pg.Pool;
  auth: AuthAdapter;
  cfg: AuthConfig;
  limiter?: RateLimiter;
  bus?: RealtimeBus;
  logger?: boolean;
  trustProxy?: boolean | string;
  streamMaxMs?: number;
}) {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 256 * 1024, trustProxy: opts.trustProxy ?? 'loopback' });
  const limiter = opts.limiter ?? memoryLimiter();
  // จำกัดต่อผู้ใช้ทุกคำขอที่ล็อกอินแล้ว (PLAN.md ข้อ 5: ต่อ IP และต่อผู้ใช้)
  const auth: AuthAdapter = {
    async authenticate(req) {
      const u = await opts.auth.authenticate(req);
      if (u) {
        const wait = await limiter.hit(`user:${u.id}`, opts.cfg.requestsPerUserPerMinute, 60);
        if (wait) throw new HttpError(429, 'rate_limited', 'ส่งคำขอถี่เกินไป', { retryAfter: wait });
      }
      return u;
    },
  };
  app.register(cookie);

  // CSRF: คำขอที่เปลี่ยนข้อมูลต้องมาจาก origin ของเว็บเรา (เสริม cookie SameSite=Lax)
  app.addHook('onRequest', async (req) => {
    const wait = await limiter.hit(`ip:${req.ip}`, opts.cfg.requestsPerIpPerMinute, 60);
    if (wait) throw new HttpError(429, 'rate_limited', 'ส่งคำขอถี่เกินไป', { retryAfter: wait });
    if (SAFE.has(req.method) || opts.cfg.allowedOrigins === false) return;
    let origin = req.headers.origin;
    if (!origin && req.headers.referer) origin = new URL(req.headers.referer).origin;
    if (!origin || !opts.cfg.allowedOrigins.includes(origin)) {
      throw new HttpError(403, 'csrf', 'คำขอนี้ไม่ได้มาจากหน้าเว็บของระบบ');
    }
  });

  app.setErrorHandler((err, req, reply) => {
    const { status, body } = toHttp(err);
    if (status >= 500) req.log.error({ err, ref: body.ref }, 'unhandled');
    if (status === 429 && typeof body.retryAfter === 'number') reply.header('retry-after', String(body.retryAfter));
    reply.code(status).send(body);
  });

  app.get('/health', async () => {
    await opts.pool.query('select 1');
    return { ok: true };
  });

  app.register(async (scope) => {
    authRoutes(scope, { pool: opts.pool, auth, cfg: opts.cfg, limiter });
    companyRoutes(scope, opts.pool, auth);
    masterDataRoutes(scope, opts.pool, auth);
    teacherRoutes(scope, { pool: opts.pool, auth, limiter });
    adminRoutes(scope, { pool: opts.pool, auth });
    liveRoutes(scope, { pool: opts.pool, auth, bus: opts.bus, streamMaxMs: opts.streamMaxMs });
  });
  return app;
}
