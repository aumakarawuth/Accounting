import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { querySequence, withUser } from '../db.js';
import type { AuthAdapter, AuthUser } from '../auth.js';
import { requireReadable, requireUser, requireWritable } from '../guard.js';
import {
  CancelWithReason, CashDocParams, CompanyParams, IdempotencyKey, NewCashTransfer, NewPettyCashReimbursement, NewPettyCashVoucher,
  PettyCashFund, VoidDocument,
} from '../schemas.js';

// เฟส 5 โมดูล 9 (docs/phase5-spec.md ข้อ 9): โอนเงินระหว่างบัญชี + เงินสดย่อย — ชั้นบาง Zod → ฟังก์ชันใน DB

const TRANSFER = `t.id, t.entry_id as "entryId", j.doc_no as "docNo", to_char(t.doc_date, 'YYYY-MM-DD') as date, f.code as "from", f.name as "fromName",
  o.code as "to", o.name as "toName", t.amount::text, t.fee::text, x.code as "feeAccount", t.description,
  t.voided_at is not null as voided, t.void_reason as "voidReason", v.doc_no as "voidDocNo"`;
const TRANSFER_FROM = `acc.cash_transfers t
  join acc.journal_entries j on j.company_id = t.company_id and j.id = t.entry_id
  join acc.chart_of_accounts f on f.company_id = t.company_id and f.id = t.from_account_id
  join acc.chart_of_accounts o on o.company_id = t.company_id and o.id = t.to_account_id
  left join acc.chart_of_accounts x on x.company_id = t.company_id and x.id = t.fee_account_id
  left join acc.journal_entries v on v.company_id = t.company_id and v.id = t.void_entry_id`;
const VOUCHER = `v.id, v.doc_no as "docNo", to_char(v.doc_date, 'YYYY-MM-DD') as date, v.payee, v.description, a.code as account,
  a.name as "accountName", v.amount::text, v.receipt_no as "receiptNo", v.cancel_reason as "cancelReason",
  case when v.cancelled_at is not null then 'cancelled' when acc.petty_cash_unreimbursed(v.company_id, v.id) then 'pending'
       else 'reimbursed' end as status`;

export function cashRoutes(app: FastifyInstance, pool: pg.Pool, auth: AuthAdapter) {
  const user = (req: FastifyRequest): Promise<AuthUser> => requireUser(auth, req);
  const idemKey = (req: FastifyRequest) => IdempotencyKey.parse(req.headers['idempotency-key']);
  const company = (c: pg.PoolClient, companyId: string) =>
    c.query(`select name, app.can_write_company(id) as "canWrite", app.company_locked(id) as locked from acc.companies where id = $1`, [companyId]);
  // บัญชีเงินสด/เงินฝาก (11xx ที่ไม่ใช่เงินสดย่อย) และบัญชีค่าใช้จ่าย
  const accounts = async (c: pg.PoolClient, companyId: string) => {
    const rows = (await c.query(`select code, name, type from acc.chart_of_accounts where company_id = $1 and active order by code`, [companyId]))
      .rows as { code: string; name: string; type: string }[];
    return {
      cashAccounts: rows.filter((a) => a.type === 'asset' && a.code.startsWith('11') && a.code !== '1140').map(({ code, name }) => ({ code, name })),
      expenseAccounts: rows.filter((a) => a.type === 'expense').map(({ code, name }) => ({ code, name })),
    };
  };

  // ---- ฝาก/ถอน/โอนเงินระหว่างบัญชี ----
  app.get('/companies/:companyId/cash-transfers', async (req) => {
    const { companyId } = CompanyParams.parse(req.params);
    return withUser(pool, await user(req), async (c) => {
      await requireReadable(c, companyId);
      const [co, rows] = await querySequence([
        () => company(c, companyId),
        () => c.query(`select ${TRANSFER} from ${TRANSFER_FROM} where t.company_id = $1 order by t.doc_date desc, j.doc_no desc limit 500`, [companyId]),
      ] as const);
      return { company: co.rows[0], transfers: rows.rows, ...(await accounts(c, companyId)) };
    });
  });

  app.post('/companies/:companyId/cash-transfers', async (req, reply) => {
    const { companyId } = CompanyParams.parse(req.params);
    const b = NewCashTransfer.parse(req.body);
    const key = idemKey(req);
    const p = { date: b.date, from: b.from, to: b.to, amount: b.amount, fee: b.fee, fee_account: b.feeAccount, description: b.description };
    const row = await withUser(pool, await user(req), async (c) => {
      await requireWritable(c, companyId);
      const id = (await c.query('select acc.post_cash_transfer($1, $2::jsonb, $3) id', [companyId, JSON.stringify(p), key])).rows[0].id;
      return (await c.query(`select ${TRANSFER} from ${TRANSFER_FROM} where t.company_id = $1 and t.id = $2`, [companyId, id])).rows[0];
    });
    return reply.code(201).send(row);
  });

  app.post('/companies/:companyId/cash-transfers/:id/void', async (req) => {
    const { companyId, id } = CashDocParams.parse(req.params);
    const b = VoidDocument.parse(req.body);
    const key = idemKey(req);
    return withUser(pool, await user(req), async (c) => {
      await requireWritable(c, companyId);
      await c.query('select acc.void_cash_transfer($1, $2, $3, $4, $5)', [companyId, id, b.date, b.reason, key]);
      return (await c.query(`select ${TRANSFER} from ${TRANSFER_FROM} where t.company_id = $1 and t.id = $2`, [companyId, id])).rows[0];
    });
  });

  // ---- เงินสดย่อย ----
  app.get('/companies/:companyId/petty-cash', async (req) => {
    const { companyId } = CompanyParams.parse(req.params);
    return withUser(pool, await user(req), async (c) => {
      await requireReadable(c, companyId);
      const [co, st, funds, vouchers, reims] = await querySequence([
        () => company(c, companyId),
        () => c.query(`select fund::text, pending::text, on_hand::text as "onHand" from acc.petty_cash_status($1)`, [companyId]),
        () => c.query(`select f.id, j.doc_no as "docNo", to_char(f.doc_date, 'YYYY-MM-DD') as date, f.fund::text, f.change::text,
                         a.code as "cashAccount", f.custodian
                    from acc.petty_cash_funds f join acc.journal_entries j on j.company_id = f.company_id and j.id = f.entry_id
                    join acc.chart_of_accounts a on a.company_id = f.company_id and a.id = f.cash_account_id
                   where f.company_id = $1 order by f.doc_date desc, f.created_at desc`, [companyId]),
        () => c.query(`select ${VOUCHER} from acc.petty_cash_vouchers v join acc.chart_of_accounts a on a.company_id = v.company_id and a.id = v.account_id
                   where v.company_id = $1 order by v.doc_date desc, v.doc_no desc limit 500`, [companyId]),
        () => c.query(`select r.id, j.doc_no as "docNo", to_char(r.doc_date, 'YYYY-MM-DD') as date, a.code as "cashAccount", r.total::text,
                         r.voided_at is not null as voided, r.void_reason as "voidReason",
                         (select array_agg(v.doc_no order by v.doc_no) from acc.petty_cash_reimbursement_items i
                            join acc.petty_cash_vouchers v on v.company_id = i.company_id and v.id = i.voucher_id
                           where i.company_id = r.company_id and i.reimbursement_id = r.id) as vouchers
                    from acc.petty_cash_reimbursements r join acc.journal_entries j on j.company_id = r.company_id and j.id = r.entry_id
                    join acc.chart_of_accounts a on a.company_id = r.company_id and a.id = r.cash_account_id
                   where r.company_id = $1 order by r.doc_date desc, j.doc_no desc limit 200`, [companyId]),
      ] as const);
      return {
        company: co.rows[0], ...st.rows[0], custodian: funds.rows[0]?.custodian ?? null, funds: funds.rows, vouchers: vouchers.rows,
        reimbursements: reims.rows, ...(await accounts(c, companyId)),
      };
    });
  });

  app.post('/companies/:companyId/petty-cash/fund', async (req, reply) => {
    const { companyId } = CompanyParams.parse(req.params);
    const b = PettyCashFund.parse(req.body);
    const key = idemKey(req);
    const p = { date: b.date, fund: b.fund, cash_account: b.cashAccount, custodian: b.custodian };
    const row = await withUser(pool, await user(req), async (c) => {
      await requireWritable(c, companyId);
      const id = (await c.query('select acc.set_petty_cash_fund($1, $2::jsonb, $3) id', [companyId, JSON.stringify(p), key])).rows[0].id;
      return (await c.query(`select f.id, j.doc_no as "docNo", f.fund::text, f.change::text from acc.petty_cash_funds f
                               join acc.journal_entries j on j.company_id = f.company_id and j.id = f.entry_id
                              where f.company_id = $1 and f.id = $2`, [companyId, id])).rows[0];
    });
    return reply.code(201).send(row);
  });

  app.post('/companies/:companyId/petty-cash/vouchers', async (req, reply) => {
    const { companyId } = CompanyParams.parse(req.params);
    const b = NewPettyCashVoucher.parse(req.body);
    const key = idemKey(req);
    const p = { date: b.date, payee: b.payee, description: b.description, account: b.account, amount: b.amount, receipt_no: b.receiptNo };
    const row = await withUser(pool, await user(req), async (c) => {
      await requireWritable(c, companyId);
      const id = (await c.query('select acc.post_petty_cash_voucher($1, $2::jsonb, $3) id', [companyId, JSON.stringify(p), key])).rows[0].id;
      return (await c.query(`select ${VOUCHER} from acc.petty_cash_vouchers v join acc.chart_of_accounts a on a.company_id = v.company_id and a.id = v.account_id
                              where v.company_id = $1 and v.id = $2`, [companyId, id])).rows[0];
    });
    return reply.code(201).send(row);
  });

  app.post('/companies/:companyId/petty-cash/vouchers/:id/cancel', async (req) => {
    const { companyId, id } = CashDocParams.parse(req.params);
    const { reason } = CancelWithReason.parse(req.body);
    await withUser(pool, await user(req), async (c) => {
      await requireWritable(c, companyId);
      await c.query('select acc.cancel_petty_cash_voucher($1, $2, $3)', [companyId, id, reason]);
    });
    return { cancelled: true };
  });

  app.post('/companies/:companyId/petty-cash/reimbursements', async (req, reply) => {
    const { companyId } = CompanyParams.parse(req.params);
    const b = NewPettyCashReimbursement.parse(req.body);
    const key = idemKey(req);
    const p = { date: b.date, cash_account: b.cashAccount, voucher_ids: b.voucherIds };
    const row = await withUser(pool, await user(req), async (c) => {
      await requireWritable(c, companyId);
      const id = (await c.query('select acc.post_petty_cash_reimbursement($1, $2::jsonb, $3) id', [companyId, JSON.stringify(p), key])).rows[0].id;
      return (await c.query(`select r.id, j.doc_no as "docNo", r.total::text from acc.petty_cash_reimbursements r
                               join acc.journal_entries j on j.company_id = r.company_id and j.id = r.entry_id
                              where r.company_id = $1 and r.id = $2`, [companyId, id])).rows[0];
    });
    return reply.code(201).send(row);
  });

  app.post('/companies/:companyId/petty-cash/reimbursements/:id/void', async (req) => {
    const { companyId, id } = CashDocParams.parse(req.params);
    const b = VoidDocument.parse(req.body);
    const key = idemKey(req);
    await withUser(pool, await user(req), async (c) => {
      await requireWritable(c, companyId);
      await c.query('select acc.void_petty_cash_reimbursement($1, $2, $3, $4, $5)', [companyId, id, b.date, b.reason, key]);
    });
    return { voided: true };
  });
}
