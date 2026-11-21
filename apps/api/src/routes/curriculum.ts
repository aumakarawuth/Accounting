import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { withUser } from '../db.js';
import type { AuthAdapter, AuthUser } from '../auth.js';
import { requireReadable, requireUser } from '../guard.js';
import { specialJournal } from '../books.js';
import { BookQuery } from '../schemas.js';

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
}
