import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { withUser } from '../db.js';
import type { AuthAdapter, AuthUser } from '../auth.js';
import { requireReadable, requireUser } from '../guard.js';
import { specialJournal } from '../books.js';
import { cashFlow } from '../cashflow.js';
import { equityChanges } from '../equity.js';
import { BookQuery, StatementsQuery } from '../schemas.js';
import { HttpError } from '../errors.js';

// เฟส 6 (docs/phase6-spec.md): บัญชีตามหลักสูตร ปวช./ปวส. — ชั้นบาง Zod → SQL/ฟังก์ชันใน DB
export function curriculumRoutes(app: FastifyInstance, pool: pg.Pool, auth: AuthAdapter) {
  const user = (req: FastifyRequest): Promise<AuthUser> => requireUser(auth, req);
  const companyId = (req: FastifyRequest) => (req.params as { companyId: string }).companyId;

  // ข้อ 1 สมุดรายวันเฉพาะ
  app.get('/companies/:companyId/books', async (req) => {
    const id = companyId(req);
    const { month, book } = BookQuery.parse({ ...(req.query as object), companyId: id });
    return withUser(pool, await user(req), async (c) => {
      await requireReadable(c, id);
      return specialJournal(c, id, month, book);
    });
  });

  // ข้อ 2 งบกระแสเงินสด (ทางอ้อม + ทางตรง ในคำตอบเดียว)
  app.get('/companies/:companyId/cash-flow', async (req) => {
    const id = companyId(req);
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(400, 'invalid', 'รหัสบริษัทไม่ถูกต้อง');
    const { month, scope } = StatementsQuery.parse(req.query);
    return withUser(pool, await user(req), async (c) => {
      await requireReadable(c, id);
      return cashFlow(c, id, month, scope);
    });
  });

  // ข้อ 3 งบแสดงการเปลี่ยนแปลงส่วนของเจ้าของ
  app.get('/companies/:companyId/equity-changes', async (req) => {
    const id = companyId(req);
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(400, 'invalid', 'รหัสบริษัทไม่ถูกต้อง');
    const { month, scope } = StatementsQuery.parse(req.query);
    return withUser(pool, await user(req), async (c) => {
      await requireReadable(c, id);
      return equityChanges(c, id, month, scope);
    });
  });
}
