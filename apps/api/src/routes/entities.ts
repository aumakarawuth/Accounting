import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { querySequence, withUser } from '../db.js';
import { financialRatios } from '../ratios.js';
import type { AuthAdapter, AuthUser } from '../auth.js';
import { requireReadable, requireUser, requireWritable } from '../guard.js';
import {
  CompanyParams, DateQuery, StatementsQuery, DividendInput, DividendParams, DividendPay, DividendVoid, EntityProfile, IdempotencyKey, SetEntity, entityJson,
} from '../schemas.js';

// เฟส 7 (docs/phase7-spec.md): ประเภทกิจการ · เงินปันผล — ชั้นบาง Zod → ฟังก์ชันใน DB
export function entityRoutes(app: FastifyInstance, pool: pg.Pool, auth: AuthAdapter) {
  const user = (req: FastifyRequest): Promise<AuthUser> => requireUser(auth, req);
  const idemKey = (req: FastifyRequest) => IdempotencyKey.parse(req.headers['idempotency-key']);
  const today = `(now() at time zone 'Asia/Bangkok')::date`;

  async function entityOf(c: pg.PoolClient, id: string) {
    const [co, partners] = await querySequence([
      () => c.query(`select c.entity_type as type, c.version, c.par_value::text as "parValue", c.registered_shares::text as "registeredShares",
                            app.can_write_company(c.id) as "canWrite", app.company_locked(c.id) as locked,
                            not exists (select 1 from acc.journal_entries e where e.company_id = c.id) as "canChangeType"
                       from acc.companies c where c.id = $1`, [id]),
      () => c.query(`select no, name, trim_scale(ratio)::text as ratio, trim_scale(interest_rate)::text as "interestRate", salary::text as salary
                       from acc.partners where company_id = $1 order by no`, [id]),
    ] as const);
    return { ...co.rows[0], partners: partners.rows };
  }

  app.get('/companies/:companyId/entity', async (req) => {
    const { companyId: id } = CompanyParams.parse(req.params);
    return withUser(pool, await user(req), async (c) => { await requireReadable(c, id); return entityOf(c, id); });
  });
  // เปลี่ยนประเภทกิจการ (ยังไม่มีรายการเท่านั้น)
  app.put('/companies/:companyId/entity', async (req) => {
    const { companyId: id } = CompanyParams.parse(req.params);
    const b = SetEntity.parse(req.body);
    return withUser(pool, await user(req), async (c) => {
      await requireWritable(c, id);
      await c.query('select acc.set_company_entity($1, $2::jsonb, $3)', [id, JSON.stringify(entityJson(b.entity)), b.version]);
      return entityOf(c, id);
    });
  });
  // สัญญาห้างหุ้นส่วน / ข้อมูลหุ้น
  app.patch('/companies/:companyId/entity', async (req) => {
    const { companyId: id } = CompanyParams.parse(req.params);
    const b = EntityProfile.parse(req.body);
    return withUser(pool, await user(req), async (c) => {
      await requireWritable(c, id);
      const p = {
        ...(b.partners ? { partners: b.partners.map((x) => ({ name: x.name, ratio: x.ratio, interest_rate: x.interestRate, salary: x.salary })) } : {}),
        ...(b.parValue ? { par_value: b.parValue } : {}),
        ...(b.registeredShares !== undefined ? { registered_shares: b.registeredShares } : {}),
      };
      await c.query('select acc.save_entity_profile($1, $2::jsonb, $3)', [id, JSON.stringify(p), b.version]);
      return entityOf(c, id);
    });
  });

  // ---- วิเคราะห์อัตราส่วนทางการเงิน (docs/phase7-spec.md ข้อ 4) ----
  app.get('/companies/:companyId/ratios', async (req) => {
    const { companyId: id } = CompanyParams.parse(req.params);
    const { month, scope } = StatementsQuery.parse(req.query);
    return withUser(pool, await user(req), async (c) => { await requireReadable(c, id); return financialRatios(c, id, month, scope); });
  });

  // ---- เงินปันผล (บริษัทจำกัด) ----
  const DIV = `d.id, to_char(d.declared_on, 'YYYY-MM-DD') as date, trim_scale(d.per_share)::text as "perShare", trim_scale(d.shares)::text as shares,
    d.amount::text, d.reserve::text, d.description, d.entry_id as "entryId", j.doc_no as "docNo",
    to_char(d.paid_on, 'YYYY-MM-DD') as "paidOn", pj.doc_no as "payDocNo", d.pay_entry_id as "payEntryId", ca.code as "cashAccount",
    d.voided_at is not null as voided, v.doc_no as "voidDocNo", d.void_reason as "voidReason"`;
  const DIV_FROM = `acc.dividends d
    join acc.journal_entries j on j.company_id = d.company_id and j.id = d.entry_id
    left join acc.journal_entries pj on pj.company_id = d.company_id and pj.id = d.pay_entry_id
    left join acc.journal_entries v on v.company_id = d.company_id and v.id = d.void_entry_id
    left join acc.chart_of_accounts ca on ca.company_id = d.company_id and ca.id = d.cash_account_id`;
  app.get('/companies/:companyId/dividends', async (req) => {
    const { companyId: id } = CompanyParams.parse(req.params);
    const { date } = DateQuery.parse(req.query);
    return withUser(pool, await user(req), async (c) => {
      await requireReadable(c, id);
      const [co, preview, cash, rows] = await querySequence([
        () => c.query(`select entity_type as "entityType", app.can_write_company(id) as "canWrite", app.company_locked(id) as locked from acc.companies where id = $1`, [id]),
        () => c.query(`select acc.dividend_preview($1, coalesce($2::date, ${today})) p`, [id, date ?? null]),
        () => c.query(`select code, name from acc.chart_of_accounts where company_id = $1 and active and type = 'asset' and code like '11%' order by code`, [id]),
        () => c.query(`select ${DIV} from ${DIV_FROM} where d.company_id = $1 order by d.declared_on desc, j.doc_no desc limit 200`, [id]),
      ] as const);
      return { ...co.rows[0], preview: preview.rows[0].p, cashAccounts: cash.rows, dividends: rows.rows };
    });
  });
  app.post('/companies/:companyId/dividends', async (req, reply) => {
    const { companyId: id } = CompanyParams.parse(req.params);
    const b = DividendInput.parse(req.body);
    const key = idemKey(req);
    const row = await withUser(pool, await user(req), async (c) => {
      await requireWritable(c, id);
      const x = (await c.query('select acc.declare_dividend($1, $2::jsonb, $3) id', [id, JSON.stringify({
        date: b.date, per_share: b.perShare, amount: b.amount, reserve: b.reserve, description: b.description }), key])).rows[0].id;
      return (await c.query(`select ${DIV} from ${DIV_FROM} where d.company_id = $1 and d.id = $2`, [id, x])).rows[0];
    });
    return reply.code(201).send(row);
  });
  app.post('/companies/:companyId/dividends/:id/pay', async (req, reply) => {
    const { companyId: co, id } = DividendParams.parse(req.params);
    const b = DividendPay.parse(req.body);
    const key = idemKey(req);
    const row = await withUser(pool, await user(req), async (c) => {
      await requireWritable(c, co);
      await c.query('select acc.pay_dividend($1, $2, $3::jsonb, $4)', [co, id, JSON.stringify({ date: b.date, cash_account: b.cashAccount }), key]);
      return (await c.query(`select ${DIV} from ${DIV_FROM} where d.company_id = $1 and d.id = $2`, [co, id])).rows[0];
    });
    return reply.code(201).send(row);
  });
  app.post('/companies/:companyId/dividends/:id/void', async (req) => {
    const { companyId: co, id } = DividendParams.parse(req.params);
    const b = DividendVoid.parse(req.body);
    const key = idemKey(req);
    return withUser(pool, await user(req), async (c) => {
      await requireWritable(c, co);
      const rv = (await c.query('select acc.void_dividend($1, $2, $3, $4, $5, $6) id', [co, id, b.what, b.date, b.reason, key])).rows[0].id;
      return { voidDocNo: (await c.query('select doc_no from acc.journal_entries where company_id = $1 and id = $2', [co, rv])).rows[0].doc_no };
    });
  });
}
