import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { withUser } from '../db.js';
import type { AuthAdapter, AuthUser } from '../auth.js';
import { requireReadable, requireUser } from '../guard.js';
import { CompanyParams, IdempotencyKey, OpeningBalances, VoidOpening } from '../schemas.js';

// เฟส 5 โมดูล 3: ยอดยกมาพร้อมรายตัว (docs/phase5-spec.md ข้อ 3) ชั้นบาง Zod → acc.post_opening_balances / acc.void_opening_balances
export function openingRoutes(app: FastifyInstance, pool: pg.Pool, auth: AuthAdapter) {
  const user = (req: FastifyRequest): Promise<AuthUser> => requireUser(auth, req);
  const idemKey = (req: FastifyRequest) => IdempotencyKey.parse(req.headers['idempotency-key']);

  // ยอดยกมาชุดปัจจุบัน (ถ้ามี) + ข้อมูลที่ฟอร์มใช้
  app.get('/companies/:companyId/opening', async (req) => {
    const { companyId } = CompanyParams.parse(req.params);
    return withUser(pool, await user(req), async (c) => {
      await requireReadable(c, companyId);
      const ob = (await c.query(
        `select o.id, o.as_of::text as date, e.id as "entryId", e.doc_no as "docNo", e.total_amount::text as total, o.created_at as "createdAt",
                (select coalesce(json_agg(json_build_object('docNo', d.doc_no, 'partyCode', d.party_code, 'partyName', d.party_name,
                          'date', d.doc_date::text, 'dueDate', d.due_date::text, 'amount', d.total::text, 'undueVat', d.vat::text) order by d.doc_no), '[]')
                   from acc.documents d where d.company_id = o.company_id and d.opening_id = o.id) as receivables,
                (select coalesce(json_agg(json_build_object('docNo', d.doc_no, 'ref', d.vendor_doc_no, 'partyCode', d.party_code, 'partyName', d.party_name,
                          'date', d.doc_date::text, 'dueDate', d.due_date::text, 'amount', d.total::text, 'undueVat', d.vat::text) order by d.doc_no), '[]')
                   from acc.purchase_documents d where d.company_id = o.company_id and d.opening_id = o.id) as payables,
                (select coalesce(json_agg(json_build_object('code', f.code, 'name', f.name, 'cost', f.cost::text,
                          'accumulated', f.opening_accumulated::text, 'months', f.opening_months) order by f.code), '[]')
                   from acc.fixed_assets f where f.company_id = o.company_id and f.opening_id = o.id) as assets,
                (select coalesce(json_agg(json_build_object('itemCode', i.code, 'name', i.name, 'qty', m.quantity::text,
                          'unitCost', m.unit_cost::text, 'value', m.value::text) order by i.code), '[]')
                   from acc.inventory_movements m join acc.items i on i.company_id = m.company_id and i.id = m.item_id
                  where m.company_id = o.company_id and m.entry_id = o.entry_id) as inventory
           from acc.opening_balances o join acc.journal_entries e on e.company_id = o.company_id and e.id = o.entry_id
          where o.company_id = $1 and o.voided_at is null`, [companyId])).rows[0] ?? null;
      const form = (await c.query(
        `select app.can_write_company($1) and not app.company_locked($1) as "canWrite",
                (select vat_registered from acc.companies where id = $1) as "vatRegistered",
                (select min(e.entry_date)::text from acc.journal_entries e where e.company_id = $1 and e.doc_prefix <> 'OB'
                    and not exists (select 1 from acc.journal_entries o where o.company_id = e.company_id and o.id = e.reverses_entry_id and o.doc_prefix = 'OB')) as "firstEntryDate",
                (select coalesce(json_agg(json_build_object('code', code, 'name', name, 'type', type) order by code), '[]')
                   from acc.chart_of_accounts where company_id = $1 and active) as accounts,
                (select coalesce(json_agg(json_build_object('code', code, 'name', name, 'creditDays', credit_days) order by code), '[]')
                   from acc.parties where company_id = $1 and active and is_customer) as customers,
                (select coalesce(json_agg(json_build_object('code', code, 'name', name, 'creditDays', credit_days) order by code), '[]')
                   from acc.parties where company_id = $1 and active and is_vendor) as vendors,
                (select coalesce(json_agg(json_build_object('code', code, 'name', name, 'unit', unit) order by code), '[]')
                   from acc.items where company_id = $1 and active and track_inventory) as items`, [companyId])).rows[0];
      return { opening: ob, ...form };
    });
  });

  app.post('/companies/:companyId/opening', async (req, reply) => {
    const { companyId } = CompanyParams.parse(req.params);
    const b = OpeningBalances.parse(req.body);
    const key = idemKey(req);
    const p = {
      date: b.date,
      accounts: b.accounts,
      receivables: b.receivables.map((x) => ({ party_code: x.partyCode, ref: x.ref, date: x.date, due_date: x.dueDate, amount: x.amount, undue_vat: x.undueVat })),
      payables: b.payables.map((x) => ({ party_code: x.partyCode, ref: x.ref, date: x.date, due_date: x.dueDate, amount: x.amount, undue_vat: x.undueVat })),
      assets: b.assets.map((x) => ({ code: x.code, name: x.name, acquired_date: x.acquiredDate, dep_start: x.depStart, cost: x.cost, salvage: x.salvage,
        life_months: x.lifeMonths, asset_account: x.assetAccount, accum_account: x.accumAccount, expense_account: x.expenseAccount, accumulated: x.accumulated })),
      inventory: b.inventory.map((x) => ({ item_code: x.itemCode, qty: x.qty, unit_cost: x.unitCost })),
    };
    const out = await withUser(pool, await user(req), async (c) => {
      const id = (await c.query('select acc.post_opening_balances($1, $2::jsonb, $3) as id', [companyId, JSON.stringify(p), key])).rows[0].id;
      return (await c.query(
        `select o.id, e.doc_no as "docNo" from acc.opening_balances o join acc.journal_entries e on e.company_id = o.company_id and e.id = o.entry_id
          where o.company_id = $1 and o.id = $2`, [companyId, id])).rows[0];
    });
    return reply.code(201).send(out);
  });

  app.post('/companies/:companyId/opening/void', async (req) => {
    const { companyId } = CompanyParams.parse(req.params);
    const { reason } = VoidOpening.parse(req.body);
    const key = idemKey(req);
    const docNo = await withUser(pool, await user(req), async (c) => {
      const rv = (await c.query('select acc.void_opening_balances($1, $2, $3) as id', [companyId, reason, key])).rows[0].id;
      return (await c.query('select doc_no from acc.journal_entries where company_id = $1 and id = $2', [companyId, rv])).rows[0].doc_no as string;
    });
    return { voided: true, docNo };
  });
}
