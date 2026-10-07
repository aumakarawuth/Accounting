import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { pool as db, asUser, newSchool, newUser, newClassroom, newCompany, sqlstate, taxId } from './helpers';
import { lineAmount, vatCalc, type PriceMode } from '../apps/web/lib/vat';
import { fromCents } from '../apps/web/lib/money';

// เฟส 2.2 ขาย (ชั้นฐานข้อมูล): สูตรภาษี กติกาลงบัญชีของแต่ละเอกสาร tax point ของบริการ ลด/เพิ่มหนี้ ยกเลิก
// และค่าคงที่: ยอดคุมลูกหนี้ 1210 = ผลรวมยอดค้างรายใบ, ภาษีขายยังไม่ถึงกำหนด 2211 = ภาษีของบริการที่ยังไม่ได้รับเงิน
afterAll(async () => { await db.end(); });

let school: string, teacher: string, room: string;
beforeAll(async () => {
  school = await newSchool();
  teacher = await newUser(school, 'teacher');
  room = await newClassroom(school, teacher, []);
});

/** บริษัทใหม่ของนักเรียนใหม่: จด VAT (มีเลขภาษี) ลูกค้า C1 (เครดิต 30 วัน) C2 สินค้า G1 บริการ S1 */
async function setup(opts: { vat?: boolean; tax?: boolean } = {}) {
  const owner = await newUser(school, 'student');
  await db.query('insert into acc.enrollments values ($1, $2)', [room, owner]);
  const co = await newCompany(owner, room);
  await db.query(`update acc.companies set tax_id = $2, vat_registered = $3, version = version + 1 where id = $1`,
    [co, opts.tax === false ? null : taxId(Math.floor(Math.random() * 1e9)), opts.vat ?? true]);
  await db.query(`insert into acc.parties (company_id, code, name, is_customer, credit_days) values ($1, 'C1', 'ลูกค้าหนึ่ง', true, 30), ($1, 'C2', 'ลูกค้าสอง', true, 0)`, [co]);
  await db.query(`insert into acc.items (company_id, code, name, unit, is_service) values ($1, 'G1', 'สินค้า', 'ชิ้น', false), ($1, 'S1', 'ค่าบริการ', 'งาน', true)`, [co]);
  return { owner, co };
}

type Line = { item_code?: string; description?: string; qty: string; unit_price: string; account_code?: string };
const doc = (c: pg.PoolClient, co: string, kind: string, p: object, key = randomUUID()) =>
  c.query('select acc.post_sales_document($1, $2, $3::jsonb, $4) id', [co, kind, JSON.stringify(p), key]).then((r) => r.rows[0].id as string);
const receipt = (c: pg.PoolClient, co: string, p: object, key = randomUUID()) =>
  c.query('select acc.post_receipt($1, $2::jsonb, $3) id', [co, JSON.stringify(p), key]).then((r) => r.rows[0].id as string);
const voidDoc = (c: pg.PoolClient, co: string, id: string, date = '2026-10-31', key = randomUUID()) =>
  c.query(`select acc.void_document($1, $2, $3, 'ทดสอบยกเลิก', $4) id`, [co, id, date, key]).then((r) => r.rows[0].id as string);
const goods = (qty: string, price: string): Line => ({ item_code: 'G1', qty, unit_price: price });
const service = (qty: string, price: string): Line => ({ item_code: 'S1', qty, unit_price: price });

async function balance(co: string, code: string) {
  const r = await db.query(
    `select coalesce(sum(l.debit - l.credit), 0)::numeric(18,2)::text b from acc.journal_lines l
       join acc.chart_of_accounts a on a.company_id = l.company_id and a.id = l.account_id where l.company_id = $1 and a.code = $2`, [co, code]);
  return r.rows[0].b as string;
}
async function entry(co: string, docId: string) {
  const r = await db.query(
    `select a.code, l.debit::text, l.credit::text from acc.documents d
       join acc.journal_lines l on l.company_id = d.company_id and l.entry_id = d.entry_id
       join acc.chart_of_accounts a on a.company_id = l.company_id and a.id = l.account_id
      where d.company_id = $1 and d.id = $2 order by l.line_no`, [co, docId]);
  return r.rows.map((x) => [x.code, x.debit, x.credit]);
}
const getDoc = (co: string, id: string) => db.query('select * from acc.documents where company_id = $1 and id = $2', [co, id]).then((r) => r.rows[0]);
async function invariants(co: string) {
  const r = await db.query(
    `select coalesce(sum(open), 0)::numeric(18,2)::text open, coalesce(sum(undue_vat), 0)::numeric(18,2)::text undue from acc.ar_open_items($1)`, [co]);
  expect(await balance(co, '1210')).toBe(r.rows[0].open);
  expect((-Number(await balance(co, '2211'))).toFixed(2)).toBe(r.rows[0].undue);
}

describe('สูตรภาษีมูลค่าเพิ่ม', () => {
  it('SQL (app.vat_calc) กับ TypeScript (lib/vat.ts) ได้ผลตรงกันทุกสตางค์ 10,000 ชุดสุ่ม', async () => {
    let seed = 20261007;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % n; };
    const modes: PriceMode[] = ['exclusive', 'inclusive', 'none'];
    const rates = ['7', '7.00', '10', '0', '7.5', '1.25'];
    const cases = Array.from({ length: 10000 }, () => {
      const gross = BigInt(rnd(1_000_000_000) + 1);
      const discount = BigInt(rnd(Number(gross)));
      return { gross, discount, rate: rates[rnd(rates.length)]!, mode: modes[rnd(3)]! };
    });
    const r = await db.query(
      `select c.base::text, c.vat::text, c.total::text from unnest($1::numeric[], $2::numeric[], $3::numeric[], $4::text[]) with ordinality u(g, d, r, m, o)
         cross join lateral app.vat_calc(u.g, u.d, u.r, u.m) c order by u.o`,
      [cases.map((c) => fromCents(c.gross)), cases.map((c) => fromCents(c.discount)), cases.map((c) => c.rate), cases.map((c) => c.mode)]);
    const ts = cases.map((c) => { const v = vatCalc(c.gross, c.discount, c.rate, c.mode); return { base: fromCents(v.base), vat: fromCents(v.vat), total: fromCents(v.total) }; });
    expect(r.rows).toEqual(ts);
  });

  it('จำนวน × ราคา ปัดสตางค์เหมือนกันทั้งสองฝั่ง', async () => {
    const qty = ['1', '0.333', '2.5', '1234.567', '3'];
    const price = [999n, 1n, 33333n, 12550n, 5n];
    const r = await db.query(`select round(q * p, 2)::text a from unnest($1::numeric[], $2::numeric[]) with ordinality u(q, p, o) order by o`,
      [qty, price.map(fromCents)]);
    expect(r.rows.map((x) => x.a)).toEqual(qty.map((q, i) => fromCents(lineAmount(q, price[i]!)!)));
  });

  it('ตัวอย่างในสเปก: 10,000 แยกภาษี = ภาษี 700 รวม 10,700 · รวมภาษี 10,700 = ฐาน 10,000', () => {
    expect(vatCalc(1_000_000n, 0n, '7', 'exclusive')).toEqual({ base: 1_000_000n, vat: 70_000n, total: 1_070_000n });
    expect(vatCalc(1_070_000n, 0n, '7', 'inclusive')).toEqual({ base: 1_000_000n, vat: 70_000n, total: 1_070_000n });
  });
});

describe('ขายเชื่อและขายสด', () => {
  it('ขายเชื่อสินค้า (แยกภาษี มีส่วนลด): ลูกหนี้ / ขาย + ภาษีขาย, เป็นใบกำกับภาษี, ครบกำหนดตามเครดิต', async () => {
    const { owner, co } = await setup();
    const id = await asUser(owner, (c) => doc(c, co, 'sales_invoice', {
      date: '2026-10-05', party_code: 'c1', discount: '501', lines: [goods('2', '1250.50'), { description: 'สินค้าพิเศษ', qty: '1', unit_price: '3000' }],
    }));
    const d = await getDoc(co, id);
    expect(d).toMatchObject({ doc_no: 'IV-0001', kind: 'sales_invoice', party_code: 'C1', party_name: 'ลูกค้าหนึ่ง', is_service: false, is_tax_invoice: true,
      price_mode: 'exclusive', gross: '5501.00', discount: '501.00', base: '5000.00', vat: '350.00', total: '5350.00', credit_days: 30 });
    expect(d.due_date.toISOString().slice(0, 10)).toBe('2026-11-04');
    expect(await entry(co, id)).toEqual([['1210', '5350.00', '0.00'], ['4110', '0.00', '5000.00'], ['2210', '0.00', '350.00']]);
    // เลขเอกสาร = เลขรายการในสมุดรายวัน
    expect((await db.query('select doc_no from acc.journal_entries where id = $1', [d.entry_id])).rows[0].doc_no).toBe('IV-0001');
    await invariants(co);
  });

  it('ราคารวมภาษี: 10,700 → ฐาน 10,000 ภาษี 700 · ฐานกระจายหลายบัญชีรวมเท่าฐานพอดี', async () => {
    const { owner, co } = await setup();
    const id = await asUser(owner, (c) => doc(c, co, 'sales_invoice', { date: '2026-10-05', party_code: 'C1', price_mode: 'inclusive', lines: [
      { description: 'ก', qty: '1', unit_price: '3566.67' }, { description: 'ข', qty: '1', unit_price: '7133.33', account_code: '4320' },
    ] }));
    expect(await getDoc(co, id)).toMatchObject({ base: '10000.00', vat: '700.00', total: '10700.00' });
    const e = await entry(co, id);
    expect(e[0]).toEqual(['1210', '10700.00', '0.00']);
    const credits = e.slice(1, -1).reduce((s, [, , cr]) => s + Number(cr), 0);
    expect(credits.toFixed(2)).toBe('10000.00');
    expect(e.at(-1)).toEqual(['2210', '0.00', '700.00']);
  });

  it('ขายสด ลูกค้าหัก ณ ที่จ่าย: เงินสด + ภาษีถูกหัก / รายได้ + ภาษีขาย (บริการขายสดถึงกำหนดทันที)', async () => {
    const { owner, co } = await setup();
    const id = await asUser(owner, (c) => doc(c, co, 'cash_sale', { date: '2026-10-06', party_code: 'C2', cash_account: '1120', wht_amount: '300', lines: [service('1', '10000')] }));
    expect(await getDoc(co, id)).toMatchObject({ doc_no: 'CS-0001', is_tax_invoice: true, total: '10700.00', wht_amount: '300.00' });
    expect(await entry(co, id)).toEqual([['1120', '10400.00', '0.00'], ['1420', '300.00', '0.00'], ['4120', '0.00', '10000.00'], ['2210', '0.00', '700.00']]);
    await invariants(co);
  });

  it('สินค้ากับบริการต้องแยกใบ · ลูกค้าไม่มีอยู่ · ส่วนลดเกินยอด · ไม่มีรายการ', async () => {
    const { owner, co } = await setup();
    const fail = async (kind: string, p: object, code: string) =>
      expect(await asUser(owner, (c) => doc(c, co, kind, p)).then(() => 'ok', sqlstate)).toBe(code);
    await fail('sales_invoice', { date: '2026-10-05', party_code: 'C1', lines: [goods('1', '100'), service('1', '100')] }, 'ACC15');
    await fail('sales_invoice', { date: '2026-10-05', party_code: 'X9', lines: [goods('1', '100')] }, 'ACC04');
    await fail('sales_invoice', { date: '2026-10-05', party_code: 'C1', discount: '100', lines: [goods('1', '100')] }, 'ACC05');
    await fail('sales_invoice', { date: '2026-10-05', party_code: 'C1', lines: [] }, '22023');
    await fail('sales_invoice', { date: '2026-10-05', party_code: 'C1', lines: [goods('1.2345', '100')] }, 'ACC05');
    await fail('sales_invoice', { date: '2026-10-05', party_code: 'C1', lines: [{ description: 'x', qty: '1', unit_price: '100', account_code: '1110' }] }, 'ACC04');
  });

  it('ไม่จด VAT: ไม่มีภาษี ไม่ใช่ใบกำกับภาษี · จด VAT แต่ไม่มีเลขภาษีบริษัท: ออกใบกำกับไม่ได้ (บริการเชื่อยังออกได้)', async () => {
    const plain = await setup({ vat: false });
    const id = await asUser(plain.owner, (c) => doc(c, plain.co, 'sales_invoice', { date: '2026-10-05', party_code: 'C1', price_mode: 'exclusive', lines: [goods('1', '1000')] }));
    expect(await getDoc(plain.co, id)).toMatchObject({ price_mode: 'none', vat: '0.00', total: '1000.00', is_tax_invoice: false });
    expect(await entry(plain.co, id)).toEqual([['1210', '1000.00', '0.00'], ['4110', '0.00', '1000.00']]);

    const noTax = await setup({ tax: false });
    expect(await asUser(noTax.owner, (c) => doc(c, noTax.co, 'sales_invoice', { date: '2026-10-05', party_code: 'C1', lines: [goods('1', '1000')] })).then(() => 'ok', sqlstate)).toBe('ACC14');
    expect(await asUser(noTax.owner, (c) => doc(c, noTax.co, 'sales_invoice', { date: '2026-10-05', party_code: 'C1', lines: [service('1', '1000')] })).then(() => 'ok', sqlstate)).toBe('ok');
  });

  it('กดซ้ำด้วย key เดิมได้เอกสารเดิม ไม่เกิดรายการซ้ำ', async () => {
    const { owner, co } = await setup();
    const key = randomUUID();
    const p = { date: '2026-10-05', party_code: 'C1', lines: [goods('1', '100')] };
    const [a, b] = await Promise.all([asUser(owner, (c) => doc(c, co, 'sales_invoice', p, key)), asUser(owner, (c) => doc(c, co, 'sales_invoice', p, key))]);
    expect(a).toBe(b);
    expect((await db.query('select count(*)::int n from acc.documents where company_id = $1', [co])).rows[0].n).toBe(1);
    expect((await db.query('select count(*)::int n from acc.journal_entries where company_id = $1', [co])).rows[0].n).toBe(1);
  });
});

describe('รับชำระและ tax point ของบริการ', () => {
  it('ขายเชื่อบริการ: ภาษีขายยังไม่ถึงกำหนด → รับบางส่วนโอนตามสัดส่วน → รับครบโอนที่เหลือพอดี', async () => {
    const { owner, co } = await setup();
    const iv = await asUser(owner, (c) => doc(c, co, 'sales_invoice', { date: '2026-10-05', party_code: 'C1', lines: [service('1', '10000')] }));
    expect(await getDoc(co, iv)).toMatchObject({ is_service: true, is_tax_invoice: false, vat: '700.00', total: '10700.00' });
    expect(await entry(co, iv)).toEqual([['1210', '10700.00', '0.00'], ['4120', '0.00', '10000.00'], ['2211', '0.00', '700.00']]);

    const r1 = await asUser(owner, (c) => receipt(c, co, { date: '2026-10-10', party_code: 'C1', allocations: [{ document_id: iv, amount: '3333.33' }] }));
    expect(await getDoc(co, r1)).toMatchObject({ doc_no: 'RE-0001', kind: 'receipt', is_tax_invoice: true, total: '3333.33', vat: '218.07' });
    expect(await entry(co, r1)).toEqual([['1110', '3333.33', '0.00'], ['2211', '218.07', '0.00'], ['1210', '0.00', '3333.33'], ['2210', '0.00', '218.07']]);
    await invariants(co);

    // ลูกค้าหัก 3% ของฐานที่เหลือ (7,366.67 − ภาษี 481.93 = 6,884.74 → 206.54)
    const r2 = await asUser(owner, (c) => receipt(c, co, { date: '2026-10-20', party_code: 'C1', cash_account: '1120', wht_amount: '206.54', allocations: [{ document_id: iv, amount: '7366.67' }] }));
    expect(await entry(co, r2)).toEqual([['1120', '7160.13', '0.00'], ['1420', '206.54', '0.00'], ['2211', '481.93', '0.00'], ['1210', '0.00', '7366.67'], ['2210', '0.00', '481.93']]);
    expect(await balance(co, '2211')).toBe('0.00');
    expect(await balance(co, '2210')).toBe('-700.00');
    await invariants(co);
    expect((await db.query('select count(*)::int n from acc.ar_open_items($1)', [co])).rows[0].n).toBe(0);
  });

  it('รับเกินยอดค้าง · ใบของลูกค้าอื่น · ใบเดียวกันซ้ำ · วันที่ก่อนใบ · หัก ณ ที่จ่ายเกินยอด', async () => {
    const { owner, co } = await setup();
    const iv = await asUser(owner, (c) => doc(c, co, 'sales_invoice', { date: '2026-10-05', party_code: 'C1', lines: [goods('1', '1000')] }));
    const fail = async (p: object, code: string) => expect(await asUser(owner, (c) => receipt(c, co, p)).then(() => 'ok', sqlstate)).toBe(code);
    await fail({ date: '2026-10-06', party_code: 'C1', allocations: [{ document_id: iv, amount: '1070.01' }] }, 'ACC15');
    await fail({ date: '2026-10-06', party_code: 'C2', allocations: [{ document_id: iv, amount: '10' }] }, 'ACC15');
    await fail({ date: '2026-10-06', party_code: 'C1', allocations: [{ document_id: iv, amount: '10' }, { document_id: iv, amount: '10' }] }, '22023');
    await fail({ date: '2026-10-04', party_code: 'C1', allocations: [{ document_id: iv, amount: '10' }] }, '22023');
    await fail({ date: '2026-10-06', party_code: 'C1', wht_amount: '10', allocations: [{ document_id: iv, amount: '10' }] }, 'ACC05');
  });

  it('รับชำระพร้อมกันสองหน้าจอเต็มยอดใบเดียวกัน: ใบที่สองรอใบแรกจบแล้วถูกปฏิเสธ ไม่ตัดเกิน', async () => {
    const { owner, co } = await setup();
    const iv = await asUser(owner, (c) => doc(c, co, 'sales_invoice', { date: '2026-10-05', party_code: 'C1', lines: [goods('1', '1000')] }));
    const p = { date: '2026-10-06', party_code: 'C1', allocations: [{ document_id: iv, amount: '1070' }] };
    // จังหวะแน่นอน: ทรานแซกชันแรกรับชำระแล้วค้างไว้ยังไม่ commit ทรานแซกชันที่สองเริ่มระหว่างนั้น
    const first = await db.connect();
    try {
      await first.query('begin');
      await first.query('set local role app_rw');
      await first.query(`select set_config('app.user_id', $1, true)`, [owner]);
      await receipt(first, co, p);
      const second = asUser(owner, (c) => receipt(c, co, p)).then(() => 'ok', sqlstate);
      await new Promise((r) => setTimeout(r, 300)); // ให้ทรานแซกชันที่สองไปถึงจุดที่ต้องรอ
      await first.query('commit');
      expect(await second).toBe('ACC15');
    } finally {
      first.release();
    }
    expect((await db.query(`select count(*)::int n from acc.documents where company_id = $1 and kind = 'receipt'`, [co])).rows[0].n).toBe(1);
    await invariants(co);
  });
});

describe('ใบลดหนี้ / ใบเพิ่มหนี้ / ยกเลิก', () => {
  it('ลดหนี้สินค้า: รับคืน + ภาษีขาย / ลูกหนี้ ลดได้ไม่เกินยอดค้าง', async () => {
    const { owner, co } = await setup();
    const iv = await asUser(owner, (c) => doc(c, co, 'sales_invoice', { date: '2026-10-05', party_code: 'C1', lines: [goods('10', '1000')] }));
    const cn = await asUser(owner, (c) => doc(c, co, 'credit_note', { date: '2026-10-08', ref_document_id: iv, reason: 'สินค้าชำรุด', lines: [goods('1', '1000')] }));
    expect(await getDoc(co, cn)).toMatchObject({ doc_no: 'CN-0001', is_tax_invoice: true, total: '1070.00', ref_document_id: iv, reason: 'สินค้าชำรุด' });
    expect(await entry(co, cn)).toEqual([['4220', '1000.00', '0.00'], ['2210', '70.00', '0.00'], ['1210', '0.00', '1070.00']]);
    await invariants(co);
    expect(await asUser(owner, (c) => doc(c, co, 'credit_note', { date: '2026-10-08', ref_document_id: iv, reason: 'เกิน', lines: [goods('9', '1000.01')] })).then(() => 'ok', sqlstate)).toBe('ACC15');
    expect(await asUser(owner, (c) => doc(c, co, 'credit_note', { date: '2026-10-08', ref_document_id: iv, lines: [goods('1', '1')] })).then(() => 'ok', sqlstate)).toBe('22023');
  });

  it('ลดหนี้บริการที่ยังไม่รับเงิน: ลดภาษีขายยังไม่ถึงกำหนด · ใบเพิ่มหนี้เป็นยอดค้างที่รับชำระได้', async () => {
    const { owner, co } = await setup();
    const iv = await asUser(owner, (c) => doc(c, co, 'sales_invoice', { date: '2026-10-05', party_code: 'C1', lines: [service('1', '5000')] }));
    const cn = await asUser(owner, (c) => doc(c, co, 'credit_note', { date: '2026-10-08', ref_document_id: iv, reason: 'ลดราคา', lines: [{ description: 'ลดค่าบริการ', qty: '1', unit_price: '1000', account_code: '4210' }] }));
    expect(await entry(co, cn)).toEqual([['4210', '1000.00', '0.00'], ['2211', '70.00', '0.00'], ['1210', '0.00', '1070.00']]);
    const dn = await asUser(owner, (c) => doc(c, co, 'debit_note', { date: '2026-10-09', ref_document_id: iv, reason: 'งานเพิ่ม', lines: [service('1', '500')] }));
    expect(await getDoc(co, dn)).toMatchObject({ doc_no: 'DN-0001', is_service: true, total: '535.00', due_date: expect.any(Date) });
    expect(await entry(co, dn)).toEqual([['1210', '535.00', '0.00'], ['4120', '0.00', '500.00'], ['2211', '0.00', '35.00']]);
    await invariants(co);
    await asUser(owner, (c) => receipt(c, co, { date: '2026-10-15', party_code: 'C1', allocations: [{ document_id: iv, amount: '4280' }, { document_id: dn, amount: '535' }] }));
    expect(await balance(co, '2211')).toBe('0.00');
    expect(await balance(co, '1210')).toBe('0.00');
    await invariants(co);
  });

  it('ยกเลิก: ใบที่มีรับชำระอ้างอยู่ยกเลิกไม่ได้ · ยกเลิกรับชำระก่อนแล้วยกเลิกใบได้ · ยอดกลับเป็นศูนย์', async () => {
    const { owner, co } = await setup();
    const iv = await asUser(owner, (c) => doc(c, co, 'sales_invoice', { date: '2026-10-05', party_code: 'C1', lines: [service('1', '1000')] }));
    const re = await asUser(owner, (c) => receipt(c, co, { date: '2026-10-06', party_code: 'C1', allocations: [{ document_id: iv, amount: '500' }] }));
    expect(await asUser(owner, (c) => voidDoc(c, co, iv)).then(() => 'ok', sqlstate)).toBe('ACC16');
    const key = randomUUID();
    const rv = await asUser(owner, (c) => voidDoc(c, co, re, '2026-10-07', key));
    expect(await asUser(owner, (c) => voidDoc(c, co, re, '2026-10-07', key))).toBe(rv); // กดซ้ำ
    expect(await asUser(owner, (c) => voidDoc(c, co, re)).then(() => 'ok', sqlstate)).toBe('ACC16');
    await invariants(co);
    await asUser(owner, (c) => voidDoc(c, co, iv));
    for (const code of ['1110', '1210', '2210', '2211', '4120']) expect(await balance(co, code)).toBe('0.00');
    expect((await getDoc(co, iv)).void_reason).toBe('ทดสอบยกเลิก');
    await invariants(co);
  });

  it('เอกสารที่ออกแล้วแก้/ลบไม่ได้แม้จากชั้นฐานข้อมูล', async () => {
    const { owner, co } = await setup();
    const iv = await asUser(owner, (c) => doc(c, co, 'sales_invoice', { date: '2026-10-05', party_code: 'C1', lines: [goods('1', '100')] }));
    await expect(db.query('update acc.documents set total = 1 where id = $1', [iv])).rejects.toMatchObject({ code: 'ACC06' });
    await expect(db.query('delete from acc.documents where id = $1', [iv])).rejects.toThrow();
    await expect(db.query('update acc.document_lines set amount = 1 where document_id = $1', [iv])).rejects.toThrow();
  });
});

describe('ค่าคงที่ลูกหนี้หลังลำดับเอกสารสุ่ม', () => {
  it('ขาย/รับบางส่วน/ลดหนี้/เพิ่มหนี้/ยกเลิก 200 ครั้ง: 1210 = ยอดค้างรวม และ 2211 = ภาษีบริการค้างรับ ทุกขั้น', async () => {
    const { owner, co } = await setup();
    let seed = 7;
    const rnd = (n: number) => { seed = (seed * 48271) % 2147483647; return seed % n; };
    const money = (max: number) => (rnd(max * 100) / 100 + 0.01).toFixed(2);
    for (let i = 0; i < 200; i++) {
      const open = (await db.query('select document_id, open::text, is_service from acc.ar_open_items($1)', [co])).rows;
      const op = rnd(10);
      await asUser(owner, async (c) => {
          if (op < 3 || open.length === 0) {
            await doc(c, co, 'sales_invoice', { date: '2026-10-05', party_code: 'C1', price_mode: rnd(2) ? 'inclusive' : 'exclusive', discount: rnd(3) ? '0' : '1.11',
              lines: [rnd(2) ? service(String(rnd(5) + 1), money(3000)) : goods(String(rnd(5) + 1), money(3000))] });
          } else {
            const t = open[rnd(open.length)]!;
            const part = Math.max(0.01, Math.floor(Number(t.open) * (rnd(100) + 1)) / 100).toFixed(2);
            if (op < 7) await receipt(c, co, { date: '2026-10-10', party_code: 'C1', allocations: [{ document_id: t.document_id, amount: part }] });
            // ลดหนี้บริการที่ภาษีที่ปัดแล้วเกินภาษียังไม่ถึงกำหนดที่เหลือถูกปฏิเสธได้ตามกติกา (ACC15) นอกนั้นต้องผ่าน
            else if (op === 7) await doc(c, co, 'credit_note', { date: '2026-10-10', ref_document_id: t.document_id, reason: 'สุ่ม',
              lines: [{ description: 'ลด', qty: '1', unit_price: (Number(part) / 1.07).toFixed(2) }] })
              .catch((e) => { if (sqlstate(e) !== 'ACC15' || !t.is_service) throw e; });
            else if (op === 8) {
              const src = (await c.query(`select id from acc.documents where company_id = $1 and kind in ('receipt','credit_note') and voided_at is null order by random() limit 1`, [co])).rows[0];
              if (src) await voidDoc(c, co, src.id);
            } else {
              const iv = (await c.query(`select kind from acc.documents where id = $1`, [t.document_id])).rows[0].kind;
              if (iv === 'sales_invoice') { // ใบเพิ่มหนี้อ้างได้เฉพาะใบขายเชื่อ
                await doc(c, co, 'debit_note', { date: '2026-10-10', ref_document_id: t.document_id, reason: 'สุ่ม', lines: [{ description: 'เพิ่ม', qty: '1', unit_price: money(500) }] });
              }
            }
          }
      });
      await invariants(co);
    }
    const sum = await db.query(`select count(*) filter (where kind = 'receipt')::int re, count(*) filter (where voided_at is not null)::int v,
      count(*) filter (where is_service and kind = 'sales_invoice')::int svc, count(*) filter (where kind in ('credit_note', 'debit_note'))::int notes
      from acc.documents where company_id = $1`, [co]);
    expect(sum.rows[0].re).toBeGreaterThan(20);
    expect(sum.rows[0].v).toBeGreaterThan(3);
    expect(sum.rows[0].svc).toBeGreaterThan(10);
    expect(sum.rows[0].notes).toBeGreaterThan(10);
  });
});

describe('สิทธิ์และการล็อก', () => {
  it('นักเรียนคนอื่นอ่านเอกสารไม่ได้ ครูอ่านได้แต่ออกไม่ได้ · ส่งงานแล้วออกเอกสารไม่ได้', async () => {
    const { owner, co } = await setup();
    await asUser(owner, (c) => doc(c, co, 'sales_invoice', { date: '2026-10-05', party_code: 'C1', lines: [goods('1', '100')] }));
    const other = await newUser(school, 'student');
    const count = (u: string) => asUser(u, async (c) => (await c.query('select count(*)::int n from acc.documents where company_id = $1', [co])).rows[0].n);
    expect(await count(other)).toBe(0);
    expect(await count(teacher)).toBe(1);
    expect(await asUser(teacher, (c) => doc(c, co, 'sales_invoice', { date: '2026-10-05', party_code: 'C1', lines: [goods('1', '100')] })).then(() => 'ok', sqlstate)).toBe('42501');
    await db.query(`insert into acc.submissions (company_id, status) values ($1, 'submitted')`, [co]);
    expect(await asUser(owner, (c) => doc(c, co, 'sales_invoice', { date: '2026-10-05', party_code: 'C1', lines: [goods('1', '100')] })).then(() => 'ok', sqlstate)).toBe('ACC10');
  });

  it('บริษัทที่ไม่มีบัญชีภาษีใหม่ (ถูกล็อกตอนอัปเดตระบบ) ได้บัญชีอัตโนมัติตอนออกเอกสารครั้งแรก', async () => {
    const { owner, co } = await setup();
    await db.query(`delete from acc.chart_of_accounts where company_id = $1 and code in ('2211', '1411')`, [co]);
    await asUser(owner, (c) => doc(c, co, 'sales_invoice', { date: '2026-10-05', party_code: 'C1', lines: [service('1', '100')] }));
    expect((await db.query(`select count(*)::int n from acc.chart_of_accounts where company_id = $1 and code in ('2211', '1411')`, [co])).rows[0].n).toBe(2);
  });
});
