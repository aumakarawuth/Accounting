import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { querySequence, withUser } from '../db.js';
import type { AuthAdapter, AuthUser } from '../auth.js';
import { requireReadable, requireUser, requireWritable } from '../guard.js';
import { specialJournal } from '../books.js';
import { cashFlow } from '../cashflow.js';
import { equityChanges } from '../equity.js';
import {
  AdjustmentInput, AdjustmentParams, AllowanceInput, BadDebtVoidParams, BookQuery, CompanyParams, IdempotencyKey, MonthQuery, RecoveryInput, StatementsQuery, VoidDocument, WriteOffInput,
} from '../schemas.js';
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

  // ข้อ 4 ค่าเผื่อหนี้สงสัยจะสูญ · ตัดหนี้สูญ · หนี้สูญได้รับคืน
  const idemKey = (req: FastifyRequest) => IdempotencyKey.parse(req.headers['idempotency-key']);
  const rates = (b: ReturnType<typeof AllowanceInput.parse>) => {
    if (b.method === 'aging') {
      if (!b.rates) throw new HttpError(400, 'invalid', 'ต้องระบุอัตราร้อยละทุกช่วงอายุลูกหนี้');
      return b.rates;
    }
    if (!b.rate) throw new HttpError(400, 'invalid', 'ต้องระบุอัตราร้อยละ');
    return { rate: b.rate, ...(b.method === 'sales' ? { scope: b.scope ?? 'month' } : {}) };
  };
  app.get('/companies/:companyId/bad-debts', async (req) => {
    const { companyId: id } = CompanyParams.parse(req.params);
    const { month } = MonthQuery.parse(req.query);
    return withUser(pool, await user(req), async (c) => {
      await requireReadable(c, id);
      const asOf = month ? `(date_trunc('month', '${month}-01'::date) + interval '1 month - 1 day')::date` : `(now() at time zone 'Asia/Bangkok')::date`;
      const [co, bal, open, allowances, writeoffs] = await querySequence([
        () => c.query(`select app.can_write_company(id) as "canWrite", app.company_locked(id) as locked from acc.companies where id = $1`, [id]),
        () => c.query(`select (-acc.account_net_as_of($1, '1211', ${asOf}))::numeric(18,2)::text as allowance,
                              acc.account_net_as_of($1, '1210', ${asOf})::numeric(18,2)::text as receivables,
                              (select coalesce(sum(o.open), 0) from acc.ar_open_items_as_of($1, ${asOf}) o)::numeric(18,2)::text as subledger,
                              ${asOf}::text as "asOf"`, [id]),
        () => c.query(`select o.document_id as id, o.doc_no as "docNo", to_char(o.doc_date, 'YYYY-MM-DD') as date, to_char(o.due_date, 'YYYY-MM-DD') as "dueDate",
                              o.party_name as "partyName", o.total::text, o.open::text
                         from acc.ar_open_items($1) o order by o.due_date, o.doc_no limit 500`, [id]),
        () => c.query(`select x.id, j.doc_no as "docNo", to_char(x.month, 'YYYY-MM') as month, x.method, x.rates, x.base::text, x.required::text,
                              x.previous::text, x.amount::text, x.voided_at is not null as voided, v.doc_no as "voidDocNo"
                         from acc.allowance_entries x join acc.journal_entries j on j.company_id = x.company_id and j.id = x.entry_id
                         left join acc.journal_entries v on v.company_id = x.company_id and v.id = x.void_entry_id
                        where x.company_id = $1 order by x.month desc, j.doc_no desc limit 200`, [id]),
        () => c.query(`select w.id, j.doc_no as "docNo", to_char(w.doc_date, 'YYYY-MM-DD') as date, d.doc_no as "invoiceNo", d.party_name as "partyName",
                              w.amount::text, w.vat::text, w.reason, w.voided_at is not null as voided, v.doc_no as "voidDocNo",
                              (w.amount - coalesce((select sum(r.amount) from acc.bad_debt_recoveries r where r.company_id = w.company_id and r.writeoff_id = w.id
                                 and r.voided_at is null), 0))::text as unrecovered,
                              coalesce((select json_agg(json_build_object('id', r.id, 'docNo', rj.doc_no, 'date', to_char(r.doc_date, 'YYYY-MM-DD'),
                                  'amount', r.amount::text, 'credit', ca.code, 'voided', r.voided_at is not null) order by r.doc_date, rj.doc_no)
                                 from acc.bad_debt_recoveries r join acc.journal_entries rj on rj.company_id = r.company_id and rj.id = r.entry_id
                                 join acc.chart_of_accounts ca on ca.company_id = r.company_id and ca.id = r.credit_account_id
                                where r.company_id = w.company_id and r.writeoff_id = w.id), '[]') as recoveries
                         from acc.bad_debt_writeoffs w join acc.journal_entries j on j.company_id = w.company_id and j.id = w.entry_id
                         join acc.documents d on d.company_id = w.company_id and d.id = w.document_id
                         left join acc.journal_entries v on v.company_id = w.company_id and v.id = w.void_entry_id
                        where w.company_id = $1 order by w.doc_date desc, j.doc_no desc limit 200`, [id]),
      ] as const);
      const b = bal.rows[0];
      return { ...co.rows[0], ...b, matches: b.receivables === b.subledger, open: open.rows, allowances: allowances.rows, writeoffs: writeoffs.rows };
    });
  });

  app.post('/companies/:companyId/bad-debts/allowance/preview', async (req) => {
    const { companyId: id } = CompanyParams.parse(req.params);
    const b = AllowanceInput.parse(req.body);
    return withUser(pool, await user(req), async (c) => {
      await requireReadable(c, id);
      return (await c.query('select acc.allowance_preview($1, $2::date, $3, $4::jsonb) p', [id, `${b.month}-01`, b.method, JSON.stringify(rates(b))])).rows[0].p;
    });
  });
  app.post('/companies/:companyId/bad-debts/allowance', async (req, reply) => {
    const { companyId: id } = CompanyParams.parse(req.params);
    const b = AllowanceInput.parse(req.body);
    const key = idemKey(req);
    const row = await withUser(pool, await user(req), async (c) => {
      await requireWritable(c, id);
      const x = (await c.query('select acc.post_allowance($1, $2::date, $3, $4::jsonb, $5) id', [id, `${b.month}-01`, b.method, JSON.stringify(rates(b)), key])).rows[0].id;
      return (await c.query(`select x.id, j.doc_no as "docNo", x.amount::text from acc.allowance_entries x join acc.journal_entries j on j.company_id = x.company_id and j.id = x.entry_id
                              where x.company_id = $1 and x.id = $2`, [id, x])).rows[0];
    });
    return reply.code(201).send(row);
  });
  app.post('/companies/:companyId/bad-debts/writeoffs', async (req, reply) => {
    const { companyId: id } = CompanyParams.parse(req.params);
    const b = WriteOffInput.parse(req.body);
    const key = idemKey(req);
    const row = await withUser(pool, await user(req), async (c) => {
      await requireWritable(c, id);
      const x = (await c.query('select acc.write_off_receivable($1, $2::jsonb, $3) id', [id, JSON.stringify({ document_id: b.documentId, date: b.date, amount: b.amount, reason: b.reason }), key])).rows[0].id;
      return (await c.query(`select w.id, j.doc_no as "docNo", w.entry_id as "entryId", w.amount::text, w.vat::text from acc.bad_debt_writeoffs w
                              join acc.journal_entries j on j.company_id = w.company_id and j.id = w.entry_id where w.company_id = $1 and w.id = $2`, [id, x])).rows[0];
    });
    return reply.code(201).send(row);
  });
  app.post('/companies/:companyId/bad-debts/recoveries', async (req, reply) => {
    const { companyId: id } = CompanyParams.parse(req.params);
    const b = RecoveryInput.parse(req.body);
    const key = idemKey(req);
    const row = await withUser(pool, await user(req), async (c) => {
      await requireWritable(c, id);
      const x = (await c.query('select acc.recover_bad_debt($1, $2::jsonb, $3) id', [id, JSON.stringify({ writeoff_id: b.writeoffId, date: b.date, amount: b.amount, credit: b.credit }), key])).rows[0].id;
      return (await c.query(`select r.id, j.doc_no as "docNo", r.entry_id as "entryId", r.amount::text, r.vat::text from acc.bad_debt_recoveries r
                              join acc.journal_entries j on j.company_id = r.company_id and j.id = r.entry_id where r.company_id = $1 and r.id = $2`, [id, x])).rows[0];
    });
    return reply.code(201).send(row);
  });
  app.post('/companies/:companyId/bad-debts/:kind/:id/void', async (req) => {
    const { companyId: co, kind, id } = BadDebtVoidParams.parse(req.params);
    const b = VoidDocument.parse(req.body);
    const key = idemKey(req);
    return withUser(pool, await user(req), async (c) => {
      await requireWritable(c, co);
      const rv = (await c.query('select acc.void_bad_debt($1, $2, $3, $4, $5, $6) id', [co, kind, id, b.date, b.reason, key])).rows[0].id;
      return { voidDocNo: (await c.query('select doc_no from acc.journal_entries where company_id = $1 and id = $2', [co, rv])).rows[0].doc_no };
    });
  });

  // ข้อ 5 รายการปรับปรุง ค้างรับ/ค้างจ่าย/รับล่วงหน้า/จ่ายล่วงหน้า + กลับรายการอัตโนมัติ
  const ADJ = `x.id, to_char(x.month, 'YYYY-MM') as month, x.kind, x.method, pa.code as "plAccount", pa.name as "plName", ba.code as "bsAccount",
    ba.name as "bsName", x.amount::text, x.description, x.auto_reverse as "autoReverse", x.entry_id as "entryId", j.doc_no as "docNo",
    to_char(j.entry_date, 'YYYY-MM-DD') as date, r.doc_no as "reversalDocNo", to_char(r.entry_date, 'YYYY-MM-DD') as "reversalDate",
    x.voided_at is not null as voided, v.doc_no as "voidDocNo", x.void_reason as "voidReason"`;
  const ADJ_FROM = `acc.adjustment_entries x
    join acc.chart_of_accounts pa on pa.company_id = x.company_id and pa.id = x.pl_account_id
    join acc.chart_of_accounts ba on ba.company_id = x.company_id and ba.id = x.bs_account_id
    join acc.journal_entries j on j.company_id = x.company_id and j.id = x.entry_id
    left join acc.journal_entries r on r.company_id = x.company_id and r.id = x.reversal_entry_id
    left join acc.journal_entries v on v.company_id = x.company_id and v.id = x.void_entry_id`;
  app.get('/companies/:companyId/adjustments', async (req) => {
    const { companyId: id } = CompanyParams.parse(req.params);
    return withUser(pool, await user(req), async (c) => {
      await requireReadable(c, id);
      const [co, accounts, rows] = await querySequence([
        () => c.query(`select app.can_write_company(id) as "canWrite", app.company_locked(id) as locked from acc.companies where id = $1`, [id]),
        () => c.query(`select code, name, type from acc.chart_of_accounts where company_id = $1 and active order by code`, [id]),
        () => c.query(`select ${ADJ} from ${ADJ_FROM} where x.company_id = $1 order by x.month desc, j.doc_no desc limit 300`, [id]),
      ] as const);
      return { ...co.rows[0], accounts: accounts.rows, adjustments: rows.rows };
    });
  });
  app.post('/companies/:companyId/adjustments', async (req, reply) => {
    const { companyId: id } = CompanyParams.parse(req.params);
    const b = AdjustmentInput.parse(req.body);
    const key = idemKey(req);
    const row = await withUser(pool, await user(req), async (c) => {
      await requireWritable(c, id);
      const p = { month: `${b.month}-01`, kind: b.kind, method: b.method, pl_account: b.plAccount, bs_account: b.bsAccount, amount: b.amount,
        description: b.description, auto_reverse: b.autoReverse };
      const x = (await c.query('select acc.post_adjustment($1, $2::jsonb, $3) id', [id, JSON.stringify(p), key])).rows[0].id;
      return (await c.query(`select ${ADJ} from ${ADJ_FROM} where x.company_id = $1 and x.id = $2`, [id, x])).rows[0];
    });
    return reply.code(201).send(row);
  });
  app.post('/companies/:companyId/adjustments/:id/void', async (req) => {
    const { companyId: co, id } = AdjustmentParams.parse(req.params);
    const b = VoidDocument.parse(req.body);
    const key = idemKey(req);
    return withUser(pool, await user(req), async (c) => {
      await requireWritable(c, co);
      await c.query('select acc.void_adjustment($1, $2, $3, $4, $5)', [co, id, b.date, b.reason, key]);
      return (await c.query(`select ${ADJ} from ${ADJ_FROM} where x.company_id = $1 and x.id = $2`, [co, id])).rows[0];
    });
  });
}
