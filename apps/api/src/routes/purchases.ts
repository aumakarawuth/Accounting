import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { withUser } from '../db.js';
import type { AuthAdapter, AuthUser } from '../auth.js';
import { requireReadable, requireUser, requireWritable } from '../guard.js';
import { HttpError } from '../errors.js';
import { agingReport } from './aging.js';
import {
  AsOfQuery, CompanyParams, DocumentParams, IdempotencyKey, NewPayment, NewPurchaseDocument, PURCHASE_KIND_SQL, PurchaseKindParams,
  PurchaseListQuery, VoidDocument,
} from '../schemas.js';

// เฟส 2.3 ซื้อ: ชั้นบาง Zod → acc.post_purchase_document / post_payment / void_purchase_document (กติกาบัญชีอยู่ใน DB)

const DOC = `d.id, d.kind, d.doc_no as "docNo", to_char(d.doc_date, 'YYYY-MM-DD') as date, d.vendor_doc_no as "vendorDocNo",
  d.party_code as "partyCode", d.party_name as "partyName", d.is_service as "isService", d.vat_claimable as "vatClaimable",
  d.price_mode as "priceMode", d.vat_rate::text as "vatRate", d.gross::text, d.discount::text, d.base::text, d.vat::text,
  d.total::text, d.wht_kind as "whtKind", d.wht_rate::text as "whtRate", d.wht_base::text as "whtBase",
  d.wht_amount::text as "whtAmount", d.credit_days as "creditDays", to_char(d.due_date, 'YYYY-MM-DD') as "dueDate",
  d.ref_document_id as "refDocumentId", d.reason, d.description, d.voided_at as "voidedAt", d.void_reason as "voidReason"`;

export function purchaseRoutes(app: FastifyInstance, pool: pg.Pool, auth: AuthAdapter) {
  const user = (req: FastifyRequest): Promise<AuthUser> => requireUser(auth, req);
  const idemKey = (req: FastifyRequest) => IdempotencyKey.parse(req.headers['idempotency-key']);
  const docNo = async (c: pg.PoolClient, companyId: string, id: string) =>
    (await c.query('select doc_no from acc.purchase_documents where company_id = $1 and id = $2', [companyId, id])).rows[0].doc_no as string;

  // ข้อมูลที่ฟอร์มเอกสารซื้อ/จ่ายชำระต้องใช้ในครั้งเดียว
  app.get('/companies/:companyId/purchases/form', async (req) => {
    const { companyId } = CompanyParams.parse(req.params);
    return withUser(pool, await user(req), async (c) => {
      await requireReadable(c, companyId);
      const [company, vendors, items, accounts] = await Promise.all([
        c.query(`select name, tax_id as "taxId", branch_no as "branchNo", address, vat_registered as "vatRegistered", vat_rate::text as "vatRate",
                        app.can_write_company(id) as "canWrite", app.company_locked(id) as locked from acc.companies where id = $1`, [companyId]),
        c.query(`select code, name, credit_days as "creditDays", vat_registered as "vatRegistered", tax_id as "taxId",
                        branch_no as "branchNo", address, wht_kind as "whtKind", wht_rate::text as "whtRate"
                   from acc.parties where company_id = $1 and is_vendor and active order by code`, [companyId]),
        c.query(`select i.code, i.name, i.unit, i.is_service as "isService", i.purchase_price::text as "purchasePrice", a.code as "purchaseAccount"
                   from acc.items i left join acc.chart_of_accounts a on a.company_id = i.company_id and a.id = i.purchase_account_id
                  where i.company_id = $1 and i.active order by i.code`, [companyId]),
        c.query(`select code, name, type from acc.chart_of_accounts
                  where company_id = $1 and active and (type = 'expense' or (type = 'asset' and left(code, 2) in ('11', '13', '15', '16')))
                  order by code`, [companyId]),
      ]);
      return {
        company: company.rows[0], vendors: vendors.rows, items: items.rows,
        expenseAccounts: accounts.rows.filter((a) => !a.code.startsWith('11')).map(({ code, name }) => ({ code, name })),
        cashAccounts: accounts.rows.filter((a) => a.code.startsWith('11')).map(({ code, name }) => ({ code, name })),
      };
    });
  });

  app.post('/companies/:companyId/purchases/:kind', async (req, reply) => {
    const { companyId, kind } = PurchaseKindParams.parse(req.params);
    const b = NewPurchaseDocument.parse(req.body);
    if (kind === 'credit-note' ? !b.refDocumentId : !b.partyCode) {
      throw new HttpError(400, 'invalid', kind === 'credit-note' ? 'ต้องเลือกใบซื้อเชื่อที่อ้างถึง' : 'ต้องเลือกผู้ขาย');
    }
    const key = idemKey(req);
    const payload = {
      date: b.date, party_code: b.partyCode, vendor_doc_no: b.vendorDocNo, is_service: b.isService, price_mode: b.priceMode,
      discount: b.discount, description: b.description, credit_days: b.creditDays, cash_account: b.cashAccount,
      wht_kind: b.whtKind, wht_rate: b.whtRate, ref_document_id: b.refDocumentId, reason: b.reason,
      lines: b.lines.map((l) => ({ item_code: l.itemCode, description: l.description, qty: l.qty, unit: l.unit, unit_price: l.unitPrice, account_code: l.accountCode })),
    };
    const row = await withUser(pool, await user(req), async (c) => {
      await requireWritable(c, companyId);
      const id = (await c.query('select acc.post_purchase_document($1, $2, $3::jsonb, $4) id', [companyId, PURCHASE_KIND_SQL[kind], JSON.stringify(payload), key])).rows[0].id;
      return { id, docNo: await docNo(c, companyId, id) };
    });
    return reply.code(201).send(row);
  });

  app.post('/companies/:companyId/payments', async (req, reply) => {
    const { companyId } = CompanyParams.parse(req.params);
    const b = NewPayment.parse(req.body);
    const key = idemKey(req);
    const payload = {
      date: b.date, party_code: b.partyCode, cash_account: b.cashAccount, wht_kind: b.whtKind, wht_rate: b.whtRate, description: b.description,
      allocations: b.allocations.map((a) => ({ document_id: a.documentId, amount: a.amount })),
    };
    const row = await withUser(pool, await user(req), async (c) => {
      await requireWritable(c, companyId);
      const id = (await c.query('select acc.post_payment($1, $2::jsonb, $3) id', [companyId, JSON.stringify(payload), key])).rows[0].id;
      return { id, docNo: await docNo(c, companyId, id) };
    });
    return reply.code(201).send(row);
  });

  app.get('/companies/:companyId/purchases', async (req) => {
    const { companyId } = CompanyParams.parse(req.params);
    const q = PurchaseListQuery.parse(req.query);
    return withUser(pool, await user(req), async (c) => {
      await requireReadable(c, companyId);
      const r = await c.query(
        `select ${DOC}, case when d.kind = 'purchase_invoice' and d.voided_at is null then (d.total - s.amount)::text end as open
           from acc.purchase_documents d cross join lateral acc.purchase_settled(d.company_id, d.id) s
          where d.company_id = $1 and ($2::text is null or d.kind = $2) and ($3::text is null or d.party_code = $3)
            and ($4::text is null or to_char(d.doc_date, 'YYYY-MM') = $4)
          order by d.doc_date desc, d.doc_no desc limit 500`,
        [companyId, q.kind ?? null, q.party ?? null, q.month ?? null]);
      return r.rows;
    });
  });

  // เอกสารเดียว: บรรทัด รายการบัญชีที่สร้าง ตัดยอด/ถูกตัดยอด ใบลดหนี้ที่อ้าง 50 ทวิ และข้อมูลบริษัทสำหรับหัวใบสำคัญจ่าย
  app.get('/companies/:companyId/purchases/documents/:documentId', async (req) => {
    const { companyId, documentId } = DocumentParams.parse(req.params);
    return withUser(pool, await user(req), async (c) => {
      await requireReadable(c, companyId);
      const d = (await c.query(
        `select ${DOC}, d.party_tax_id as "partyTaxId", d.party_branch_no as "partyBranchNo", d.party_address as "partyAddress",
                co.name as "companyName", co.tax_id as "companyTaxId", co.branch_no as "companyBranchNo", co.address as "companyAddress",
                ca.code as "cashAccount", ca.name as "cashAccountName", e.id as "entryId", e.doc_no as "entryDocNo",
                ve.doc_no as "voidDocNo", r.doc_no as "refDocNo", (d.total - s.amount)::text as open
           from acc.purchase_documents d
           join acc.companies co on co.id = d.company_id
           join acc.journal_entries e on e.company_id = d.company_id and e.id = d.entry_id
           left join acc.journal_entries ve on ve.company_id = d.company_id and ve.id = d.void_entry_id
           left join acc.purchase_documents r on r.company_id = d.company_id and r.id = d.ref_document_id
           left join acc.chart_of_accounts ca on ca.company_id = d.company_id and ca.id = d.cash_account_id
           cross join lateral acc.purchase_settled(d.company_id, d.id) s
          where d.company_id = $1 and d.id = $2`, [companyId, documentId])).rows[0];
      if (!d) throw new HttpError(404, 'not_found', 'ไม่พบเอกสารนี้');
      const [lines, settles, settledBy, notes, cert] = await Promise.all([
        c.query(`select l.line_no as "lineNo", l.description, l.qty::text, l.unit, l.unit_price::text as "unitPrice", l.amount::text,
                        a.code as "accountCode", a.name as "accountName"
                   from acc.purchase_document_lines l join acc.chart_of_accounts a on a.company_id = l.company_id and a.id = l.account_id
                  where l.company_id = $1 and l.document_id = $2 order by l.line_no`, [companyId, documentId]),
        c.query(`select t.id, t.doc_no as "docNo", t.vendor_doc_no as "vendorDocNo", a.amount::text, a.vat_transfer::text as "vatTransfer"
                   from acc.purchase_allocations a join acc.purchase_documents t on t.company_id = a.company_id and t.id = a.target_id
                  where a.company_id = $1 and a.source_id = $2 order by a.id`, [companyId, documentId]),
        c.query(`select s.id, s.kind, s.doc_no as "docNo", to_char(s.doc_date, 'YYYY-MM-DD') as date, a.amount::text, s.voided_at is not null as voided
                   from acc.purchase_allocations a join acc.purchase_documents s on s.company_id = a.company_id and s.id = a.source_id
                  where a.company_id = $1 and a.target_id = $2 order by s.doc_date, s.doc_no`, [companyId, documentId]),
        c.query(`select x.id, x.kind, x.doc_no as "docNo", x.total::text, x.voided_at is not null as voided
                   from acc.purchase_documents x where x.company_id = $1 and x.ref_document_id = $2 order by x.doc_no`, [companyId, documentId]),
        c.query(`select w.cert_no as "certNo", to_char(w.cert_date, 'YYYY-MM-DD') as date, w.form, w.payer_name as "payerName",
                        w.payer_tax_id as "payerTaxId", w.payer_branch_no as "payerBranchNo", w.payer_address as "payerAddress",
                        w.payee_name as "payeeName", w.payee_tax_id as "payeeTaxId", w.payee_branch_no as "payeeBranchNo",
                        w.payee_address as "payeeAddress", w.wht_kind as "whtKind", w.wht_rate::text as "whtRate", w.base::text,
                        w.amount::text, w.voided_at is not null as voided
                   from acc.wht_certificates w where w.company_id = $1 and w.document_id = $2`, [companyId, documentId]),
      ]);
      await c.query('select app.log_company_view($1)', [companyId]);
      return {
        ...d, open: d.kind === 'purchase_invoice' && !d.voidedAt ? d.open : null,
        lines: lines.rows, settles: settles.rows, settledBy: settledBy.rows, notes: notes.rows, certificate: cert.rows[0] ?? null,
      };
    });
  });

  app.post('/companies/:companyId/purchases/documents/:documentId/void', async (req) => {
    const { companyId, documentId } = DocumentParams.parse(req.params);
    const b = VoidDocument.parse(req.body);
    const key = idemKey(req);
    return withUser(pool, await user(req), async (c) => {
      await requireWritable(c, companyId);
      const rv = (await c.query('select acc.void_purchase_document($1, $2, $3::date, $4, $5) id', [companyId, documentId, b.date, b.reason, key])).rows[0].id;
      const e = (await c.query('select doc_no from acc.journal_entries where company_id = $1 and id = $2', [companyId, rv])).rows[0];
      return { voidEntryId: rv, voidDocNo: e.doc_no as string };
    });
  });

  // เจ้าหนี้คงค้างและอายุหนี้ ณ วันที่
  app.get('/companies/:companyId/payables', async (req) => {
    const { companyId } = CompanyParams.parse(req.params);
    const { asOf } = AsOfQuery.parse(req.query);
    return withUser(pool, await user(req), async (c) => {
      await requireReadable(c, companyId);
      return agingReport(c, 'acc.ap_open_items', companyId, asOf);
    });
  });
}
