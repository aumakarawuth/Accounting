import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp } from '../apps/api/src/app';
import { devAuth } from '../apps/api/src/auth';
import { authConfigFromEnv } from '../apps/api/src/config';
import { createPool } from '../apps/api/src/db';
import { apiUrl } from './global-setup';
import { pool as db, asUser, newSchool, newUser, newClassroom, newCompany, sqlstate, taxId } from './helpers';

// เฟส 2.1 ข้อมูลหลัก: เลขผู้เสียภาษี โปรไฟล์ภาษีบริษัท ลูกค้า/ผู้ขาย สินค้า/บริการ (ฐานข้อมูล + API)
const apiPool = createPool(apiUrl());
const app = buildApp({ pool: apiPool, auth: devAuth(), cfg: { ...authConfigFromEnv({}), allowedOrigins: false } });
afterAll(async () => { await app.close(); await apiPool.end(); await db.end(); });
const teachers = new Set<string>();
const as = (user: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
  app.inject({ method, url, payload, headers: { 'x-dev-user-id': user, 'x-dev-role': teachers.has(user) ? 'teacher' : 'student' } });

let school: string, teacher: string, s1: string, s2: string, room: string, co1: string, co2: string;

beforeAll(async () => {
  school = await newSchool();
  teacher = await newUser(school, 'teacher');
  teachers.add(teacher);
  s1 = await newUser(school, 'student');
  s2 = await newUser(school, 'student');
  room = await newClassroom(school, teacher, [s1, s2]);
  co1 = await newCompany(s1, room);
  co2 = await newCompany(s2, room);
});

const insertParty = (user: string, company: string, p: Record<string, unknown>) =>
  asUser(user, (c) => c.query(
    `insert into acc.parties (company_id, code, name, is_customer, is_vendor, tax_id, vat_registered, wht_kind, wht_rate)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
    [company, p.code, p.name ?? 'ลูกค้า', p.is_customer ?? true, p.is_vendor ?? false, p.tax_id ?? null,
     p.vat_registered ?? false, p.wht_kind ?? null, p.wht_rate ?? null]));

describe('เลขประจำตัวผู้เสียภาษี', () => {
  it('หลักตรวจสอบตรงกับสูตรของกรมสรรพากร (สุ่ม 2,000 เลข เทียบ SQL กับ TypeScript)', async () => {
    const ids = Array.from({ length: 2000 }, (_, i) => taxId(i * 7919 + 17));
    const wrong = ids.map((t) => t.slice(0, 12) + ((Number(t[12]) + 1) % 10));
    const r = await db.query(
      `select bool_and(app.valid_tax_id(v)) as ok, bool_or(app.valid_tax_id(w)) as anywrong
         from unnest($1::text[], $2::text[]) as x(v, w)`, [ids, wrong]);
    expect(r.rows[0]).toEqual({ ok: true, anywrong: false });
  });

  it('ต้องเป็นตัวเลข 13 หลักพอดี', async () => {
    const r = await db.query(
      `select app.valid_tax_id('1234567890121') a, app.valid_tax_id('123456789012') b,
              app.valid_tax_id('12345678901210') c, app.valid_tax_id('1234-67890121') d, app.valid_tax_id('') e`);
    expect(r.rows[0]).toEqual({ a: true, b: false, c: false, d: false, e: false });
  });
});

describe('ผังบัญชีสำหรับเอกสารขาย/ซื้อ', () => {
  it('บริษัทใหม่มีบัญชีภาษีครบ และ 1420 ใช้ชื่อตามตำรา', async () => {
    const r = await db.query(
      `select code, name, type from acc.chart_of_accounts
        where company_id = $1 and code in ('1410','1411','1420','1430','2210','2211','2230','4220','5140') order by code`, [co1]);
    expect(r.rows).toEqual([
      { code: '1410', name: 'ภาษีซื้อ', type: 'asset' },
      { code: '1411', name: 'ภาษีซื้อยังไม่ถึงกำหนด', type: 'asset' },
      { code: '1420', name: 'ภาษีเงินได้ถูกหัก ณ ที่จ่าย', type: 'asset' },
      { code: '1430', name: 'ภาษีมูลค่าเพิ่มรอขอคืน', type: 'asset' },
      { code: '2210', name: 'ภาษีขาย', type: 'liability' },
      { code: '2211', name: 'ภาษีขายยังไม่ถึงกำหนด', type: 'liability' },
      { code: '2230', name: 'ภาษีหัก ณ ที่จ่ายค้างจ่าย', type: 'liability' },
      { code: '4220', name: 'รับคืนสินค้า', type: 'revenue' },
      { code: '5140', name: 'ส่งคืนสินค้า', type: 'expense' },
    ]);
  });
});

describe('โปรไฟล์ภาษีของบริษัท', () => {
  it('เริ่มต้น: จด VAT อัตรา 7% สำนักงานใหญ่', async () => {
    const r = await db.query('select tax_id, branch_no, vat_registered, vat_rate from acc.companies where id = $1', [co1]);
    expect(r.rows[0]).toEqual({ tax_id: null, branch_no: '00000', vat_registered: true, vat_rate: '7.00' });
  });

  it('เจ้าของแก้ได้ (ต้องเพิ่ม version) ครูแก้ไม่ได้ เลขผู้เสียภาษีผิดหลักตรวจสอบถูกปฏิเสธ', async () => {
    const t = taxId(42);
    const upd = (user: string, tax: string) => asUser(user, (c) => c.query(
      `update acc.companies set tax_id = $2, address = 'กรุงเทพฯ', version = version + 1 where id = $1`, [co1, tax]));
    expect((await upd(s1, t)).rowCount).toBe(1);
    expect((await upd(teacher, t)).rowCount).toBe(0); // RLS: ครูอ่านได้อย่างเดียว
    await expect(upd(s1, t.slice(0, 12) + ((Number(t[12]) + 1) % 10))).rejects.toMatchObject({ code: '23514' });
    await expect(asUser(s1, (c) => c.query(`update acc.companies set vat_registered = false where id = $1`, [co1])))
      .rejects.toMatchObject({ code: '40001' });
  });
});

describe('ลูกค้า/ผู้ขาย', () => {
  it('เจ้าของเพิ่มได้ ครูและนักเรียนคนอื่นเพิ่มไม่ได้ อ่านได้ตามสิทธิ์บริษัท', async () => {
    await insertParty(s1, co1, { code: 'C001', name: 'บริษัท ลูกค้า จำกัด', tax_id: taxId(1), vat_registered: true });
    await expect(insertParty(s2, co1, { code: 'C002' })).rejects.toMatchObject({ code: '42501' });
    await expect(insertParty(teacher, co1, { code: 'C003' })).rejects.toMatchObject({ code: '42501' });
    const seen = (u: string) => asUser(u, async (c) => (await c.query('select code from acc.parties where company_id = $1', [co1])).rows);
    expect(await seen(teacher)).toEqual([{ code: 'C001' }]);
    expect(await seen(s2)).toEqual([]);
  });

  it('กติกาข้อมูล: จด VAT ต้องมีเลขผู้เสียภาษี, ต้องเป็นลูกค้าหรือผู้ขาย, หัก ณ ที่จ่ายต้องมีทั้งประเภทและอัตรา, รหัสซ้ำไม่ได้', async () => {
    const fails = async (p: Record<string, unknown>, code: string) => {
      try { await insertParty(s1, co1, p); } catch (e) { return expect(sqlstate(e)).toBe(code); }
      throw new Error(`ควรถูกปฏิเสธ: ${JSON.stringify(p)}`);
    };
    await fails({ code: 'C010', vat_registered: true }, '23514');
    await fails({ code: 'C011', is_customer: false, is_vendor: false }, '23514');
    await fails({ code: 'V001', is_vendor: true, wht_kind: 'service' }, '23514');
    await fails({ code: 'V002', is_vendor: true, wht_kind: 'service', wht_rate: 20 }, '23514');
    await fails({ code: 'c-lower' }, '23514');
    await fails({ code: 'C001' }, '23505');
    await insertParty(s1, co1, { code: 'V003', name: 'ร้านขนส่ง', is_customer: false, is_vendor: true, wht_kind: 'transport', wht_rate: 1 });
  });

  it('บริษัทอื่นใช้รหัสเดียวกันได้ (แยกต่อบริษัท)', async () => {
    await insertParty(s2, co2, { code: 'C001' });
  });
});

describe('สินค้า/บริการ', () => {
  const insertItem = (user: string, company: string, code: string, salesAccountCompany: string, accCode = '4120') =>
    asUser(user, (c) => c.query(
      `insert into acc.items (company_id, code, name, unit, is_service, sale_price, sales_account_id)
       values ($1, $2, 'ค่าบริการออกแบบ', 'งาน', true, 5000,
               (select id from acc.chart_of_accounts where company_id = $3 and code = $4))`,
      [company, code, salesAccountCompany, accCode]));

  it('ผูกบัญชีรายได้ของบริษัทตัวเองได้ ผูกบัญชีของบริษัทอื่นไม่ได้', async () => {
    await insertItem(s1, co1, 'SV-01', co1);
    // อ่านบัญชีของ co2 ไม่ได้ด้วย RLS อยู่แล้ว ทดสอบชั้นล่างด้วย superuser: FK (company_id, account_id) กันข้ามบริษัท
    const other = (await db.query(`select id from acc.chart_of_accounts where company_id = $1 and code = '4120'`, [co2])).rows[0].id;
    await expect(db.query(
      `insert into acc.items (company_id, code, name, sales_account_id) values ($1, 'X-1', 'ข้ามบริษัท', $2)`, [co1, other]))
      .rejects.toMatchObject({ code: '23503' });
  });
});

describe('ส่งงานแล้ว (ล็อก)', () => {
  it('เพิ่ม/แก้ลูกค้า สินค้า และโปรไฟล์ภาษีไม่ได้', async () => {
    const lockedOwner = await newUser(school, 'student');
    await db.query('insert into acc.enrollments values ($1, $2)', [room, lockedOwner]);
    const co = await newCompany(lockedOwner, room);
    await db.query(`insert into acc.submissions (company_id, status) values ($1, 'submitted')`, [co]);
    await expect(insertParty(lockedOwner, co, { code: 'C001' })).rejects.toMatchObject({ code: 'ACC10' });
    await expect(asUser(lockedOwner, (c) => c.query(
      `update acc.companies set address = 'x', version = version + 1 where id = $1`, [co]))).rejects.toMatchObject({ code: 'ACC10' });
  });
});

describe('API ข้อมูลหลัก', () => {
  let co: string, owner: string;
  beforeAll(async () => {
    owner = await newUser(school, 'student');
    await db.query('insert into acc.enrollments values ($1, $2)', [room, owner]);
    co = await newCompany(owner, room);
  });

  it('โปรไฟล์ภาษี: เจ้าของแก้ได้ ครูอ่านได้แต่แก้ไม่ได้ เลขภาษีผิดบอกเหตุ แก้ทับกันได้ 409', async () => {
    const t = taxId(777);
    const p0 = (await as(owner, 'GET', `/companies/${co}/profile`)).json();
    expect(p0).toMatchObject({ taxId: null, branchNo: '00000', vatRegistered: true, vatRate: '7.00', canEdit: true, locked: false });
    const r = await as(owner, 'PATCH', `/companies/${co}/profile`, { version: p0.version, taxId: t, address: 'กรุงเทพฯ', vatRegistered: false });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ taxId: t, address: 'กรุงเทพฯ', vatRegistered: false, version: p0.version + 1 });
    expect((await as(owner, 'PATCH', `/companies/${co}/profile`, { version: p0.version, address: 'x' })).statusCode).toBe(409);
    const bad = await as(owner, 'PATCH', `/companies/${co}/profile`, { version: p0.version + 1, taxId: '1234567890120' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().message).toContain('หลักตรวจสอบ');
    expect((await as(teacher, 'GET', `/companies/${co}/profile`)).json()).toMatchObject({ canEdit: false, taxId: t });
    expect((await as(teacher, 'PATCH', `/companies/${co}/profile`, { version: p0.version + 1, address: 'x' })).statusCode).toBe(403);
    expect((await as(s2, 'GET', `/companies/${co}/profile`)).statusCode).toBe(404);
  });

  it('ลูกค้า/ผู้ขาย: อัตราหัก ณ ที่จ่ายมาตรฐานใส่ให้เอง กติกาข้ามช่องตรวจตอนแก้ด้วย', async () => {
    const add = (body: object) => as(owner, 'POST', `/companies/${co}/parties`, body);
    const v = await add({ code: 'v-001', name: 'บริษัท ออกแบบ จำกัด', isCustomer: false, isVendor: true, whtKind: 'service' });
    expect(v.statusCode).toBe(201);
    expect(v.json()).toMatchObject({ code: 'V-001', whtKind: 'service', whtRate: '3.00', vatRegistered: false, creditDays: 0 });
    expect((await add({ code: 'V-002', name: 'อื่น', isCustomer: false, isVendor: true, whtKind: 'other' })).statusCode).toBe(400);
    const noTax = await add({ code: 'C-001', name: 'ลูกค้า', isCustomer: true, isVendor: false, vatRegistered: true });
    expect(noTax.statusCode).toBe(400);
    expect(noTax.json().message).toContain('ต้องมีเลขประจำตัวผู้เสียภาษี');
    expect((await add({ code: 'C-001', name: 'ลูกค้า', isCustomer: true, isVendor: false, taxId: taxId(5), creditDays: 30 })).statusCode).toBe(201);
    expect((await add({ code: 'C-001', name: 'ซ้ำ', isCustomer: true, isVendor: false })).statusCode).toBe(409);

    // จด VAT: รายที่มีเลขภาษีอยู่แล้วแก้ได้ รายที่ไม่มีแก้ไม่ได้
    expect((await as(owner, 'PATCH', `/companies/${co}/parties/C-001`, { version: 1, vatRegistered: true })).statusCode).toBe(200);
    const fail = await as(owner, 'PATCH', `/companies/${co}/parties/V-001`, { version: 1, vatRegistered: true });
    expect(fail.statusCode).toBe(400);
    const rent = await as(owner, 'PATCH', `/companies/${co}/parties/V-001`, { version: 1, whtKind: 'rent' });
    expect(rent.json()).toMatchObject({ whtKind: 'rent', whtRate: '5.00', version: 2 });
    expect((await as(owner, 'PATCH', `/companies/${co}/parties/V-001`, { version: 1, name: 'ช้า' })).statusCode).toBe(409);
    expect((await as(owner, 'PATCH', `/companies/${co}/parties/X-404`, { version: 1, name: 'x' })).statusCode).toBe(404);

    const vendors = (await as(teacher, 'GET', `/companies/${co}/parties?kind=vendor`)).json();
    expect(vendors.map((p: { code: string }) => p.code)).toEqual(['V-001']);
    expect((await as(teacher, 'POST', `/companies/${co}/parties`, { code: 'T-1', name: 'ครู', isCustomer: true, isVendor: false })).statusCode).toBe(403);
  });

  it('สินค้า/บริการ: บัญชีขายต้องเป็นหมวดรายได้ บัญชีซื้อเป็นค่าใช้จ่ายหรือสินทรัพย์', async () => {
    const add = (body: object) => as(owner, 'POST', `/companies/${co}/items`, body);
    const ok = await add({ code: 'SV-1', name: 'ค่าออกแบบ', unit: 'งาน', isService: true, salePrice: '5000', salesAccount: '4120' });
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({ code: 'SV-1', isService: true, salePrice: '5000.00', salesAccount: '4120', purchaseAccount: null });
    expect((await add({ code: 'SV-2', name: 'ผิดหมวด', salesAccount: '1110' })).statusCode).toBe(422);
    expect((await add({ code: 'SV-3', name: 'ไม่มีบัญชี', salesAccount: '9999' })).statusCode).toBe(422);
    expect((await add({ code: 'SV-4', name: 'ราคาผิด', salePrice: '12.345' })).statusCode).toBe(400);
    const e = await as(owner, 'PATCH', `/companies/${co}/items/SV-1`, { version: 1, salePrice: '5500', purchaseAccount: '5260' });
    expect(e.json()).toMatchObject({ salePrice: '5500.00', purchaseAccount: '5260', salesAccount: '4120', version: 2 });
    expect((await as(owner, 'PATCH', `/companies/${co}/items/SV-1`, { version: 2, salesAccount: null })).json()).toMatchObject({ salesAccount: null });
  });

  it('ส่งงานแล้วแก้โปรไฟล์/เพิ่มคู่ค้าไม่ได้ (409 ACC10)', async () => {
    await db.query(`insert into acc.submissions (company_id, status) values ($1, 'submitted')`, [co]);
    const v = (await as(owner, 'GET', `/companies/${co}/profile`)).json().version;
    const r = await as(owner, 'PATCH', `/companies/${co}/profile`, { version: v, address: 'x' });
    expect([r.statusCode, r.json().code]).toEqual([409, 'ACC10']);
    expect((await as(owner, 'POST', `/companies/${co}/parties`, { code: 'L-1', name: 'x', isCustomer: true, isVendor: false })).statusCode).toBe(409);
  });
});
