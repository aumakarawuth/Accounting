import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { querySequence, useWarehouse, withUser } from '../db.js';
import type { AuthAdapter, AuthUser } from '../auth.js';
import { requireReadable, requireUser, requireWritable } from '../guard.js';
import { HttpError } from '../errors.js';
import {
  CancelWithReason, CompanyParams, IdempotencyKey, NewGoodsReceipt, NewPurchaseDeposit, NewPurchaseOrder, PartyFilter, PurchaseOrderParams,
} from '../schemas.js';

// เฟส 5 โมดูล 5 (docs/phase5-spec.md ข้อ 5): ใบสั่งซื้อ ใบรับสินค้า เงินมัดจำจ่าย — ชั้นบาง Zod → ฟังก์ชันใน DB

// สถานะใบสั่งซื้อคำนวณจากเอกสารที่รับของ (ไม่เก็บซ้ำ)
const ORDER_STATUS = `case
    when o.cancelled_at is not null then 'cancelled'
    when not exists (select 1 from acc.purchase_order_lines l where l.company_id = o.company_id and l.order_id = o.id
                      and acc.purchase_order_received(o.company_id, o.id, l.line_no) < l.qty) then 'closed'
    when exists (select 1 from acc.purchase_order_receipts x join acc.purchase_documents d on d.company_id = x.company_id and d.id = x.document_id
                  where x.company_id = o.company_id and x.order_id = o.id and d.voided_at is null) then 'partial'
    else 'open' end`;
const ORDER = `o.id, o.doc_no as "docNo", to_char(o.doc_date, 'YYYY-MM-DD') as date, to_char(o.until_date, 'YYYY-MM-DD') as "untilDate",
  o.party_code as "partyCode", o.party_name as "partyName", o.is_service as "isService", o.price_mode as "priceMode",
  o.vat_rate::text as "vatRate", o.gross::text, o.discount::text, o.base::text, o.vat::text, o.total::text, o.description,
  o.cancel_reason as "cancelReason", ${ORDER_STATUS} as status`;

export function purchaseFlowRoutes(app: FastifyInstance, pool: pg.Pool, auth: AuthAdapter) {
  const user = (req: FastifyRequest): Promise<AuthUser> => requireUser(auth, req);
  const idemKey = (req: FastifyRequest) => IdempotencyKey.parse(req.headers['idempotency-key']);
  const docNo = async (c: pg.PoolClient, companyId: string, id: string) =>
    (await c.query('select doc_no from acc.purchase_documents where company_id = $1 and id = $2', [companyId, id])).rows[0].doc_no as string;

  // ---- ใบสั่งซื้อ ----
  app.post('/companies/:companyId/purchase-orders', async (req, reply) => {
    const { companyId } = CompanyParams.parse(req.params);
    const b = NewPurchaseOrder.parse(req.body);
    const key = idemKey(req);
    const p = {
      date: b.date, party_code: b.partyCode, until_date: b.untilDate, is_service: b.isService, price_mode: b.priceMode,
      discount: b.discount, description: b.description,
      lines: b.lines.map((l) => ({ item_code: l.itemCode, description: l.description, qty: l.qty, unit: l.unit, unit_price: l.unitPrice })),
    };
    const row = await withUser(pool, await user(req), async (c) => {
      await requireWritable(c, companyId);
      const id = (await c.query('select acc.save_purchase_order($1, $2::jsonb, $3) id', [companyId, JSON.stringify(p), key])).rows[0].id;
      const doc = (await c.query('select doc_no from acc.purchase_orders where company_id = $1 and id = $2', [companyId, id])).rows[0];
      return { id, docNo: doc.doc_no as string };
    });
    return reply.code(201).send(row);
  });

  app.get('/companies/:companyId/purchase-orders', async (req) => {
    const { companyId } = CompanyParams.parse(req.params);
    const { party } = PartyFilter.parse(req.query);
    return withUser(pool, await user(req), async (c) => {
      await requireReadable(c, companyId);
      return (await c.query(
        `select ${ORDER} from acc.purchase_orders o where o.company_id = $1 and ($2::text is null or o.party_code = $2)
          order by o.doc_date desc, o.doc_no desc limit 500`, [companyId, party ?? null])).rows;
    });
  });

  app.get('/companies/:companyId/purchase-orders/:orderId', async (req) => {
    const { companyId, orderId } = PurchaseOrderParams.parse(req.params);
    return withUser(pool, await user(req), async (c) => {
      await requireReadable(c, companyId);
      const o = (await c.query(
        `select ${ORDER}, o.party_tax_id as "partyTaxId", o.party_branch_no as "partyBranchNo", o.party_address as "partyAddress",
                co.name as "buyerName", co.tax_id as "buyerTaxId", co.branch_no as "buyerBranchNo", co.address as "buyerAddress"
           from acc.purchase_orders o join acc.companies co on co.id = o.company_id
          where o.company_id = $1 and o.id = $2`, [companyId, orderId])).rows[0];
      if (!o) throw new HttpError(404, 'not_found', 'ไม่พบเอกสารนี้');
      const [lines, docs, deposits] = await querySequence([
        () => c.query(`select l.line_no as "lineNo", i.code as "itemCode", i.is_service as "isService", l.description, l.qty::text, l.unit,
                        l.unit_price::text as "unitPrice", l.amount::text, acc.purchase_order_received(l.company_id, l.order_id, l.line_no)::text as received
                   from acc.purchase_order_lines l left join acc.items i on i.company_id = l.company_id and i.id = l.item_id
                  where l.company_id = $1 and l.order_id = $2 order by l.line_no`, [companyId, orderId]),
        () => c.query(`select distinct d.id, d.kind, d.doc_no as "docNo", to_char(d.doc_date, 'YYYY-MM-DD') as date, d.total::text,
                        d.voided_at is not null as voided
                   from acc.purchase_order_receipts x join acc.purchase_documents d on d.company_id = x.company_id and d.id = x.document_id
                  where x.company_id = $1 and x.order_id = $2 order by 3`, [companyId, orderId]),
        () => c.query(`select d.id, d.doc_no as "docNo", to_char(d.doc_date, 'YYYY-MM-DD') as date, d.total::text, d.voided_at is not null as voided,
                        (select amount::text from acc.purchase_deposit_remaining(d.company_id, d.id)) as remaining
                   from acc.purchase_documents d where d.company_id = $1 and d.purchase_order_id = $2 and d.kind = 'deposit'
                  order by d.doc_no`, [companyId, orderId]),
      ] as const);
      await c.query('select app.log_company_view($1)', [companyId]);
      return { ...o, lines: lines.rows, documents: docs.rows, deposits: deposits.rows };
    });
  });

  app.post('/companies/:companyId/purchase-orders/:orderId/cancel', async (req) => {
    const { companyId, orderId } = PurchaseOrderParams.parse(req.params);
    const { reason } = CancelWithReason.parse(req.body);
    await withUser(pool, await user(req), async (c) => {
      await requireWritable(c, companyId);
      await c.query('select acc.cancel_purchase_order($1, $2, $3)', [companyId, orderId, reason]);
    });
    return { cancelled: true };
  });

  // ---- ใบรับสินค้า ----
  app.post('/companies/:companyId/purchases/goods-receipt', async (req, reply) => {
    const { companyId } = CompanyParams.parse(req.params);
    const b = NewGoodsReceipt.parse(req.body);
    const key = idemKey(req);
    const p = {
      date: b.date, party_code: b.partyCode, vendor_doc_no: b.vendorDocNo, order_id: b.orderId, description: b.description,
      lines: b.lines.map((l) => ({ item_code: l.itemCode, description: l.description, qty: l.qty, unit_price: l.unitPrice, order_line_no: l.orderLineNo })),
    };
    const row = await withUser(pool, await user(req), async (c) => {
      await requireWritable(c, companyId);
      await useWarehouse(c, companyId, b.warehouse);
      const id = (await c.query('select acc.post_goods_receipt($1, $2::jsonb, $3) id', [companyId, JSON.stringify(p), key])).rows[0].id;
      return { id, docNo: await docNo(c, companyId, id) };
    });
    return reply.code(201).send(row);
  });

  // บรรทัดใบรับสินค้าที่ยังไม่ได้รับใบแจ้งหนี้ (ฟอร์มบันทึกซื้อใช้เลือก)
  app.get('/companies/:companyId/goods-receipts/open', async (req) => {
    const { companyId } = CompanyParams.parse(req.params);
    const { party } = PartyFilter.parse(req.query);
    return withUser(pool, await user(req), async (c) => {
      await requireReadable(c, companyId);
      return (await c.query(
        `select d.id as "receiptId", d.doc_no as "docNo", d.vendor_doc_no as "vendorDocNo", to_char(d.doc_date, 'YYYY-MM-DD') as date,
                d.party_code as "partyCode", l.line_no as "lineNo", i.code as "itemCode", l.description, l.unit,
                l.qty::text, l.unit_price::text as "unitPrice", l.amount::text, a.code as account,
                (l.qty - m.qty)::text as remaining, (l.amount - m.amount)::text as "remainingAmount"
           from acc.purchase_documents d
           join acc.purchase_document_lines l on l.company_id = d.company_id and l.document_id = d.id
           join acc.chart_of_accounts a on a.company_id = l.company_id and a.id = l.account_id
           join acc.items i on i.company_id = l.company_id and i.id = l.item_id
           cross join lateral acc.receipt_line_invoiced(d.company_id, d.id, l.line_no) m
          where d.company_id = $1 and d.kind = 'goods_receipt' and d.voided_at is null and l.qty > m.qty
            and ($2::text is null or d.party_code = $2)
          order by d.doc_date, d.doc_no, l.line_no`, [companyId, party ?? null])).rows;
    });
  });

  // ---- จ่ายเงินมัดจำ ----
  app.post('/companies/:companyId/purchases/deposit', async (req, reply) => {
    const { companyId } = CompanyParams.parse(req.params);
    const b = NewPurchaseDeposit.parse(req.body);
    const key = idemKey(req);
    const p = {
      date: b.date, party_code: b.partyCode, vendor_doc_no: b.vendorDocNo, amount: b.amount, price_mode: b.priceMode,
      is_service: b.isService, cash_account: b.cashAccount, order_id: b.orderId, description: b.description,
    };
    const row = await withUser(pool, await user(req), async (c) => {
      await requireWritable(c, companyId);
      const id = (await c.query('select acc.post_purchase_deposit($1, $2::jsonb, $3) id', [companyId, JSON.stringify(p), key])).rows[0].id;
      return { id, docNo: await docNo(c, companyId, id) };
    });
    return reply.code(201).send(row);
  });

  // เงินมัดจำจ่ายที่ยังหักไม่หมด (ฟอร์มซื้อเชื่อใช้เลือกหัก)
  app.get('/companies/:companyId/purchase-deposits', async (req) => {
    const { companyId } = CompanyParams.parse(req.params);
    const { party } = PartyFilter.parse(req.query);
    return withUser(pool, await user(req), async (c) => {
      await requireReadable(c, companyId);
      return (await c.query(
        `select d.id, d.doc_no as "docNo", d.vendor_doc_no as "vendorDocNo", to_char(d.doc_date, 'YYYY-MM-DD') as date,
                d.party_code as "partyCode", d.party_name as "partyName", d.total::text, d.vat::text, r.amount::text as remaining,
                r.vat::text as "remainingVat", o.doc_no as "orderDocNo", d.purchase_order_id as "orderId"
           from acc.purchase_documents d cross join lateral acc.purchase_deposit_remaining(d.company_id, d.id) r
           left join acc.purchase_orders o on o.company_id = d.company_id and o.id = d.purchase_order_id
          where d.company_id = $1 and d.kind = 'deposit' and d.voided_at is null and r.amount > 0
            and ($2::text is null or d.party_code = $2)
          order by d.doc_date, d.doc_no`, [companyId, party ?? null])).rows;
    });
  });
}
