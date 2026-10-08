import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { withUser } from '../db.js';
import type { AuthAdapter, AuthUser } from '../auth.js';
import { requireReadable, requireUser, requireWritable } from '../guard.js';
import { HttpError } from '../errors.js';
import {
  CompanyParams, CompanyProfile, EditItem, EditParty, ItemParams, NewItem, NewParty, PartyParams, PartyQuery, PartyRules, WHT_STANDARD,
} from '../schemas.js';

// เฟส 2.1 ข้อมูลหลัก: โปรไฟล์ภาษีบริษัท ลูกค้า/ผู้ขาย สินค้า/บริการ (สิทธิ์ตัดสินที่ RLS เหมือนผังบัญชี)

const PROFILE = `name, tax_id as "taxId", branch_no as "branchNo", address, vat_registered as "vatRegistered",
  vat_rate::text as "vatRate", version`;
const PARTY = `p.code, p.name, p.is_customer as "isCustomer", p.is_vendor as "isVendor", p.tax_id as "taxId",
  p.branch_no as "branchNo", p.address, p.vat_registered as "vatRegistered", p.credit_days as "creditDays",
  p.wht_kind as "whtKind", p.wht_rate::text as "whtRate", p.active, p.version`;
const ITEM = `i.code, i.name, i.unit, i.is_service as "isService", i.sale_price::text as "salePrice",
  i.purchase_price::text as "purchasePrice", sa.code as "salesAccount", pa.code as "purchaseAccount", i.active, i.version`;
const ITEM_FROM = `acc.items i
  left join acc.chart_of_accounts sa on sa.company_id = i.company_id and sa.id = i.sales_account_id
  left join acc.chart_of_accounts pa on pa.company_id = i.company_id and pa.id = i.purchase_account_id`;

/** สร้าง "col = $n" จากช่องที่ส่งมาเท่านั้น (ไม่ส่ง = ไม่แตะ, ส่ง null = ล้างค่า) */
function setClause(cols: Record<string, string>, body: Record<string, unknown>, params: unknown[]) {
  const parts: string[] = [];
  for (const [key, col] of Object.entries(cols)) {
    if (body[key] === undefined) continue;
    params.push(body[key]);
    parts.push(`${col} = $${params.length}`);
  }
  return parts;
}

/** ประเภทมาตรฐานไม่ใส่อัตรา = ใช้อัตรามาตรฐาน (docs/phase2-spec.md T5) */
function whtRateFor(kind: string | null | undefined, rate: string | null | undefined) {
  if (!kind) return null;
  return rate ?? (kind in WHT_STANDARD ? WHT_STANDARD[kind as keyof typeof WHT_STANDARD] : null);
}

const versionConflict = (what: string) => new HttpError(409, '40001', `มีคนแก้${what}นี้ไปก่อนแล้ว โหลดใหม่เพื่อดูค่าล่าสุดก่อนแก้`);

export function masterDataRoutes(app: FastifyInstance, pool: pg.Pool, auth: AuthAdapter) {
  const user = (req: FastifyRequest): Promise<AuthUser> => requireUser(auth, req);

  // รหัสบัญชีของบริษัทนี้ → id พร้อมตรวจหมวดที่ใช้ได้ (สินค้าขายลงรายได้, ซื้อลงค่าใช้จ่ายหรือสินทรัพย์)
  async function accountId(c: pg.PoolClient, companyId: string, code: string | null | undefined, allowed: string[], label: string) {
    if (code === undefined) return undefined;
    if (code === null) return null;
    const r = await c.query('select id, type from acc.chart_of_accounts where company_id = $1 and code = $2', [companyId, code]);
    if (!r.rows[0]) throw new HttpError(422, 'ACC04', `ไม่พบรหัสบัญชี ${code} ในผังบัญชี`);
    if (!allowed.includes(r.rows[0].type)) throw new HttpError(422, 'invalid', `${label}ใช้บัญชี ${code} ไม่ได้ (หมวดไม่ตรง)`);
    return r.rows[0].id as string;
  }

  // ---- โปรไฟล์ภาษีของบริษัท ----
  app.get('/companies/:companyId/profile', async (req) => {
    const { companyId } = CompanyParams.parse(req.params);
    return withUser(pool, await user(req), async (c) => {
      await requireReadable(c, companyId);
      return (await c.query(
        `select ${PROFILE}, app.can_write_company(id) as "canEdit", app.company_locked(id) as locked
           from acc.companies where id = $1`, [companyId])).rows[0];
    });
  });

  app.patch('/companies/:companyId/profile', async (req) => {
    const { companyId } = CompanyParams.parse(req.params);
    const body = CompanyProfile.parse(req.body);
    return withUser(pool, await user(req), async (c) => {
      await requireWritable(c, companyId);
      const params: unknown[] = [companyId, body.version];
      const sets = setClause({ taxId: 'tax_id', branchNo: 'branch_no', address: 'address', vatRegistered: 'vat_registered', vatRate: 'vat_rate' }, body, params);
      const r = await c.query(
        `update acc.companies set ${[...sets, 'version = version + 1'].join(', ')}
          where id = $1 and version = $2 returning ${PROFILE}`, params);
      if (!r.rows[0]) throw versionConflict('ข้อมูลบริษัท');
      return r.rows[0];
    });
  });

  // ---- ลูกค้า/ผู้ขาย ----
  app.get('/companies/:companyId/parties', async (req) => {
    const { companyId } = CompanyParams.parse(req.params);
    const { kind } = PartyQuery.parse(req.query);
    return withUser(pool, await user(req), async (c) => {
      await requireReadable(c, companyId);
      const filter = kind === 'customer' ? 'and p.is_customer' : kind === 'vendor' ? 'and p.is_vendor' : '';
      return (await c.query(`select ${PARTY} from acc.parties p where p.company_id = $1 ${filter} order by p.code`, [companyId])).rows;
    });
  });

  app.post('/companies/:companyId/parties', async (req, reply) => {
    const { companyId } = CompanyParams.parse(req.params);
    const b = NewParty.parse(req.body);
    const row = await withUser(pool, await user(req), async (c) => {
      await requireWritable(c, companyId);
      try {
        return (await c.query(
          `insert into acc.parties as p (company_id, code, name, is_customer, is_vendor, tax_id, branch_no, address,
                                      vat_registered, credit_days, wht_kind, wht_rate)
           values ($1, $2, $3, $4, $5, $6, coalesce($7, '00000'), coalesce($8, ''), coalesce($9, false), coalesce($10, 0), $11, $12)
           returning ${PARTY}`,
          [companyId, b.code, b.name, b.isCustomer, b.isVendor, b.taxId ?? null, b.branchNo ?? null, b.address ?? null,
           b.vatRegistered ?? null, b.creditDays ?? null, b.whtKind ?? null, whtRateFor(b.whtKind, b.whtRate)])).rows[0];
      } catch (e) {
        if ((e as { code?: string }).code === '23505') throw new HttpError(409, 'duplicate', `มีรหัส ${b.code} อยู่แล้ว`);
        throw e;
      }
    });
    return reply.code(201).send(row);
  });

  app.patch('/companies/:companyId/parties/:code', async (req) => {
    const { companyId, code } = PartyParams.parse(req.params);
    const b = EditParty.parse(req.body);
    return withUser(pool, await user(req), async (c) => {
      await requireWritable(c, companyId);
      const cur = (await c.query(`select ${PARTY} from acc.parties p where p.company_id = $1 and p.code = $2 for update`, [companyId, code])).rows[0];
      if (!cur) throw new HttpError(404, 'not_found', `ไม่พบรหัส ${code}`);
      if (cur.version !== b.version) throw versionConflict('คู่ค้า');
      // เปลี่ยนประเภทหัก ณ ที่จ่ายโดยไม่ส่งอัตรา = ใช้อัตรามาตรฐานของประเภทใหม่
      if (b.whtKind !== undefined && b.whtRate === undefined) b.whtRate = whtRateFor(b.whtKind, null);
      PartyRules.parse({ ...cur, ...b });
      const params: unknown[] = [companyId, code, b.version];
      const sets = setClause({
        name: 'name', isCustomer: 'is_customer', isVendor: 'is_vendor', taxId: 'tax_id', branchNo: 'branch_no', address: 'address',
        vatRegistered: 'vat_registered', creditDays: 'credit_days', whtKind: 'wht_kind', whtRate: 'wht_rate', active: 'active',
      }, b, params);
      const r = await c.query(
        `update acc.parties p set ${[...sets, 'version = p.version + 1'].join(', ')}
          where p.company_id = $1 and p.code = $2 and p.version = $3 returning ${PARTY}`, params);
      return r.rows[0];
    });
  });

  // ---- สินค้า/บริการ ----
  app.get('/companies/:companyId/items', async (req) => {
    const { companyId } = CompanyParams.parse(req.params);
    return withUser(pool, await user(req), async (c) => {
      await requireReadable(c, companyId);
      return (await c.query(`select ${ITEM} from ${ITEM_FROM} where i.company_id = $1 order by i.code`, [companyId])).rows;
    });
  });

  app.post('/companies/:companyId/items', async (req, reply) => {
    const { companyId } = CompanyParams.parse(req.params);
    const b = NewItem.parse(req.body);
    const row = await withUser(pool, await user(req), async (c) => {
      await requireWritable(c, companyId);
      const sales = await accountId(c, companyId, b.salesAccount, ['revenue'], 'บัญชีขาย');
      const purchase = await accountId(c, companyId, b.purchaseAccount, ['expense', 'asset'], 'บัญชีซื้อ');
      try {
        await c.query(
          `insert into acc.items (company_id, code, name, unit, is_service, sale_price, purchase_price, sales_account_id, purchase_account_id)
           values ($1, $2, $3, coalesce($4, ''), coalesce($5, false), $6, $7, $8, $9)`,
          [companyId, b.code, b.name, b.unit ?? null, b.isService ?? null, b.salePrice ?? null, b.purchasePrice ?? null, sales ?? null, purchase ?? null]);
      } catch (e) {
        if ((e as { code?: string }).code === '23505') throw new HttpError(409, 'duplicate', `มีรหัส ${b.code} อยู่แล้ว`);
        throw e;
      }
      return (await c.query(`select ${ITEM} from ${ITEM_FROM} where i.company_id = $1 and i.code = $2`, [companyId, b.code])).rows[0];
    });
    return reply.code(201).send(row);
  });

  app.patch('/companies/:companyId/items/:code', async (req) => {
    const { companyId, code } = ItemParams.parse(req.params);
    const b = EditItem.parse(req.body);
    return withUser(pool, await user(req), async (c) => {
      await requireWritable(c, companyId);
      const fields: Record<string, unknown> = { ...b,
        salesAccountId: await accountId(c, companyId, b.salesAccount, ['revenue'], 'บัญชีขาย'),
        purchaseAccountId: await accountId(c, companyId, b.purchaseAccount, ['expense', 'asset'], 'บัญชีซื้อ') };
      const params: unknown[] = [companyId, code, b.version];
      const sets = setClause({
        name: 'name', unit: 'unit', isService: 'is_service', salePrice: 'sale_price', purchasePrice: 'purchase_price',
        salesAccountId: 'sales_account_id', purchaseAccountId: 'purchase_account_id', active: 'active',
      }, fields, params);
      const r = await c.query(
        `update acc.items i set ${[...sets, 'version = i.version + 1'].join(', ')}
          where i.company_id = $1 and i.code = $2 and i.version = $3 returning i.code`, params);
      if (!r.rows[0]) {
        const exists = (await c.query('select 1 from acc.items where company_id = $1 and code = $2', [companyId, code])).rowCount;
        if (!exists) throw new HttpError(404, 'not_found', `ไม่พบรหัส ${code}`);
        throw versionConflict('สินค้า');
      }
      return (await c.query(`select ${ITEM} from ${ITEM_FROM} where i.company_id = $1 and i.code = $2`, [companyId, code])).rows[0];
    });
  });
}
