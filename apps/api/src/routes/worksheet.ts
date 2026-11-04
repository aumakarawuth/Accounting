import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { withUser } from '../db.js';
import type { AuthAdapter, AuthUser } from '../auth.js';
import { requireReadable, requireUser } from '../guard.js';
import { worksheet } from '../reports.js';
import { CompanyParams, WorksheetQuery } from '../schemas.js';

// กระดาษทำการ ณ สิ้นเดือน (ยอดสะสมเหมือนงบทดลอง) แบบ 6 / 8 / 10 ช่องตามที่โรงเรียนเปิดใช้ (คำนวณใน reports.ts)
export function worksheetRoutes(app: FastifyInstance, pool: pg.Pool, auth: AuthAdapter) {
  const user = (req: FastifyRequest): Promise<AuthUser> => requireUser(auth, req);

  app.get('/companies/:companyId/worksheet', async (req) => {
    const { companyId } = CompanyParams.parse(req.params);
    const q = WorksheetQuery.parse(req.query);
    return withUser(pool, await user(req), async (c) => {
      await requireReadable(c, companyId);
      return worksheet(c, companyId, q.month, q.format);
    });
  });
}
