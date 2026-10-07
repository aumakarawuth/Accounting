import Fastify from 'fastify';
import type pg from 'pg';
import type { AuthAdapter } from './auth.js';
import { toHttp } from './errors.js';
import { companyRoutes } from './routes/companies.js';

export function buildApp(opts: { pool: pg.Pool; auth: AuthAdapter; logger?: boolean }) {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 256 * 1024, trustProxy: true });

  app.setErrorHandler((err, req, reply) => {
    const { status, body } = toHttp(err);
    if (status >= 500) req.log.error({ err, ref: body.ref }, 'unhandled');
    reply.code(status).send(body);
  });

  app.get('/health', async () => {
    await opts.pool.query('select 1');
    return { ok: true };
  });

  companyRoutes(app, opts.pool, opts.auth);
  return app;
}
