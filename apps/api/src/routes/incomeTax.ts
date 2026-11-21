import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { querySequence, withUser } from '../db.js';
import type { AuthAdapter, AuthUser } from '../auth.js';
import { requireReadable, requireUser, requireWritable } from '../guard.js';
import { CompanyParams, DividendParams, IdempotencyKey, IncomeTaxInput, IncomeTaxPay, IncomeTaxQuery, IncomeTaxVoid } from '../schemas.js';

// เฟส 7 โมดูล 2 (docs/phase7-spec.md ข้อ 2): ภาษีเงินได้นิติบุคคล ภ.ง.ด.51 / ภ.ง.ด.50 — ชั้นบาง Zod → ฟังก์ชันใน DB
export function incomeTaxRoutes(app: FastifyInstance, pool: pg.Pool, auth: AuthAdapter) {
  const user = (req: FastifyRequest): Promise<AuthUser> => requireUser(auth, req);
  const idemKey = (req: FastifyRequest) => IdempotencyKey.parse(req.headers['idempotency-key']);
  const sqlInput = (b: ReturnType<typeof IncomeTaxInput.parse>) => ({
    form: b.form, year_end: b.yearEnd, date: b.date, estimated_profit: b.estimatedProfit, estimated_revenue: b.estimatedRevenue,
    use_wht: b.useWht, cash_account: b.cashAccount,
  });
  const ROW = `f.id, f.form, to_char(f.year_start, 'YYYY-MM-DD') as "yearStart", to_char(f.year_end, 'YYYY-MM-DD') as "yearEnd",
    to_char(f.filed_on, 'YYYY-MM-DD') as date, f.actual_profit::text as "actualProfit", f.profit::text, f.revenue::text, f.paid_up::text as "paidUp",
    f.sme, f.tax_full::text as "taxFull", f.tax::text, f.credit_prepaid::text as "creditPrepaid", f.credit_wht::text as "creditWht", f.payable::text,
    f.entry_id as "entryId", j.doc_no as "docNo", to_char(f.paid_on, 'YYYY-MM-DD') as "paidOn", pj.doc_no as "payDocNo",
    f.voided_at is not null as voided, v.doc_no as "voidDocNo", f.void_reason as "voidReason"`;
  const FROM = `acc.income_tax_filings f
    left join acc.journal_entries j on j.company_id = f.company_id and j.id = f.entry_id
    left join acc.journal_entries pj on pj.company_id = f.company_id and pj.id = f.pay_entry_id
    left join acc.journal_entries v on v.company_id = f.company_id and v.id = f.void_entry_id`;

  app.get('/companies/:companyId/income-tax', async (req) => {
    const { companyId: id } = CompanyParams.parse(req.params);
    const q = IncomeTaxQuery.parse(req.query);
    return withUser(pool, await user(req), async (c) => {
      await requireReadable(c, id);
      const co = (await c.query(`select entity_type as "entityType", app.can_write_company(id) as "canWrite", app.company_locked(id) as locked
                                   from acc.companies where id = $1`, [id])).rows[0];
      if (co.entityType !== 'company') return { ...co, years: [], filings: [], cashAccounts: [] };
      const years = (await c.query(
        `with r as (select coalesce(min(entry_date), (now() at time zone 'Asia/Bangkok')::date) lo,
                           greatest(coalesce(max(entry_date), (now() at time zone 'Asia/Bangkok')::date), (now() at time zone 'Asia/Bangkok')::date) hi
                      from acc.journal_entries where company_id = $1)
         select gs::date::text as start, (gs + interval '1 year - 1 day')::date::text as "end"
           from r, generate_series(acc.fiscal_year_start($1, r.lo), acc.fiscal_year_start($1, r.hi), interval '1 year') gs order by gs`, [id])).rows as { start: string; end: string }[];
      const yearEnd = q.yearEnd && years.some((y) => y.end === q.yearEnd) ? q.yearEnd : years.at(-1)!.end;
      const [p51, p50, filings, cash] = await querySequence([
        () => c.query(`select acc.cit_preview($1, '51', $2::date, '{}') p`, [id, yearEnd]),
        () => c.query(`select acc.cit_preview($1, '50', $2::date, '{}') p`, [id, yearEnd]),
        () => c.query(`select ${ROW} from ${FROM} where f.company_id = $1 order by f.year_start desc, f.form desc, f.created_at desc limit 100`, [id]),
        () => c.query(`select code, name from acc.chart_of_accounts where company_id = $1 and active and type = 'asset' and code like '11%' order by code`, [id]),
      ] as const);
      return { ...co, years, yearEnd, preview51: p51.rows[0].p, preview50: p50.rows[0].p, filings: filings.rows, cashAccounts: cash.rows };
    });
  });
  app.post('/companies/:companyId/income-tax/preview', async (req) => {
    const { companyId: id } = CompanyParams.parse(req.params);
    const b = IncomeTaxInput.parse(req.body);
    return withUser(pool, await user(req), async (c) => {
      await requireReadable(c, id);
      return (await c.query('select acc.cit_preview($1, $2, $3::date, $4::jsonb) p', [id, b.form, b.yearEnd, JSON.stringify(sqlInput(b))])).rows[0].p;
    });
  });
  app.post('/companies/:companyId/income-tax', async (req, reply) => {
    const { companyId: id } = CompanyParams.parse(req.params);
    const b = IncomeTaxInput.parse(req.body);
    const key = idemKey(req);
    const row = await withUser(pool, await user(req), async (c) => {
      await requireWritable(c, id);
      const x = (await c.query('select acc.file_income_tax($1, $2::jsonb, $3) id', [id, JSON.stringify(sqlInput(b)), key])).rows[0].id;
      return (await c.query(`select ${ROW} from ${FROM} where f.company_id = $1 and f.id = $2`, [id, x])).rows[0];
    });
    return reply.code(201).send(row);
  });
  app.post('/companies/:companyId/income-tax/:id/pay', async (req, reply) => {
    const { companyId: co, id } = DividendParams.parse(req.params);
    const b = IncomeTaxPay.parse(req.body);
    const key = idemKey(req);
    const row = await withUser(pool, await user(req), async (c) => {
      await requireWritable(c, co);
      await c.query('select acc.pay_income_tax($1, $2, $3::jsonb, $4)', [co, id, JSON.stringify({ date: b.date, cash_account: b.cashAccount }), key]);
      return (await c.query(`select ${ROW} from ${FROM} where f.company_id = $1 and f.id = $2`, [co, id])).rows[0];
    });
    return reply.code(201).send(row);
  });
  app.post('/companies/:companyId/income-tax/:id/void', async (req) => {
    const { companyId: co, id } = DividendParams.parse(req.params);
    const b = IncomeTaxVoid.parse(req.body);
    const key = idemKey(req);
    return withUser(pool, await user(req), async (c) => {
      await requireWritable(c, co);
      const rv = (await c.query('select acc.void_income_tax($1, $2, $3, $4, $5, $6) id', [co, id, b.what, b.date, b.reason, key])).rows[0].id;
      return { voidDocNo: rv ? (await c.query('select doc_no from acc.journal_entries where company_id = $1 and id = $2', [co, rv])).rows[0].doc_no : null };
    });
  });
}
