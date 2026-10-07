import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { withUser } from '../db.js';
import type { AuthAdapter, AuthUser } from '../auth.js';
import { HttpError } from '../errors.js';
import { CompanyParams, EntryParams, IdempotencyKey, MonthQuery, PostJournal, Reverse } from '../schemas.js';

// ชั้นบาง: ตรวจรูปแบบด้วย Zod แล้วเรียกฟังก์ชันใน Postgres; สิทธิ์ตัดสินที่ RLS/ฟังก์ชัน
export function companyRoutes(app: FastifyInstance, pool: pg.Pool, auth: AuthAdapter) {
  async function user(req: FastifyRequest): Promise<AuthUser> {
    const u = await auth.authenticate(req);
    if (!u) throw new HttpError(401, 'unauthenticated', 'ต้องเข้าใช้งานก่อน');
    return u;
  }

  // กัน IDOR: บริษัทที่อ่านไม่ได้ตอบ 404 เหมือนไม่มีอยู่
  async function requireReadable(c: pg.PoolClient, companyId: string) {
    const r = await c.query('select app.can_read_company($1) ok', [companyId]);
    if (!r.rows[0]?.ok) throw new HttpError(404, 'not_found', 'ไม่พบบริษัทนี้');
  }

  async function docNo(c: pg.PoolClient, companyId: string, id: string) {
    const r = await c.query('select id, doc_no from acc.journal_entries where company_id = $1 and id = $2', [companyId, id]);
    return r.rows[0] as { id: string; doc_no: string };
  }

  function idemKey(req: FastifyRequest) {
    return IdempotencyKey.parse(req.headers['idempotency-key']);
  }

  app.get('/companies/:companyId', async (req) => {
    const { companyId } = CompanyParams.parse(req.params);
    return withUser(pool, await user(req), async (c) => {
      await requireReadable(c, companyId);
      const r = await c.query(
        `select id, name, version, app.can_write_company(id) as can_write from acc.companies where id = $1`,
        [companyId],
      );
      return r.rows[0];
    });
  });

  app.get('/companies/:companyId/accounts', async (req) => {
    const { companyId } = CompanyParams.parse(req.params);
    return withUser(pool, await user(req), async (c) => {
      await requireReadable(c, companyId);
      const r = await c.query(
        `select code, name, type, normal_side from acc.chart_of_accounts
          where company_id = $1 and active order by code`,
        [companyId],
      );
      return r.rows;
    });
  });

  app.get('/companies/:companyId/journal', async (req) => {
    const { companyId } = CompanyParams.parse(req.params);
    const { month } = MonthQuery.parse(req.query);
    return withUser(pool, await user(req), async (c) => {
      await requireReadable(c, companyId);
      const r = await c.query(
        `select e.id, e.doc_no, e.entry_date::text as date, e.description, e.total_amount::text as total,
                r.doc_no as reverses_doc_no
           from acc.journal_entries e
           left join acc.journal_entries r on r.company_id = e.company_id and r.id = e.reverses_entry_id
          where e.company_id = $1
            and ($2::text is null or to_char(e.entry_date, 'YYYY-MM') = $2)
          order by e.entry_date desc, e.doc_no desc
          limit 200`,
        [companyId, month ?? null],
      );
      return r.rows;
    });
  });

  app.get('/companies/:companyId/trial-balance', async (req) => {
    const { companyId } = CompanyParams.parse(req.params);
    return withUser(pool, await user(req), async (c) => {
      await requireReadable(c, companyId);
      const r = await c.query(
        `select code, name, type, debit_total::text as debit, credit_total::text as credit
           from acc.trial_balance($1)`,
        [companyId],
      );
      return r.rows;
    });
  });

  app.post('/companies/:companyId/journal', async (req, reply) => {
    const { companyId } = CompanyParams.parse(req.params);
    const body = PostJournal.parse(req.body);
    const key = idemKey(req);
    const out = await withUser(pool, await user(req), async (c) => {
      // เรียกฟังก์ชันลงบัญชีเป็นคำสั่งเดี่ยว (ห้ามวางใน WHERE: อาจถูกเรียกซ้ำต่อแถว)
      const posted = await c.query('select acc.post_journal($1, $2, $3, $4::jsonb, $5) as id', [
        companyId, body.date, body.description, JSON.stringify(body.lines), key,
      ]);
      return docNo(c, companyId, posted.rows[0].id);
    });
    return reply.code(201).send({ id: out.id, docNo: out.doc_no });
  });

  app.post('/companies/:companyId/journal/:entryId/reverse', async (req, reply) => {
    const { companyId, entryId } = EntryParams.parse(req.params);
    const body = Reverse.parse(req.body);
    const key = idemKey(req);
    const out = await withUser(pool, await user(req), async (c) => {
      const posted = await c.query('select acc.reverse_journal($1, $2, $3, $4, $5) as id', [
        companyId, entryId, body.date, key, body.description ?? null,
      ]);
      return docNo(c, companyId, posted.rows[0].id);
    });
    return reply.code(201).send({ id: out.id, docNo: out.doc_no });
  });
}
