import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { querySequence, withUser } from '../db.js';
import type { AuthAdapter, AuthUser } from '../auth.js';
import { requireReadable, requireUser, requireWritable } from '../guard.js';
import { HttpError } from '../errors.js';
import {
  BillingNoteParams, CancelWithReason, CompanyParams, IdempotencyKey, NewBillingNote, NewDeposit, NewSalesOrder, PartyFilter,
  SalesOrderListQuery, SalesOrderParams,
} from '../schemas.js';

// เฟส 5 โมดูล 4 (docs/phase5-spec.md ข้อ 4): ใบเสนอราคา ใบสั่งขาย เงินมัดจำ ใบวางบิล — ชั้นบาง Zod → ฟังก์ชันใน DB

const thaiToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

// สถานะใบเสนอราคา/ใบสั่งขาย คำนวณจากเอกสารที่อ้าง (ไม่เก็บซ้ำ)
const ORDER_STATUS = `case
    when o.cancelled_at is not null then 'cancelled'
    when o.kind = 'quotation' then case
      when exists (select 1 from acc.sales_orders s where s.company_id = o.company_id and s.source_id = o.id and s.cancelled_at is null) then 'accepted'
      when o.until_date is not null and o.until_date < $2::date then 'expired' else 'open' end
    else case
      when not exists (select 1 from acc.sales_order_lines l where l.company_id = o.company_id and l.order_id = o.id
                        and acc.sales_order_delivered(o.company_id, o.id, l.line_no) < l.qty) then 'closed'
      when exists (select 1 from acc.sales_order_deliveries x join acc.documents d on d.company_id = x.company_id and d.id = x.document_id
                    where x.company_id = o.company_id and x.order_id = o.id and d.voided_at is null) then 'partial'
      else 'open' end
  end`;
const ORDER = `o.id, o.kind, o.doc_no as "docNo", to_char(o.doc_date, 'YYYY-MM-DD') as date, to_char(o.until_date, 'YYYY-MM-DD') as "untilDate",
  o.party_code as "partyCode", o.party_name as "partyName", o.is_service as "isService", o.price_mode as "priceMode",
  o.vat_rate::text as "vatRate", o.gross::text, o.discount::text, o.base::text, o.vat::text, o.total::text, o.description,
  o.cancel_reason as "cancelReason", ${ORDER_STATUS} as status`;

export function salesFlowRoutes(app: FastifyInstance, pool: pg.Pool, auth: AuthAdapter) {
  const user = (req: FastifyRequest): Promise<AuthUser> => requireUser(auth, req);
  const idemKey = (req: FastifyRequest) => IdempotencyKey.parse(req.headers['idempotency-key']);

  // ---- ใบเสนอราคา / ใบสั่งขาย ----
  app.post('/companies/:companyId/sales-orders', async (req, reply) => {
    const { companyId } = CompanyParams.parse(req.params);
    const b = NewSalesOrder.parse(req.body);
    const key = idemKey(req);
    const p = {
      date: b.date, party_code: b.partyCode, until_date: b.untilDate, source_id: b.sourceId, is_service: b.isService,
      price_mode: b.priceMode, discount: b.discount, description: b.description,
      lines: b.lines.map((l) => ({ item_code: l.itemCode, description: l.description, qty: l.qty, unit: l.unit, unit_price: l.unitPrice })),
    };
    const row = await withUser(pool, await user(req), async (c) => {
      await requireWritable(c, companyId);
      const id = (await c.query('select acc.save_sales_order($1, $2, $3::jsonb, $4) id', [companyId, b.kind, JSON.stringify(p), key])).rows[0].id;
      const doc = (await c.query('select doc_no from acc.sales_orders where company_id = $1 and id = $2', [companyId, id])).rows[0];
      return { id, docNo: doc.doc_no as string };
    });
    return reply.code(201).send(row);
  });

  app.get('/companies/:companyId/sales-orders', async (req) => {
    const { companyId } = CompanyParams.parse(req.params);
    const q = SalesOrderListQuery.parse(req.query);
    return withUser(pool, await user(req), async (c) => {
      await requireReadable(c, companyId);
      return (await c.query(
        `select ${ORDER} from acc.sales_orders o
          where o.company_id = $1 and ($3::text is null or o.kind = $3) and ($4::text is null or o.party_code = $4)
          order by o.doc_date desc, o.doc_no desc limit 500`, [companyId, thaiToday(), q.kind ?? null, q.party ?? null])).rows;
    });
  });

  app.get('/companies/:companyId/sales-orders/:orderId', async (req) => {
    const { companyId, orderId } = SalesOrderParams.parse(req.params);
    return withUser(pool, await user(req), async (c) => {
      await requireReadable(c, companyId);
      const o = (await c.query(
        `select ${ORDER}, o.party_tax_id as "partyTaxId", o.party_branch_no as "partyBranchNo", o.party_address as "partyAddress",
                co.name as "sellerName", co.tax_id as "sellerTaxId", co.branch_no as "sellerBranchNo", co.address as "sellerAddress",
                case when src.id is null then null else json_build_object('id', src.id, 'docNo', src.doc_no) end as source
           from acc.sales_orders o join acc.companies co on co.id = o.company_id
           left join acc.sales_orders src on src.company_id = o.company_id and src.id = o.source_id
          where o.company_id = $1 and o.id = $3`, [companyId, thaiToday(), orderId])).rows[0];
      if (!o) throw new HttpError(404, 'not_found', 'ไม่พบเอกสารนี้');
      const [lines, invoices, deposits, orders] = await querySequence([
        () => c.query(`select l.line_no as "lineNo", i.code as "itemCode", l.description, l.qty::text, l.unit, l.unit_price::text as "unitPrice",
                        l.amount::text, acc.sales_order_delivered(l.company_id, l.order_id, l.line_no)::text as delivered
                   from acc.sales_order_lines l left join acc.items i on i.company_id = l.company_id and i.id = l.item_id
                  where l.company_id = $1 and l.order_id = $2 order by l.line_no`, [companyId, orderId]),
        () => c.query(`select distinct d.id, d.doc_no as "docNo", to_char(d.doc_date, 'YYYY-MM-DD') as date, d.total::text, d.voided_at is not null as voided
                   from acc.sales_order_deliveries x join acc.documents d on d.company_id = x.company_id and d.id = x.document_id
                  where x.company_id = $1 and x.order_id = $2 order by 2`, [companyId, orderId]),
        () => c.query(`select d.id, d.doc_no as "docNo", to_char(d.doc_date, 'YYYY-MM-DD') as date, d.total::text, d.voided_at is not null as voided,
                        (select amount::text from acc.deposit_remaining(d.company_id, d.id)) as remaining
                   from acc.documents d where d.company_id = $1 and d.sales_order_id = $2 and d.kind = 'deposit' order by d.doc_no`, [companyId, orderId]),
        () => c.query(`select s.id, s.doc_no as "docNo", s.cancelled_at is not null as cancelled
                   from acc.sales_orders s where s.company_id = $1 and s.source_id = $2 order by s.doc_no`, [companyId, orderId]),
      ] as const);
      await c.query('select app.log_company_view($1)', [companyId]);
      return { ...o, lines: lines.rows, invoices: invoices.rows, deposits: deposits.rows, orders: orders.rows };
    });
  });

  app.post('/companies/:companyId/sales-orders/:orderId/cancel', async (req) => {
    const { companyId, orderId } = SalesOrderParams.parse(req.params);
    const { reason } = CancelWithReason.parse(req.body);
    await withUser(pool, await user(req), async (c) => {
      await requireWritable(c, companyId);
      await c.query('select acc.cancel_sales_order($1, $2, $3)', [companyId, orderId, reason]);
    });
    return { cancelled: true };
  });

  // ---- รับเงินมัดจำ ----
  app.post('/companies/:companyId/sales/deposit', async (req, reply) => {
    const { companyId } = CompanyParams.parse(req.params);
    const b = NewDeposit.parse(req.body);
    const key = idemKey(req);
    const p = { date: b.date, party_code: b.partyCode, amount: b.amount, price_mode: b.priceMode, is_service: b.isService,
      cash_account: b.cashAccount, order_id: b.orderId, description: b.description };
    const row = await withUser(pool, await user(req), async (c) => {
      await requireWritable(c, companyId);
      const id = (await c.query('select acc.post_sales_deposit($1, $2::jsonb, $3) id', [companyId, JSON.stringify(p), key])).rows[0].id;
      const doc = (await c.query('select doc_no from acc.documents where company_id = $1 and id = $2', [companyId, id])).rows[0];
      return { id, docNo: doc.doc_no as string };
    });
    return reply.code(201).send(row);
  });

  // เงินมัดจำที่ยังหักไม่หมด (ฟอร์มขายเชื่อใช้เลือกหัก)
  app.get('/companies/:companyId/deposits', async (req) => {
    const { companyId } = CompanyParams.parse(req.params);
    const { party } = PartyFilter.parse(req.query);
    return withUser(pool, await user(req), async (c) => {
      await requireReadable(c, companyId);
      return (await c.query(
        `select d.id, d.doc_no as "docNo", to_char(d.doc_date, 'YYYY-MM-DD') as date, d.party_code as "partyCode", d.party_name as "partyName",
                d.total::text, d.vat::text, r.amount::text as remaining, o.doc_no as "orderDocNo", d.sales_order_id as "orderId"
           from acc.documents d cross join lateral acc.deposit_remaining(d.company_id, d.id) r
           left join acc.sales_orders o on o.company_id = d.company_id and o.id = d.sales_order_id
          where d.company_id = $1 and d.kind = 'deposit' and d.voided_at is null and r.amount > 0
            and ($2::text is null or d.party_code = $2)
          order by d.doc_date, d.doc_no`, [companyId, party ?? null])).rows;
    });
  });

  // ---- ใบวางบิล ----
  app.post('/companies/:companyId/billing-notes', async (req, reply) => {
    const { companyId } = CompanyParams.parse(req.params);
    const b = NewBillingNote.parse(req.body);
    const key = idemKey(req);
    const p = { date: b.date, party_code: b.partyCode, due_date: b.dueDate, document_ids: b.documentIds, description: b.description };
    const row = await withUser(pool, await user(req), async (c) => {
      await requireWritable(c, companyId);
      const id = (await c.query('select acc.create_billing_note($1, $2::jsonb, $3) id', [companyId, JSON.stringify(p), key])).rows[0].id;
      const doc = (await c.query('select doc_no from acc.billing_notes where company_id = $1 and id = $2', [companyId, id])).rows[0];
      return { id, docNo: doc.doc_no as string };
    });
    return reply.code(201).send(row);
  });

  const NOTE = `n.id, n.doc_no as "docNo", to_char(n.doc_date, 'YYYY-MM-DD') as date, to_char(n.due_date, 'YYYY-MM-DD') as "dueDate",
    n.party_code as "partyCode", n.party_name as "partyName", n.total::text, n.description, n.cancel_reason as "cancelReason",
    (select coalesce(sum(greatest(t.total - s.amount, 0)), 0)::text from acc.billing_note_items i
       join acc.documents t on t.company_id = i.company_id and t.id = i.document_id
       cross join lateral acc.document_settled(t.company_id, t.id) s
      where i.company_id = n.company_id and i.note_id = n.id and t.voided_at is null) as open,
    case when n.cancelled_at is not null then 'cancelled'
         when not exists (select 1 from acc.billing_note_items i join acc.documents t on t.company_id = i.company_id and t.id = i.document_id
                           cross join lateral acc.document_settled(t.company_id, t.id) s
                          where i.company_id = n.company_id and i.note_id = n.id and t.voided_at is null and t.total - s.amount > 0) then 'paid'
         else 'open' end as status`;

  app.get('/companies/:companyId/billing-notes', async (req) => {
    const { companyId } = CompanyParams.parse(req.params);
    const { party } = PartyFilter.parse(req.query);
    return withUser(pool, await user(req), async (c) => {
      await requireReadable(c, companyId);
      return (await c.query(`select ${NOTE} from acc.billing_notes n where n.company_id = $1 and ($2::text is null or n.party_code = $2)
                              order by n.doc_date desc, n.doc_no desc limit 500`, [companyId, party ?? null])).rows;
    });
  });

  app.get('/companies/:companyId/billing-notes/:noteId', async (req) => {
    const { companyId, noteId } = BillingNoteParams.parse(req.params);
    return withUser(pool, await user(req), async (c) => {
      await requireReadable(c, companyId);
      const n = (await c.query(
        `select ${NOTE}, n.party_tax_id as "partyTaxId", n.party_branch_no as "partyBranchNo", n.party_address as "partyAddress",
                co.name as "sellerName", co.tax_id as "sellerTaxId", co.branch_no as "sellerBranchNo", co.address as "sellerAddress"
           from acc.billing_notes n join acc.companies co on co.id = n.company_id where n.company_id = $1 and n.id = $2`, [companyId, noteId])).rows[0];
      if (!n) throw new HttpError(404, 'not_found', 'ไม่พบใบวางบิลนี้');
      const items = (await c.query(
        `select t.id, t.doc_no as "docNo", to_char(t.doc_date, 'YYYY-MM-DD') as date, to_char(t.due_date, 'YYYY-MM-DD') as "dueDate",
                i.amount::text, (case when t.voided_at is null then t.total - s.amount else 0 end)::text as open
           from acc.billing_note_items i join acc.documents t on t.company_id = i.company_id and t.id = i.document_id
           cross join lateral acc.document_settled(t.company_id, t.id) s
          where i.company_id = $1 and i.note_id = $2 order by t.doc_date, t.doc_no`, [companyId, noteId])).rows;
      await c.query('select app.log_company_view($1)', [companyId]);
      return { ...n, items };
    });
  });

  app.post('/companies/:companyId/billing-notes/:noteId/cancel', async (req) => {
    const { companyId, noteId } = BillingNoteParams.parse(req.params);
    const { reason } = CancelWithReason.parse(req.body);
    await withUser(pool, await user(req), async (c) => {
      await requireWritable(c, companyId);
      await c.query('select acc.cancel_billing_note($1, $2, $3)', [companyId, noteId, reason]);
    });
    return { cancelled: true };
  });
}
