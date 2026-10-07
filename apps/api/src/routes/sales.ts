import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { withUser } from '../db.js';
import type { AuthAdapter, AuthUser } from '../auth.js';
import { requireReadable, requireUser, requireWritable } from '../guard.js';
import { HttpError } from '../errors.js';
import {
  AsOfQuery, CompanyParams, DocumentParams, IdempotencyKey, NewReceipt, NewSalesDocument, SALES_KIND_SQL, SalesKindParams,
  SalesListQuery, VoidDocument,
} from '../schemas.js';

// เฟส 2.2 ขาย: ชั้นบาง Zod → acc.post_sales_document / post_receipt / void_document (กติกาบัญชีอยู่ใน DB)

const DOC = `d.id, d.kind, d.doc_no as "docNo", to_char(d.doc_date, 'YYYY-MM-DD') as date, d.party_code as "partyCode",
  d.party_name as "partyName", d.is_service as "isService", d.is_tax_invoice as "isTaxInvoice", d.price_mode as "priceMode",
  d.vat_rate::text as "vatRate", d.gross::text, d.discount::text, d.base::text, d.vat::text, d.total::text,
  d.wht_amount::text as "whtAmount", d.credit_days as "creditDays", to_char(d.due_date, 'YYYY-MM-DD') as "dueDate",
  d.ref_document_id as "refDocumentId", d.reason, d.description, d.voided_at as "voidedAt", d.void_reason as "voidReason"`;

export function salesRoutes(app: FastifyInstance, pool: pg.Pool, auth: AuthAdapter) {
  const user = (req: FastifyRequest): Promise<AuthUser> => requireUser(auth, req);
  const idemKey = (req: FastifyRequest) => IdempotencyKey.parse(req.headers['idempotency-key']);
  const docNo = async (c: pg.PoolClient, companyId: string, id: string) =>
    (await c.query('select doc_no from acc.documents where company_id = $1 and id = $2', [companyId, id])).rows[0].doc_no as string;

  // ข้อมูลที่ฟอร์มเอกสารขายต้องใช้ในครั้งเดียว (มือถือโหลดหน้าเดียวจบ)
  app.get('/companies/:companyId/sales/form', async (req) => {
    const { companyId } = CompanyParams.parse(req.params);
    return withUser(pool, await user(req), async (c) => {
      await requireReadable(c, companyId);
      const [company, customers, items, accounts] = await Promise.all([
        c.query(`select name, tax_id as "taxId", branch_no as "branchNo", address, vat_registered as "vatRegistered", vat_rate::text as "vatRate",
                        app.can_write_company(id) as "canWrite", app.company_locked(id) as locked from acc.companies where id = $1`, [companyId]),
        c.query(`select code, name, credit_days as "creditDays", vat_registered as "vatRegistered", tax_id as "taxId",
                        branch_no as "branchNo", address from acc.parties where company_id = $1 and is_customer and active order by code`, [companyId]),
        c.query(`select i.code, i.name, i.unit, i.is_service as "isService", i.sale_price::text as "salePrice", a.code as "salesAccount"
                   from acc.items i left join acc.chart_of_accounts a on a.company_id = i.company_id and a.id = i.sales_account_id
                  where i.company_id = $1 and i.active order by i.code`, [companyId]),
        c.query(`select code, name, type from acc.chart_of_accounts
                  where company_id = $1 and active and (type = 'revenue' or (type = 'asset' and code like '11%')) order by code`, [companyId]),
      ]);
      return {
        company: company.rows[0], customers: customers.rows, items: items.rows,
        revenueAccounts: accounts.rows.filter((a) => a.type === 'revenue').map(({ code, name }) => ({ code, name })),
        cashAccounts: accounts.rows.filter((a) => a.type === 'asset').map(({ code, name }) => ({ code, name })),
      };
    });
  });

  app.post('/companies/:companyId/sales/:kind', async (req, reply) => {
    const { companyId, kind } = SalesKindParams.parse(req.params);
    const b = NewSalesDocument.parse(req.body);
    if ((kind === 'credit-note' || kind === 'debit-note') ? !b.refDocumentId : !b.partyCode) {
      throw new HttpError(400, 'invalid', kind.endsWith('note') ? 'ต้องเลือกใบขายเชื่อที่อ้างถึง' : 'ต้องเลือกลูกค้า');
    }
    const key = idemKey(req);
    const payload = {
      date: b.date, party_code: b.partyCode, is_service: b.isService, price_mode: b.priceMode, discount: b.discount,
      description: b.description, credit_days: b.creditDays, cash_account: b.cashAccount, wht_amount: b.whtAmount,
      ref_document_id: b.refDocumentId, reason: b.reason,
      lines: b.lines.map((l) => ({ item_code: l.itemCode, description: l.description, qty: l.qty, unit: l.unit, unit_price: l.unitPrice, account_code: l.accountCode })),
    };
    const row = await withUser(pool, await user(req), async (c) => {
      await requireWritable(c, companyId);
      const id = (await c.query('select acc.post_sales_document($1, $2, $3::jsonb, $4) id', [companyId, SALES_KIND_SQL[kind], JSON.stringify(payload), key])).rows[0].id;
      return { id, docNo: await docNo(c, companyId, id) };
    });
    return reply.code(201).send(row);
  });

  app.post('/companies/:companyId/receipts', async (req, reply) => {
    const { companyId } = CompanyParams.parse(req.params);
    const b = NewReceipt.parse(req.body);
    const key = idemKey(req);
    const payload = {
      date: b.date, party_code: b.partyCode, cash_account: b.cashAccount, wht_amount: b.whtAmount, description: b.description,
      allocations: b.allocations.map((a) => ({ document_id: a.documentId, amount: a.amount })),
    };
    const row = await withUser(pool, await user(req), async (c) => {
      await requireWritable(c, companyId);
      const id = (await c.query('select acc.post_receipt($1, $2::jsonb, $3) id', [companyId, JSON.stringify(payload), key])).rows[0].id;
      return { id, docNo: await docNo(c, companyId, id) };
    });
    return reply.code(201).send(row);
  });

  app.get('/companies/:companyId/sales', async (req) => {
    const { companyId } = CompanyParams.parse(req.params);
    const q = SalesListQuery.parse(req.query);
    return withUser(pool, await user(req), async (c) => {
      await requireReadable(c, companyId);
      const r = await c.query(
        `select ${DOC}, case when d.kind in ('sales_invoice', 'debit_note') and d.voided_at is null then (d.total - s.amount)::text end as open
           from acc.documents d cross join lateral acc.document_settled(d.company_id, d.id) s
          where d.company_id = $1 and ($2::text is null or d.kind = $2) and ($3::text is null or d.party_code = $3)
            and ($4::text is null or to_char(d.doc_date, 'YYYY-MM') = $4)
          order by d.doc_date desc, d.doc_no desc limit 500`,
        [companyId, q.kind ?? null, q.party ?? null, q.month ?? null]);
      return r.rows;
    });
  });

  // เอกสารเดียว: บรรทัด รายการบัญชีที่สร้าง ตัดยอดอะไร/ถูกตัดด้วยอะไร เอกสารที่อ้าง และข้อมูลผู้ขาย/ลูกค้าตามที่ออก
  app.get('/companies/:companyId/sales/documents/:documentId', async (req) => {
    const { companyId, documentId } = DocumentParams.parse(req.params);
    return withUser(pool, await user(req), async (c) => {
      await requireReadable(c, companyId);
      const d = (await c.query(
        `select ${DOC}, d.party_tax_id as "partyTaxId", d.party_branch_no as "partyBranchNo", d.party_address as "partyAddress",
                d.seller_name as "sellerName", d.seller_tax_id as "sellerTaxId", d.seller_branch_no as "sellerBranchNo",
                d.seller_address as "sellerAddress", ca.code as "cashAccount", e.id as "entryId", e.doc_no as "entryDocNo",
                ve.doc_no as "voidDocNo", r.doc_no as "refDocNo", (d.total - s.amount)::text as open
           from acc.documents d
           join acc.journal_entries e on e.company_id = d.company_id and e.id = d.entry_id
           left join acc.journal_entries ve on ve.company_id = d.company_id and ve.id = d.void_entry_id
           left join acc.documents r on r.company_id = d.company_id and r.id = d.ref_document_id
           left join acc.chart_of_accounts ca on ca.company_id = d.company_id and ca.id = d.cash_account_id
           cross join lateral acc.document_settled(d.company_id, d.id) s
          where d.company_id = $1 and d.id = $2`, [companyId, documentId])).rows[0];
      if (!d) throw new HttpError(404, 'not_found', 'ไม่พบเอกสารนี้');
      const [lines, settles, settledBy, notes] = await Promise.all([
        c.query(`select l.line_no as "lineNo", l.description, l.qty::text, l.unit, l.unit_price::text as "unitPrice", l.amount::text,
                        a.code as "accountCode", a.name as "accountName"
                   from acc.document_lines l join acc.chart_of_accounts a on a.company_id = l.company_id and a.id = l.account_id
                  where l.company_id = $1 and l.document_id = $2 order by l.line_no`, [companyId, documentId]),
        c.query(`select t.id, t.doc_no as "docNo", a.amount::text, a.vat_transfer::text as "vatTransfer"
                   from acc.allocations a join acc.documents t on t.company_id = a.company_id and t.id = a.target_id
                  where a.company_id = $1 and a.source_id = $2 order by a.id`, [companyId, documentId]),
        c.query(`select s.id, s.kind, s.doc_no as "docNo", to_char(s.doc_date, 'YYYY-MM-DD') as date, a.amount::text, s.voided_at is not null as voided
                   from acc.allocations a join acc.documents s on s.company_id = a.company_id and s.id = a.source_id
                  where a.company_id = $1 and a.target_id = $2 order by s.doc_date, s.doc_no`, [companyId, documentId]),
        c.query(`select x.id, x.kind, x.doc_no as "docNo", x.total::text, x.voided_at is not null as voided
                   from acc.documents x where x.company_id = $1 and x.ref_document_id = $2 order by x.doc_no`, [companyId, documentId]),
      ]);
      await c.query('select app.log_company_view($1)', [companyId]);
      const settledApplies = d.kind === 'sales_invoice' || d.kind === 'debit_note';
      return { ...d, open: settledApplies && !d.voidedAt ? d.open : null, lines: lines.rows, settles: settles.rows, settledBy: settledBy.rows, notes: notes.rows };
    });
  });

  app.post('/companies/:companyId/sales/documents/:documentId/void', async (req) => {
    const { companyId, documentId } = DocumentParams.parse(req.params);
    const b = VoidDocument.parse(req.body);
    const key = idemKey(req);
    return withUser(pool, await user(req), async (c) => {
      await requireWritable(c, companyId);
      const rv = (await c.query('select acc.void_document($1, $2, $3::date, $4, $5) id', [companyId, documentId, b.date, b.reason, key])).rows[0].id;
      const e = (await c.query('select doc_no from acc.journal_entries where company_id = $1 and id = $2', [companyId, rv])).rows[0];
      return { voidEntryId: rv, voidDocNo: e.doc_no as string };
    });
  });

  // ลูกหนี้คงค้างและอายุหนี้ ณ วันที่ (นับจากวันครบกำหนด)
  app.get('/companies/:companyId/receivables', async (req) => {
    const { companyId } = CompanyParams.parse(req.params);
    const { asOf } = AsOfQuery.parse(req.query);
    return withUser(pool, await user(req), async (c) => {
      await requireReadable(c, companyId);
      const day = asOf ?? (await c.query(`select to_char(now() at time zone 'Asia/Bangkok', 'YYYY-MM-DD') d`)).rows[0].d;
      const r = await c.query(
        `select o.document_id as id, o.doc_no as "docNo", o.kind, to_char(o.doc_date, 'YYYY-MM-DD') as date,
                to_char(o.due_date, 'YYYY-MM-DD') as "dueDate", o.party_code as "partyCode", o.party_name as "partyName",
                o.total::text, o.open::text, greatest($2::date - coalesce(o.due_date, o.doc_date), 0) as "daysOverdue",
                case when $2::date <= coalesce(o.due_date, o.doc_date) then 'current'
                     when $2::date - o.due_date <= 30 then 'd30' when $2::date - o.due_date <= 60 then 'd60'
                     when $2::date - o.due_date <= 90 then 'd90' else 'over90' end as bucket
           from acc.ar_open_items($1) o where o.doc_date <= $2::date`, [companyId, day]);
      const buckets = ['current', 'd30', 'd60', 'd90', 'over90'] as const;
      const sum = (rows: { open: string; bucket: string }[], b?: string) =>
        (rows.filter((x) => !b || x.bucket === b).reduce((s, x) => s + BigInt(x.open.replace('.', '')), 0n));
      const cents = (n: bigint) => `${n / 100n}.${(n % 100n).toString().padStart(2, '0')}`;
      const parties = [...new Set(r.rows.map((x) => x.partyCode as string))].sort();
      return {
        asOf: day,
        items: r.rows,
        totals: { all: cents(sum(r.rows)), ...Object.fromEntries(buckets.map((b) => [b, cents(sum(r.rows, b))])) },
        byParty: parties.map((p) => {
          const rows = r.rows.filter((x) => x.partyCode === p);
          return { partyCode: p, partyName: rows[0].partyName, all: cents(sum(rows)), ...Object.fromEntries(buckets.map((b) => [b, cents(sum(rows, b))])) };
        }),
      };
    });
  });
}
