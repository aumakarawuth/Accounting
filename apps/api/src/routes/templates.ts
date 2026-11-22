import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { querySequence, withUser } from '../db.js';
import type { AuthAdapter, AuthUser } from '../auth.js';
import { requireReadable, requireUser, requireWritable } from '../guard.js';
import { CompanyParams, IdempotencyKey, MonthQuery, TemplateInput, TemplateParams, TemplatePost } from '../schemas.js';

// เฟส 7 โมดูล 5 (docs/phase7-spec.md ข้อ 5): แม่แบบรายการ / รายการประจำเดือน — นักเรียนกดยืนยันลงเอง ไม่ลงอัตโนมัติ
export function templateRoutes(app: FastifyInstance, pool: pg.Pool, auth: AuthAdapter) {
  const user = (req: FastifyRequest): Promise<AuthUser> => requireUser(auth, req);
  const idemKey = (req: FastifyRequest) => IdempotencyKey.parse(req.headers['idempotency-key']);
  const thisMonth = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 7);
  const sqlInput = (b: ReturnType<typeof TemplateInput.parse>) => ({
    name: b.name, description: b.description, lines: b.lines, from_entry: b.fromEntry, recurring: b.recurring,
    day_of_month: b.dayOfMonth, start_month: b.startMonth ? `${b.startMonth}-01` : undefined, active: b.active,
  });

  app.get('/companies/:companyId/templates', async (req) => {
    const { companyId: id } = CompanyParams.parse(req.params);
    const month = MonthQuery.parse(req.query).month ?? thisMonth();
    return withUser(pool, await user(req), async (c) => {
      await requireReadable(c, id);
      const [co, templates, due, accounts] = await querySequence([
        () => c.query(`select app.can_write_company(id) as "canWrite", app.company_locked(id) as locked from acc.companies where id = $1`, [id]),
        () => c.query(
          `select t.id, t.name, t.description, t.lines, t.recurring, t.day_of_month as "dayOfMonth", to_char(t.start_month, 'YYYY-MM') as "startMonth",
                  t.active, t.version,
                  (select j.doc_no from acc.journal_entries j where j.company_id = t.company_id and j.id = acc.template_posted(t.company_id, t.id, $2::date)) as "postedThisMonth",
                  (select count(*)::int from acc.template_postings p where p.company_id = t.company_id and p.template_id = t.id) as uses
             from acc.journal_templates t where t.company_id = $1 order by t.active desc, t.name`, [id, `${month}-01`]),
        () => c.query(`select template_id as id, name, due_date::text as "dueDate" from acc.templates_due($1, $2::date)`, [id, `${month}-01`]),
        () => c.query(`select code, name from acc.chart_of_accounts where company_id = $1 order by code`, [id]),
      ] as const);
      return { month, ...co.rows[0], templates: templates.rows, due: due.rows, accounts: accounts.rows };
    });
  });
  app.post('/companies/:companyId/templates', async (req, reply) => {
    const { companyId: id } = CompanyParams.parse(req.params);
    const b = TemplateInput.parse(req.body);
    const row = await withUser(pool, await user(req), async (c) => {
      await requireWritable(c, id);
      const x = (await c.query('select acc.save_journal_template($1, null, $2::jsonb, null) id', [id, JSON.stringify(sqlInput(b))])).rows[0].id;
      return (await c.query(`select id, name, version from acc.journal_templates where company_id = $1 and id = $2`, [id, x])).rows[0];
    });
    return reply.code(201).send(row);
  });
  app.put('/companies/:companyId/templates/:id', async (req) => {
    const { companyId: co, id } = TemplateParams.parse(req.params);
    const b = TemplateInput.parse(req.body);
    return withUser(pool, await user(req), async (c) => {
      await requireWritable(c, co);
      await c.query('select acc.save_journal_template($1, $2, $3::jsonb, $4)', [co, id, JSON.stringify(sqlInput(b)), b.version ?? 0]);
      return (await c.query(`select id, name, version from acc.journal_templates where company_id = $1 and id = $2`, [co, id])).rows[0];
    });
  });
  app.post('/companies/:companyId/templates/:id/post', async (req, reply) => {
    const { companyId: co, id } = TemplateParams.parse(req.params);
    const b = TemplatePost.parse(req.body);
    const key = idemKey(req);
    const row = await withUser(pool, await user(req), async (c) => {
      await requireWritable(c, co);
      const eid = (await c.query('select acc.post_template($1, $2, $3::jsonb, $4) id', [co, id, JSON.stringify({ date: b.date, month: b.month ? `${b.month}-01` : undefined, lines: b.lines }), key])).rows[0].id;
      return (await c.query('select id as "entryId", doc_no as "docNo" from acc.journal_entries where company_id = $1 and id = $2', [co, eid])).rows[0];
    });
    return reply.code(201).send(row);
  });
}
