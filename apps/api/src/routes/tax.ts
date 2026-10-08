import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { withUser } from '../db.js';
import type { AuthAdapter, AuthUser } from '../auth.js';
import { requireReadable, requireUser, requireWritable } from '../guard.js';
import {
  CompanyParams, IdempotencyKey, TaxMonthParams, TaxMonthQuery, TaxPayment, VatClosingParams, VoidVatClose, WhtRemitParams,
} from '../schemas.js';

// เฟส 2.4 ภาษี: ชั้นบาง → acc.vat_report / close_vat_month / void_vat_close / pay_vat / remit_wht (กติกาอยู่ใน DB)

/** เดือนที่ขอ หรือเดือนปัจจุบันตามเวลาไทย เป็นวันแรกของเดือน */
async function monthStart(c: pg.PoolClient, month: string | undefined) {
  if (month) return `${month}-01`;
  return (await c.query(`select to_char(now() at time zone 'Asia/Bangkok', 'YYYY-MM-01') d`)).rows[0].d as string;
}

const COMPANY = `select name, tax_id as "taxId", branch_no as "branchNo", address, vat_registered as "vatRegistered",
  app.can_write_company(id) as "canWrite", app.company_locked(id) as locked from acc.companies where id = $1`;
const CASH = `select code, name from acc.chart_of_accounts where company_id = $1 and active and type = 'asset' and left(code, 2) = '11' order by code`;
const CLOSING = `select c.id, to_char(c.month, 'YYYY-MM') as month, c.output_vat::text as "outputVat", c.input_vat::text as "inputVat",
  c.carry_used::text as "carryUsed", c.payable::text, c.refundable::text, e.doc_no as "entryDocNo", c.entry_id as "entryId",
  p.doc_no as "paidDocNo", to_char(p.entry_date, 'YYYY-MM-DD') as "paidDate", c.paid_entry_id as "paidEntryId",
  c.voided_at as "voidedAt", c.void_reason as "voidReason", v.doc_no as "voidDocNo", c.created_at as "createdAt"
  from acc.vat_closings c
  left join acc.journal_entries e on e.company_id = c.company_id and e.id = c.entry_id
  left join acc.journal_entries p on p.company_id = c.company_id and p.id = c.paid_entry_id
  left join acc.journal_entries v on v.company_id = c.company_id and v.id = c.void_entry_id`;
const ROW = `to_char(row_date, 'YYYY-MM-DD') as date, document_id as "documentId", doc_no as "docNo", ref_no as "refNo", kind,
  party_name as "partyName", party_tax_id as "partyTaxId", party_branch_no as "partyBranchNo", base::text, vat::text, status`;

export function taxRoutes(app: FastifyInstance, pool: pg.Pool, auth: AuthAdapter) {
  const user = (req: FastifyRequest): Promise<AuthUser> => requireUser(auth, req);
  const idemKey = (req: FastifyRequest) => IdempotencyKey.parse(req.headers['idempotency-key']);

  // รายงานภาษีขาย/ภาษีซื้อ + ภ.พ.30 ของเดือน (ปิดแล้ว = ยอดที่ปิด ยังไม่ปิด = ยอดที่จะปิดจากบัญชีแยกประเภท)
  app.get('/companies/:companyId/tax/vat', async (req) => {
    const { companyId } = CompanyParams.parse(req.params);
    const q = TaxMonthQuery.parse(req.query);
    return withUser(pool, await user(req), async (c) => {
      await requireReadable(c, companyId);
      const m = await monthStart(c, q.month);
      const [company, sales, purchases, preview, closings, cash] = await Promise.all([
        c.query(COMPANY, [companyId]),
        c.query(`select ${ROW} from acc.vat_report($1, $2, 'sales')`, [companyId, m]),
        c.query(`select ${ROW} from acc.vat_report($1, $2, 'purchases')`, [companyId, m]),
        c.query(`with b as (select $2::date as s, ($2::date + interval '1 month - 1 day')::date as e)
                 select (-acc.account_movement($1, '2210', b.s, b.e))::text as "outputVat", acc.account_movement($1, '1410', b.s, b.e)::text as "inputVat",
                        greatest(acc.account_movement($1, '1430', null, b.e), 0)::text as "carryAvailable",
                        (acc.account_movement($1, '2210', null, b.s - 1) <> 0 or acc.account_movement($1, '1410', null, b.s - 1) <> 0) as "earlierOpen",
                        exists (select 1 from acc.vat_closings x where x.company_id = $1 and x.month > b.s and x.voided_at is null) as "laterClosed"
                   from b`, [companyId, m]),
        c.query(`${CLOSING} where c.company_id = $1 order by c.month desc, c.created_at desc limit 36`, [companyId]),
        c.query(CASH, [companyId]),
      ]);
      const month = m.slice(0, 7);
      const p = preview.rows[0];
      const net = Math.round(Number(p.outputVat) * 100) - Math.round(Number(p.inputVat) * 100);
      const carry = Math.min(Math.round(Number(p.carryAvailable) * 100), Math.max(net, 0));
      const cents = (n: number) => (n / 100).toFixed(2);
      return {
        month, company: company.rows[0], sales: sales.rows, purchases: purchases.rows,
        closing: closings.rows.find((x) => x.month === month && !x.voidedAt) ?? null,
        preview: {
          outputVat: p.outputVat, inputVat: p.inputVat, carryAvailable: p.carryAvailable, carryUsed: cents(carry),
          payable: cents(Math.max(net - carry, 0)), refundable: cents(Math.max(-net, 0)),
          earlierOpen: p.earlierOpen, laterClosed: p.laterClosed,
        },
        history: closings.rows, cashAccounts: cash.rows,
      };
    });
  });

  app.post('/companies/:companyId/tax/vat/:month/close', async (req, reply) => {
    const { companyId, month } = TaxMonthParams.parse(req.params);
    const key = idemKey(req);
    const row = await withUser(pool, await user(req), async (c) => {
      await requireWritable(c, companyId);
      const id = (await c.query('select acc.close_vat_month($1, $2, $3) id', [companyId, `${month}-01`, key])).rows[0].id;
      return (await c.query(`${CLOSING} where c.company_id = $1 and c.id = $2`, [companyId, id])).rows[0];
    });
    return reply.code(201).send(row);
  });

  app.post('/companies/:companyId/tax/vat/closings/:closingId/void', async (req) => {
    const { companyId, closingId } = VatClosingParams.parse(req.params);
    const b = VoidVatClose.parse(req.body);
    const key = idemKey(req);
    return withUser(pool, await user(req), async (c) => {
      await requireWritable(c, companyId);
      await c.query('select acc.void_vat_close($1, $2, $3, $4)', [companyId, closingId, b.reason, key]);
      return (await c.query(`${CLOSING} where c.company_id = $1 and c.id = $2`, [companyId, closingId])).rows[0];
    });
  });

  app.post('/companies/:companyId/tax/vat/closings/:closingId/pay', async (req) => {
    const { companyId, closingId } = VatClosingParams.parse(req.params);
    const b = TaxPayment.parse(req.body);
    const key = idemKey(req);
    return withUser(pool, await user(req), async (c) => {
      await requireWritable(c, companyId);
      await c.query('select acc.pay_vat($1, $2, $3::date, $4, $5)', [companyId, closingId, b.date, b.cashAccount ?? null, key]);
      return (await c.query(`${CLOSING} where c.company_id = $1 and c.id = $2`, [companyId, closingId])).rows[0];
    });
  });

  // ภ.ง.ด.3 / ภ.ง.ด.53 ของเดือน: หนังสือรับรอง 50 ทวิ แยกแบบ ยอดรวม และการนำส่ง
  app.get('/companies/:companyId/tax/wht', async (req) => {
    const { companyId } = CompanyParams.parse(req.params);
    const q = TaxMonthQuery.parse(req.query);
    return withUser(pool, await user(req), async (c) => {
      await requireReadable(c, companyId);
      const m = await monthStart(c, q.month);
      const [company, certs, remits, cash] = await Promise.all([
        c.query(COMPANY, [companyId]),
        c.query(`select w.cert_no as "certNo", to_char(w.cert_date, 'YYYY-MM-DD') as date, w.form, w.document_id as "documentId",
                        d.doc_no as "docNo", w.payee_name as "payeeName", w.payee_tax_id as "payeeTaxId", w.payee_branch_no as "payeeBranchNo",
                        w.payee_address as "payeeAddress", w.wht_kind as "whtKind", w.wht_rate::text as "whtRate", w.base::text,
                        w.amount::text, w.voided_at is not null as voided
                   from acc.wht_certificates w join acc.purchase_documents d on d.company_id = w.company_id and d.id = w.document_id
                  where w.company_id = $1 and date_trunc('month', w.cert_date) = $2::date order by w.cert_date, w.cert_no`, [companyId, m]),
        c.query(`select r.id, r.form, r.amount::text, r.cert_count as "certCount", e.doc_no as "entryDocNo", r.entry_id as "entryId",
                        to_char(e.entry_date, 'YYYY-MM-DD') as date
                   from acc.wht_remittances r join acc.journal_entries e on e.company_id = r.company_id and e.id = r.entry_id
                  where r.company_id = $1 and r.month = $2::date order by r.form`, [companyId, m]),
        c.query(CASH, [companyId]),
      ]);
      const forms = (['pnd3', 'pnd53'] as const).map((form) => {
        const live = certs.rows.filter((x) => x.form === form && !x.voided);
        const cents = (k: 'base' | 'amount') => (live.reduce((s, x) => s + Math.round(Number(x[k]) * 100), 0) / 100).toFixed(2);
        return { form, count: live.length, base: cents('base'), amount: cents('amount'), remittance: remits.rows.find((r) => r.form === form) ?? null };
      });
      return { month: m.slice(0, 7), company: company.rows[0], certificates: certs.rows, forms, cashAccounts: cash.rows };
    });
  });

  app.post('/companies/:companyId/tax/wht/:month/:form/remit', async (req, reply) => {
    const { companyId, month, form } = WhtRemitParams.parse(req.params);
    const b = TaxPayment.parse(req.body);
    const key = idemKey(req);
    const row = await withUser(pool, await user(req), async (c) => {
      await requireWritable(c, companyId);
      const id = (await c.query('select acc.remit_wht($1, $2, $3, $4::date, $5, $6) id',
        [companyId, `${month}-01`, form, b.date, b.cashAccount ?? null, key])).rows[0].id;
      return (await c.query(`select r.id, r.form, r.amount::text, r.cert_count as "certCount", e.doc_no as "entryDocNo"
                                  from acc.wht_remittances r join acc.journal_entries e on e.company_id = r.company_id and e.id = r.entry_id
                                 where r.company_id = $1 and r.id = $2`, [companyId, id])).rows[0];
    });
    return reply.code(201).send(row);
  });
}
