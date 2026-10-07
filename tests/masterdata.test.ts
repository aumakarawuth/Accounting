import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool as db, asUser, newSchool, newUser, newClassroom, newCompany, sqlstate, taxId } from './helpers';

// เฟส 2.1 ข้อมูลหลัก: เลขผู้เสียภาษี โปรไฟล์ภาษีบริษัท ลูกค้า/ผู้ขาย สินค้า/บริการ (ชั้นฐานข้อมูล)
afterAll(async () => { await db.end(); });

let school: string, teacher: string, s1: string, s2: string, room: string, co1: string, co2: string;

beforeAll(async () => {
  school = await newSchool();
  teacher = await newUser(school, 'teacher');
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
