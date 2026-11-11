import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { querySequence, useWarehouse, withUser } from '../db.js';
import type { AuthAdapter, AuthUser } from '../auth.js';
import { requireReadable, requireUser, requireWritable } from '../guard.js';
import { HttpError } from '../errors.js';
import {
  CancelWithReason, CompanyParams, EditWarehouse, IdempotencyKey, InventoryAdjustment, InventoryMethod, ItemParams, NewTransfer, NewWarehouse,
  TransferParams, WarehouseParams,
} from '../schemas.js';

// เฟส 3.1 สินค้าคงเหลือ (perpetual / ถัวเฉลี่ยเคลื่อนที่): ยอดคงเหลือ บัตรสต็อก และปรับสต็อก (เปิดยอด/ตรวจนับ)
// ตารางและการลงบัญชีอยู่ใน DB (migration 019–023, 031) route นี้แค่อ่านและเรียก acc.post_inventory_adjustment
export function inventoryRoutes(app: FastifyInstance, pool: pg.Pool, auth: AuthAdapter) {
  const user = (req: FastifyRequest): Promise<AuthUser> => requireUser(auth, req);
  const idemKey = (req: FastifyRequest) => IdempotencyKey.parse(req.headers['idempotency-key']);

  // สินค้าที่ติดตามสต็อกทุกตัว + ยอดบัญชี 1310 (ต้องเท่ากับมูลค่ารวมเสมอ หน้าจอแสดงให้เห็นว่าตรงกัน)
  app.get('/companies/:companyId/inventory', async (req) => {
    const { companyId } = CompanyParams.parse(req.params);
    return withUser(pool, await user(req), async (c) => {
      await requireReadable(c, companyId);
      const [company, items, gl, accounts] = await querySequence([
        () => c.query(`select name, app.can_write_company(id) as "canWrite", app.company_locked(id) as locked, inventory_method as "inventoryMethod"
                   from acc.companies where id = $1`, [companyId]),
        () => c.query(
          `select i.code, i.name, i.unit, i.active, b.quantity::text, b.value::text, b.unit_cost::text as "unitCost",
                  acc.item_cost_method(i.company_id, i.id) as method
             from acc.items i cross join lateral acc.inventory_balance(i.company_id, i.id) b
            where i.company_id = $1 and i.track_inventory order by i.code`, [companyId]),
        () => c.query(
          `select coalesce(sum(l.debit - l.credit), 0)::numeric(18,2)::text as balance,
                  (select coalesce(sum(b.value), 0)::numeric(18,2)::text from acc.items i cross join lateral acc.inventory_balance(i.company_id, i.id) b
                    where i.company_id = $1 and i.track_inventory) as total
             from acc.journal_lines l join acc.chart_of_accounts a on a.company_id = l.company_id and a.id = l.account_id
            where l.company_id = $1 and a.code = '1310'`, [companyId]),
        () => c.query(`select code, name from acc.chart_of_accounts where company_id = $1 and active and code <> '1310' order by code`, [companyId]),
      ] as const);
      // จำนวนคงเหลือรายคลัง (ต้นทุนคิดรวมทั้งบริษัท)
      const stock = (await c.query(
        `select i.code as "itemCode", w.code as warehouse, sum(m.quantity)::numeric(14,3)::text as qty
           from acc.items i cross join lateral acc.warehouse_movements(i.company_id, i.id) m
           join acc.warehouses w on w.company_id = i.company_id and w.id = m.warehouse_id
          where i.company_id = $1 and i.track_inventory group by i.code, w.code having sum(m.quantity) <> 0 order by 1, 2`, [companyId])).rows;
      const warehouses = (await c.query(
        `select code, name, is_main as "isMain", active from acc.warehouses where company_id = $1 order by is_main desc, code`, [companyId])).rows;
      return { company: company.rows[0], items: items.rows, totalValue: gl.rows[0].total, glBalance: gl.rows[0].balance, accounts: accounts.rows,
        warehouses, stock };
    });
  });

  // บัตรสต็อกของสินค้าหนึ่งตัว: ทุกความเคลื่อนไหว เอกสารอ้างอิง และยอดคงเหลือหลังรายการ
  // มูลค่า/ต้นทุนเป็นค่าหลังคำนวณต้นทุนใหม่ล่าสุด (migration 104) เลขที่รายการ = รายการต้นทุนปัจจุบัน
  app.get('/companies/:companyId/inventory/:code', async (req) => {
    const { companyId, code } = ItemParams.parse(req.params);
    return withUser(pool, await user(req), async (c) => {
      await requireReadable(c, companyId);
      const item = (await c.query(
        `select i.id, i.code, i.name, i.unit, i.track_inventory as "trackInventory", acc.item_cost_method(i.company_id, i.id) as method
           from acc.items i where i.company_id = $1 and i.code = $2`, [companyId, code])).rows[0];
      if (!item) throw new HttpError(404, 'not_found', `ไม่พบสินค้ารหัส ${code}`);
      const card = await c.query(
        `select to_char(m.movement_date, 'YYYY-MM-DD') as date, m.kind, m.reference, e.id as "entryId", e.doc_no as "entryDocNo",
                greatest(m.quantity, 0)::text as "qtyIn", greatest(-m.quantity, 0)::text as "qtyOut", m.eff_unit_cost::text as "unitCost",
                greatest(m.eff_value, 0)::text as "valueIn", greatest(-m.eff_value, 0)::text as "valueOut",
                (sum(m.quantity) over w)::text as "balanceQty", (sum(m.eff_value) over w)::numeric(18,2)::text as "balanceValue",
                m.restated
           from acc.inventory_movements_effective m
           join acc.journal_entries e on e.company_id = m.company_id and e.id = m.cur_entry_id
          where m.company_id = $1 and m.item_id = $2
         window w as (order by m.movement_date, m.created_at, m.id rows between unbounded preceding and current row)
          order by m.movement_date, m.created_at, m.id`, [companyId, item.id]);
      // FIFO: ชั้นต้นทุนที่เหลือ (เก่าสุดก่อน) ใช้สอนว่าขายครั้งต่อไปตัดชั้นไหน
      const layers = item.method === 'fifo'
        ? (await c.query(`select l->>'date' as date, (l->>'qty')::numeric(14,3)::text as qty, (l->>'value')::numeric(18,2)::text as value
                            from acc.fifo_walk($1, $2, null, null) w cross join lateral jsonb_array_elements(w.layers) l`, [companyId, item.id])).rows
        : null;
      const { id: _id, ...rest } = item;
      return { item: rest, card: card.rows, layers };
    });
  });

  // ---- คลัง ----
  app.get('/companies/:companyId/warehouses', async (req) => {
    const { companyId } = CompanyParams.parse(req.params);
    return withUser(pool, await user(req), async (c) => {
      await requireReadable(c, companyId);
      return (await c.query(`select code, name, is_main as "isMain", active, version from acc.warehouses where company_id = $1 order by is_main desc, code`,
        [companyId])).rows;
    });
  });
  app.post('/companies/:companyId/warehouses', async (req, reply) => {
    const { companyId } = CompanyParams.parse(req.params);
    const b = NewWarehouse.parse(req.body);
    await withUser(pool, await user(req), async (c) => {
      await requireWritable(c, companyId);
      if ((await c.query('select 1 from acc.warehouses where company_id = $1 and code = $2', [companyId, b.code])).rowCount) {
        throw new HttpError(409, 'duplicate', `มีคลังรหัส ${b.code} อยู่แล้ว`);
      }
      await c.query('select acc.save_warehouse($1, $2, $3, null)', [companyId, b.code, b.name]);
    });
    return reply.code(201).send({ code: b.code, name: b.name });
  });
  app.patch('/companies/:companyId/warehouses/:code', async (req) => {
    const { companyId, code } = WarehouseParams.parse(req.params);
    const b = EditWarehouse.parse(req.body);
    return withUser(pool, await user(req), async (c) => {
      await requireWritable(c, companyId);
      if (!(await c.query('select 1 from acc.warehouses where company_id = $1 and code = $2', [companyId, code])).rowCount) {
        throw new HttpError(404, 'not_found', `ไม่พบคลังรหัส ${code}`);
      }
      await c.query('select acc.save_warehouse($1, $2, $3, $4)', [companyId, code, b.name ?? null, b.active ?? null]);
      return (await c.query(`select code, name, is_main as "isMain", active from acc.warehouses where company_id = $1 and code = $2`, [companyId, code])).rows[0];
    });
  });

  // ---- โอนย้ายระหว่างคลัง (ไม่ลงบัญชี) ----
  const TRANSFER = `t.id, t.doc_no as "docNo", to_char(t.doc_date, 'YYYY-MM-DD') as date, f.code as "from", f.name as "fromName",
    w.code as "to", w.name as "toName", t.description, t.cancel_reason as "cancelReason", t.cancelled_at is not null as cancelled,
    (select coalesce(json_agg(json_build_object('itemCode', i.code, 'name', i.name, 'unit', i.unit, 'qty', l.qty::text) order by l.line_no), '[]')
       from acc.inventory_transfer_lines l join acc.items i on i.company_id = l.company_id and i.id = l.item_id
      where l.company_id = t.company_id and l.transfer_id = t.id) as lines`;
  const TRANSFER_FROM = `acc.inventory_transfers t join acc.warehouses f on f.company_id = t.company_id and f.id = t.from_id
    join acc.warehouses w on w.company_id = t.company_id and w.id = t.to_id`;
  app.get('/companies/:companyId/inventory/transfers', async (req) => {
    const { companyId } = CompanyParams.parse(req.params);
    return withUser(pool, await user(req), async (c) => {
      await requireReadable(c, companyId);
      return (await c.query(`select ${TRANSFER} from ${TRANSFER_FROM} where t.company_id = $1 order by t.doc_date desc, t.doc_no desc limit 500`,
        [companyId])).rows;
    });
  });
  app.post('/companies/:companyId/inventory/transfers', async (req, reply) => {
    const { companyId } = CompanyParams.parse(req.params);
    const b = NewTransfer.parse(req.body);
    const key = idemKey(req);
    const p = { date: b.date, from: b.from, to: b.to, description: b.description, lines: b.lines.map((l) => ({ item_code: l.itemCode, qty: l.qty })) };
    const row = await withUser(pool, await user(req), async (c) => {
      await requireWritable(c, companyId);
      const id = (await c.query('select acc.post_inventory_transfer($1, $2::jsonb, $3) id', [companyId, JSON.stringify(p), key])).rows[0].id;
      return (await c.query(`select ${TRANSFER} from ${TRANSFER_FROM} where t.company_id = $1 and t.id = $2`, [companyId, id])).rows[0];
    });
    return reply.code(201).send(row);
  });
  app.post('/companies/:companyId/inventory/transfers/:transferId/cancel', async (req) => {
    const { companyId, transferId } = TransferParams.parse(req.params);
    const { reason } = CancelWithReason.parse(req.body);
    await withUser(pool, await user(req), async (c) => {
      await requireWritable(c, companyId);
      await c.query('select acc.cancel_inventory_transfer($1, $2, $3)', [companyId, transferId, reason]);
    });
    return { cancelled: true };
  });

  // วิธีคิดต้นทุนตั้งต้นของบริษัท (เปลี่ยนได้เมื่อสินค้าที่ใช้วิธีนี้ยังไม่เคลื่อนไหว)
  app.put('/companies/:companyId/inventory/method', async (req) => {
    const { companyId } = CompanyParams.parse(req.params);
    const { method } = InventoryMethod.parse(req.body);
    await withUser(pool, await user(req), async (c) => {
      await requireWritable(c, companyId);
      await c.query('select acc.set_inventory_method($1, $2)', [companyId, method]);
    });
    return { method };
  });

  // ปรับสต็อก: จำนวนบวก = รับเข้า (ต้องใส่ต้นทุนต่อหน่วย) · ลบ = ตัดออกตามต้นทุนเฉลี่ย · บัญชีคู่เลือกเอง
  app.post('/companies/:companyId/inventory/adjustments', async (req, reply) => {
    const { companyId } = CompanyParams.parse(req.params);
    const b = InventoryAdjustment.parse(req.body);
    const key = idemKey(req);
    if (!b.quantity.startsWith('-') && !b.unitCost) throw new HttpError(400, 'invalid', 'รับสินค้าเข้าต้องใส่ต้นทุนต่อหน่วย');
    const row = await withUser(pool, await user(req), async (c) => {
      await requireWritable(c, companyId);
      await useWarehouse(c, companyId, b.warehouse);
      const id = (await c.query('select acc.post_inventory_adjustment($1, $2, $3::date, $4::numeric, $5::numeric, $6, $7, $8) id',
        [companyId, b.itemCode, b.date, b.quantity, b.quantity.startsWith('-') ? null : b.unitCost, b.offsetAccount, b.description ?? '', key])).rows[0].id;
      return (await c.query(`select e.id as "entryId", e.doc_no as "docNo" from acc.inventory_movements m
                               join acc.journal_entries e on e.company_id = m.company_id and e.id = m.entry_id
                              where m.company_id = $1 and m.id = $2`, [companyId, id])).rows[0];
    });
    return reply.code(201).send(row);
  });
}
