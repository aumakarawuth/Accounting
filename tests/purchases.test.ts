import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { pool as db, asUser, newSchool, newUser, newClassroom, newCompany, sqlstate, taxId } from './helpers';

// เฟส 2.3 ซื้อ (ชั้นฐานข้อมูล): กติกาลงบัญชีของแต่ละเอกสาร ภาษีซื้อขอคืนได้/ไม่ได้ tax point ของบริการ
// หัก ณ ที่จ่าย + 50 ทวิ ใบลดหนี้ ยกเลิก และค่าคงที่: ยอดคุมเจ้าหนี้ 2110 = ผลรวมยอดค้างรายใบ,
// ภาษีซื้อยังไม่ถึงกำหนด 1411 = ภาษีของบริการที่ยังไม่ได้จ่ายเงิน
afterAll(async () => { await db.end(); });

/** เลขผู้เสียภาษีนิติบุคคล (ขึ้นต้น 0) ที่หลักตรวจสอบถูก */
function juristicId(seed: number) {
  const first12 = '0' + String(10_555_000_000 + (seed % 1_000_000_000)).padStart(11, '0');
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(first12[i]) * (13 - i);
  return first12 + ((11 - (sum % 11)) % 10);
}

let school: string, teacher: string, room: string;
beforeAll(async () => {
  school = await newSchool();
  teacher = await newUser(school, 'teacher');
  room = await newClassroom(school, teacher, []);
});

/**
 * บริษัทใหม่ของนักเรียนใหม่ (จด VAT ค่าเริ่มต้น) ผู้ขาย: V1 นิติบุคคลจด VAT เครดิต 30 วัน · V2 บุคคลธรรมดาไม่จด VAT
 * · V3 ไม่มีเลขภาษี · สินค้า G1 บริการ S1 ค่าเช่า R1 (ลงบัญชีค่าเช่า 5220)
 */
async function setup(opts: { vat?: boolean } = {}) {
  const owner = await newUser(school, 'student');
  await db.query('insert into acc.enrollments values ($1, $2)', [room, owner]);
  const co = await newCompany(owner, room);
  await db.query(`update acc.companies set tax_id = $2, vat_registered = $3, address = 'กรุงเทพฯ', version = version + 1 where id = $1`,
    [co, juristicId(Math.floor(Math.random() * 1e9)), opts.vat ?? true]);
  await db.query(`insert into acc.parties (company_id, code, name, is_vendor, credit_days, vat_registered, tax_id) values
    ($1, 'V1', 'บริษัท วัสดุ จำกัด', true, 30, true, $2), ($1, 'V2', 'นายช่าง ใจดี', true, 0, false, $3), ($1, 'V3', 'ร้านไม่มีเลข', true, 0, false, null)`,
    [co, juristicId(7), taxId(77)]);
  await db.query(`insert into acc.items (company_id, code, name, unit, is_service, purchase_account_id) values
    ($1, 'G1', 'สินค้า', 'ชิ้น', false, null), ($1, 'S1', 'ค่าบริการ', 'งาน', true, null),
    ($1, 'R1', 'ค่าเช่า', 'เดือน', true, (select id from acc.chart_of_accounts where company_id = $1 and code = '5220'))`, [co]);
  return { owner, co };
}

type Line = { item_code?: string; description?: string; qty: string; unit_price: string; account_code?: string };
const doc = (c: pg.PoolClient, co: string, kind: string, p: object, key = randomUUID()) =>
  c.query('select acc.post_purchase_document($1, $2, $3::jsonb, $4) id', [co, kind, JSON.stringify({ vendor_doc_no: `INV-${randomUUID().slice(0, 8)}`, ...p }), key])
    .then((r) => r.rows[0].id as string);
const payment = (c: pg.PoolClient, co: string, p: object, key = randomUUID()) =>
  c.query('select acc.post_payment($1, $2::jsonb, $3) id', [co, JSON.stringify(p), key]).then((r) => r.rows[0].id as string);
const voidDoc = (c: pg.PoolClient, co: string, id: string, date = '2026-10-31', key = randomUUID()) =>
  c.query(`select acc.void_purchase_document($1, $2, $3, 'ทดสอบยกเลิก', $4) id`, [co, id, date, key]).then((r) => r.rows[0].id as string);
const goods = (qty: string, price: string): Line => ({ item_code: 'G1', qty, unit_price: price });
const service = (qty: string, price: string): Line => ({ item_code: 'S1', qty, unit_price: price });

async function balance(co: string, code: string) {
  const r = await db.query(
    `select coalesce(sum(l.debit - l.credit), 0)::numeric(18,2)::text b from acc.journal_lines l
       join acc.chart_of_accounts a on a.company_id = l.company_id and a.id = l.account_id where l.company_id = $1 and a.code = $2`, [co, code]);
  return r.rows[0].b as string;
}
/** รายการบัญชีของเอกสาร [รหัส, เดบิต, เครดิต] เรียงตามรหัสบัญชี (ลำดับบรรทัดของบัญชีที่แบ่งยอดไม่กำหนด) */
async function entry(co: string, docId: string) {
  const r = await db.query(
    `select a.code, l.debit::text, l.credit::text from acc.purchase_documents d
       join acc.journal_lines l on l.company_id = d.company_id and l.entry_id = d.entry_id
       join acc.chart_of_accounts a on a.company_id = l.company_id and a.id = l.account_id
      where d.company_id = $1 and d.id = $2 order by a.code, l.line_no`, [co, docId]);
  return r.rows.map((x) => [x.code, x.debit, x.credit]);
}
const getDoc = (co: string, id: string) => db.query('select * from acc.purchase_documents where company_id = $1 and id = $2', [co, id]).then((r) => r.rows[0]);
const getCert = (co: string, id: string) => db.query('select * from acc.wht_certificates where company_id = $1 and document_id = $2', [co, id]).then((r) => r.rows[0]);
async function invariants(co: string) {
  const r = await db.query(
    `select coalesce(sum(open), 0)::numeric(18,2)::text open, coalesce(sum(undue_vat), 0)::numeric(18,2)::text undue from acc.ap_open_items($1)`, [co]);
  expect((-Number(await balance(co, '2110'))).toFixed(2)).toBe(r.rows[0].open);
  expect(await balance(co, '1411')).toBe(r.rows[0].undue);
}

describe('ซื้อเชื่อและซื้อสด', () => {
  it('ซื้อเชื่อสินค้า (แยกภาษี มีส่วนลด หลายบัญชี): ซื้อ/สินทรัพย์ + ภาษีซื้อ / เจ้าหนี้, ครบกำหนดตามเครดิต', async () => {
    const { owner, co } = await setup();
    const id = await asUser(owner, (c) => doc(c, co, 'purchase_invoice', {
      date: '2026-10-05', party_code: 'v1', vendor_doc_no: ' iv-2569/001 ', discount: '501',
      lines: [goods('2', '1250.50'), { description: 'เครื่องพิมพ์', qty: '1', unit_price: '3000', account_code: '1630' }],
    }));
    const d = await getDoc(co, id);
    expect(d).toMatchObject({ doc_no: 'PI-0001', kind: 'purchase_invoice', vendor_doc_no: 'iv-2569/001', party_code: 'V1', is_service: false,
      vat_claimable: true, price_mode: 'exclusive', gross: '5501.00', discount: '501.00', base: '5000.00', vat: '350.00', total: '5350.00', credit_days: 30 });
    expect(d.due_date.toISOString().slice(0, 10)).toBe('2026-11-04');
    // ฐาน 5,000 แบ่งตามสัดส่วน 2,501 : 3,000 เศษสตางค์ไปบัญชีที่ยอดมากสุด
    expect(await entry(co, id)).toEqual([['1410', '350.00', '0.00'], ['1630', '2726.78', '0.00'], ['2110', '0.00', '5350.00'], ['5110', '2273.22', '0.00']]);
    expect((await db.query('select doc_no from acc.journal_entries where id = $1', [d.entry_id])).rows[0].doc_no).toBe('PI-0001');
    await invariants(co);
  });

  it('ผู้ขายไม่จด VAT: ไม่มีภาษีแม้เลือกแบบราคา · บริษัทไม่จด VAT: ภาษีที่จ่ายรวมเป็นต้นทุน (ไม่ลงภาษีซื้อ)', async () => {
    const { owner, co } = await setup();
    const a = await asUser(owner, (c) => doc(c, co, 'purchase_invoice', { date: '2026-10-05', party_code: 'V2', price_mode: 'inclusive', lines: [service('1', '2000')] }));
    expect(await getDoc(co, a)).toMatchObject({ price_mode: 'none', vat: '0.00', total: '2000.00', vat_claimable: false });
    expect(await entry(co, a)).toEqual([['2110', '0.00', '2000.00'], ['5260', '2000.00', '0.00']]);

    const nv = await setup({ vat: false });
    const b = await asUser(nv.owner, (c) => doc(c, nv.co, 'purchase_invoice', { date: '2026-10-05', party_code: 'V1', price_mode: 'inclusive', lines: [goods('1', '10700')] }));
    expect(await getDoc(nv.co, b)).toMatchObject({ base: '10000.00', vat: '700.00', total: '10700.00', vat_claimable: false });
    expect(await entry(nv.co, b)).toEqual([['2110', '0.00', '10700.00'], ['5110', '10700.00', '0.00']]);
    await invariants(co);
    await invariants(nv.co);
  });

  it('ซื้อสดบริการ หัก ณ ที่จ่าย 3%: ค่าใช้จ่าย + ภาษีซื้อ (ถึงกำหนดทันที) / เงินฝาก + ภาษีหัก ณ ที่จ่ายค้างจ่าย + 50 ทวิ', async () => {
    const { owner, co } = await setup();
    const id = await asUser(owner, (c) => doc(c, co, 'cash_purchase', { date: '2026-10-06', party_code: 'V1', cash_account: '1120', wht_kind: 'service', lines: [service('1', '10000')] }));
    expect(await getDoc(co, id)).toMatchObject({ doc_no: 'CP-0001', vat_claimable: true, total: '10700.00', wht_kind: 'service', wht_rate: '3.00', wht_base: '10000.00', wht_amount: '300.00' });
    expect(await entry(co, id)).toEqual([['1120', '0.00', '10400.00'], ['1410', '700.00', '0.00'], ['2230', '0.00', '300.00'], ['5260', '10000.00', '0.00']]);
    expect(await getCert(co, id)).toMatchObject({ cert_no: 'WT-0001', form: 'pnd53', payee_name: 'บริษัท วัสดุ จำกัด', payee_tax_id: juristicId(7),
      payer_address: 'กรุงเทพฯ', wht_kind: 'service', wht_rate: '3.00', base: '10000.00', amount: '300.00', voided_at: null });
    // ค่าเช่าจ่ายบุคคลธรรมดา: บัญชีจากสินค้า อัตรามาตรฐาน 5% แบบ ภ.ง.ด.3 เลข WT ต่อเนื่อง
    const rent = await asUser(owner, (c) => doc(c, co, 'cash_purchase', { date: '2026-10-07', party_code: 'V2', wht_kind: 'rent', lines: [{ item_code: 'R1', qty: '1', unit_price: '8000' }] }));
    expect(await entry(co, rent)).toEqual([['1110', '0.00', '7600.00'], ['2230', '0.00', '400.00'], ['5220', '8000.00', '0.00']]);
    expect(await getCert(co, rent)).toMatchObject({ cert_no: 'WT-0002', form: 'pnd3', wht_rate: '5.00', base: '8000.00', amount: '400.00' });
    // อัตราที่ใส่เอง
    const other = await asUser(owner, (c) => doc(c, co, 'cash_purchase', { date: '2026-10-07', party_code: 'V2', wht_kind: 'other', wht_rate: '1.5', lines: [service('1', '1000')] }));
    expect(await getCert(co, other)).toMatchObject({ cert_no: 'WT-0003', wht_rate: '1.50', amount: '15.00' });
  });

  it('ข้อผิดพลาด: ผู้ขายไม่มีอยู่/เป็นลูกค้า · ไม่มีเลขที่ของผู้ขาย · สินค้ากับบริการปน · บัญชีไม่ใช่ค่าใช้จ่าย · หักตอนซื้อเชื่อ · ไม่มีเลขภาษีแต่หัก', async () => {
    const { owner, co } = await setup();
    await db.query(`insert into acc.parties (company_id, code, name, is_customer) values ($1, 'C1', 'ลูกค้า', true)`, [co]);
    const fail = async (kind: string, p: object, code: string) =>
      expect(await asUser(owner, (c) => doc(c, co, kind, p)).then(() => 'ok', sqlstate)).toBe(code);
    await fail('purchase_invoice', { date: '2026-10-05', party_code: 'X9', lines: [goods('1', '1')] }, 'ACC04');
    await fail('purchase_invoice', { date: '2026-10-05', party_code: 'C1', lines: [goods('1', '1')] }, 'ACC04');
    await fail('purchase_invoice', { date: '2026-10-05', party_code: 'V1', vendor_doc_no: '  ', lines: [goods('1', '1')] }, '22023');
    await fail('purchase_invoice', { date: '2026-10-05', party_code: 'V1', lines: [goods('1', '1'), service('1', '1')] }, 'ACC15');
    await fail('purchase_invoice', { date: '2026-10-05', party_code: 'V1', lines: [{ description: 'ก', qty: '1', unit_price: '1', account_code: '1110' }] }, 'ACC04');
    await fail('purchase_invoice', { date: '2026-10-05', party_code: 'V1', lines: [{ description: 'ก', qty: '1', unit_price: '1', account_code: '4110' }] }, 'ACC04');
    await fail('purchase_invoice', { date: '2026-10-05', party_code: 'V1', wht_kind: 'service', lines: [service('1', '1000')] }, '22023');
    await fail('cash_purchase', { date: '2026-10-05', party_code: 'V3', wht_kind: 'service', lines: [service('1', '1000')] }, 'ACC14');
    await fail('cash_purchase', { date: '2026-10-05', party_code: 'V1', wht_kind: 'tips', lines: [service('1', '1000')] }, '22023');
    await fail('cash_purchase', { date: '2026-10-05', party_code: 'V1', wht_kind: 'other', wht_rate: '20', lines: [service('1', '1000')] }, 'ACC05');
    await fail('cash_purchase', { date: '2026-10-05', party_code: 'V1', wht_kind: 'other', lines: [service('1', '1000')] }, 'ACC05');
  });

  it('ใบของผู้ขายใบเดียวบันทึกซ้ำไม่ได้ (ไม่สนตัวพิมพ์/ช่องว่าง) ยกเลิกแล้วบันทึกใหม่ได้ · ผู้ขายอื่นเลขเดียวกันได้', async () => {
    const { owner, co } = await setup();
    const p = { date: '2026-10-05', party_code: 'V1', vendor_doc_no: 'A-001', lines: [goods('1', '100')] };
    const first = await asUser(owner, (c) => doc(c, co, 'purchase_invoice', p));
    expect(await asUser(owner, (c) => doc(c, co, 'purchase_invoice', { ...p, vendor_doc_no: ' a-001' })).then(() => 'ok', sqlstate)).toBe('ACC15');
    expect(await asUser(owner, (c) => doc(c, co, 'cash_purchase', p)).then(() => 'ok', sqlstate)).toBe('ACC15');
    await asUser(owner, (c) => doc(c, co, 'purchase_invoice', { ...p, party_code: 'V2' }));
    await asUser(owner, (c) => voidDoc(c, co, first));
    await asUser(owner, (c) => doc(c, co, 'purchase_invoice', p));
  });

  it('กดซ้ำด้วย key เดิมได้เอกสารเดิม ไม่เกิดรายการหรือ 50 ทวิ ซ้ำ', async () => {
    const { owner, co } = await setup();
    const key = randomUUID();
    const p = { date: '2026-10-05', party_code: 'V1', vendor_doc_no: 'K-1', wht_kind: 'service', lines: [service('1', '5000')] };
    const a = await asUser(owner, (c) => doc(c, co, 'cash_purchase', p, key));
    const b = await asUser(owner, (c) => doc(c, co, 'cash_purchase', p, key));
    expect(b).toBe(a);
    const n = await db.query(`select (select count(*) from acc.purchase_documents where company_id = $1)::int d,
      (select count(*) from acc.wht_certificates where company_id = $1)::int w, (select count(*) from acc.journal_entries where company_id = $1)::int e`, [co]);
    expect(n.rows[0]).toEqual({ d: 1, w: 1, e: 1 });
  });
});

describe('จ่ายชำระ หัก ณ ที่จ่าย และ tax point ของบริการ', () => {
  it('ซื้อเชื่อบริการ: ภาษีซื้อยังไม่ถึงกำหนด → จ่ายบางส่วนพร้อมหัก 3% → จ่ายครบโอนภาษีที่เหลือพอดี', async () => {
    const { owner, co } = await setup();
    const pi = await asUser(owner, (c) => doc(c, co, 'purchase_invoice', { date: '2026-10-05', party_code: 'V1', lines: [service('1', '10000')] }));
    expect(await entry(co, pi)).toEqual([['1411', '700.00', '0.00'], ['2110', '0.00', '10700.00'], ['5260', '10000.00', '0.00']]);
    await invariants(co);

    // ฐานหัก = 3,333.33 × 10,000/10,700 = 3,115.26 → 93.46 · ภาษีถึงกำหนด 3,333.33 × 700/10,700 = 218.07
    const p1 = await asUser(owner, (c) => payment(c, co, { date: '2026-10-10', party_code: 'V1', wht_kind: 'service', allocations: [{ document_id: pi, amount: '3333.33' }] }));
    expect(await getDoc(co, p1)).toMatchObject({ doc_no: 'PV-0001', kind: 'payment', vendor_doc_no: null, total: '3333.33', vat: '218.07', wht_base: '3115.26', wht_amount: '93.46' });
    expect(await entry(co, p1)).toEqual([['1110', '0.00', '3239.87'], ['1410', '218.07', '0.00'], ['1411', '0.00', '218.07'], ['2110', '3333.33', '0.00'], ['2230', '0.00', '93.46']]);
    expect(await getCert(co, p1)).toMatchObject({ cert_no: 'WT-0001', base: '3115.26', amount: '93.46', cert_date: expect.any(Date) });
    await invariants(co);

    const p2 = await asUser(owner, (c) => payment(c, co, { date: '2026-10-20', party_code: 'V1', cash_account: '1120', allocations: [{ document_id: pi, amount: '7366.67' }] }));
    expect(await entry(co, p2)).toEqual([['1120', '0.00', '7366.67'], ['1410', '481.93', '0.00'], ['1411', '0.00', '481.93'], ['2110', '7366.67', '0.00']]);
    expect(await getCert(co, p2)).toBeUndefined();
    expect(await balance(co, '1411')).toBe('0.00');
    expect(await balance(co, '1410')).toBe('700.00');
    await invariants(co);
    expect((await db.query('select count(*)::int n from acc.ap_open_items($1)', [co])).rows[0].n).toBe(0);
  });

  it('จ่ายหลายใบครั้งเดียว: ฐานหักรวมจากทุกใบ ภาษีโอนเฉพาะใบบริการ', async () => {
    const { owner, co } = await setup();
    const a = await asUser(owner, (c) => doc(c, co, 'purchase_invoice', { date: '2026-10-05', party_code: 'V1', lines: [service('1', '1000')] }));
    const b = await asUser(owner, (c) => doc(c, co, 'purchase_invoice', { date: '2026-10-05', party_code: 'V1', lines: [goods('1', '2000')] }));
    const pv = await asUser(owner, (c) => payment(c, co, { date: '2026-10-10', party_code: 'V1', wht_kind: 'service', allocations: [{ document_id: b, amount: '2140' }, { document_id: a, amount: '1070' }] }));
    expect(await getDoc(co, pv)).toMatchObject({ total: '3210.00', vat: '70.00', wht_base: '3000.00', wht_amount: '90.00' });
    expect(await entry(co, pv)).toEqual([['1110', '0.00', '3120.00'], ['1410', '70.00', '0.00'], ['1411', '0.00', '70.00'], ['2110', '3210.00', '0.00'], ['2230', '0.00', '90.00']]);
    await invariants(co);
  });

  it('จ่ายเกินยอดค้าง · ใบของผู้ขายอื่น · ใบเดียวกันซ้ำ · วันที่ก่อนใบ · ผู้ขายไม่มีเลขภาษีแต่หัก', async () => {
    const { owner, co } = await setup();
    const pi = await asUser(owner, (c) => doc(c, co, 'purchase_invoice', { date: '2026-10-05', party_code: 'V1', lines: [goods('1', '1000')] }));
    const v3 = await asUser(owner, (c) => doc(c, co, 'purchase_invoice', { date: '2026-10-05', party_code: 'V3', lines: [service('1', '1000')] }));
    const fail = async (p: object, code: string) => expect(await asUser(owner, (c) => payment(c, co, p)).then(() => 'ok', sqlstate)).toBe(code);
    await fail({ date: '2026-10-06', party_code: 'V1', allocations: [{ document_id: pi, amount: '1070.01' }] }, 'ACC15');
    await fail({ date: '2026-10-06', party_code: 'V2', allocations: [{ document_id: pi, amount: '10' }] }, 'ACC15');
    await fail({ date: '2026-10-06', party_code: 'V1', allocations: [{ document_id: pi, amount: '10' }, { document_id: pi, amount: '10' }] }, '22023');
    await fail({ date: '2026-10-04', party_code: 'V1', allocations: [{ document_id: pi, amount: '10' }] }, '22023');
    await fail({ date: '2026-10-06', party_code: 'V3', wht_kind: 'service', allocations: [{ document_id: v3, amount: '1000' }] }, 'ACC14');
    await fail({ date: '2026-10-06', party_code: 'V1', wht_kind: 'service', allocations: [{ document_id: pi, amount: '0.10' }] }, 'ACC05'); // หักได้ 0.00
  });

  it('จ่ายชำระพร้อมกันสองหน้าจอเต็มยอดใบเดียวกัน: ใบที่สองรอใบแรกจบแล้วถูกปฏิเสธ ไม่ตัดเกิน', async () => {
    const { owner, co } = await setup();
    const pi = await asUser(owner, (c) => doc(c, co, 'purchase_invoice', { date: '2026-10-05', party_code: 'V1', lines: [goods('1', '1000')] }));
    const p = { date: '2026-10-06', party_code: 'V1', allocations: [{ document_id: pi, amount: '1070' }] };
    const first = await db.connect();
    try {
      await first.query('begin');
      await first.query('set local role app_rw');
      await first.query(`select set_config('app.user_id', $1, true)`, [owner]);
      await payment(first, co, p);
      const second = asUser(owner, (c) => payment(c, co, p)).then(() => 'ok', sqlstate);
      await new Promise((r) => setTimeout(r, 300)); // ให้ทรานแซกชันที่สองไปถึงจุดที่ต้องรอ
      await first.query('commit');
      expect(await second).toBe('ACC15');
    } finally {
      first.release();
    }
    expect((await db.query(`select count(*)::int n from acc.purchase_documents where company_id = $1 and kind = 'payment'`, [co])).rows[0].n).toBe(1);
    await invariants(co);
  });
});

describe('ใบลดหนี้จากผู้ขาย / ยกเลิก', () => {
  it('ลดหนี้สินค้า: เจ้าหนี้ / ส่งคืนสินค้า + ภาษีซื้อ · ลดได้ไม่เกินยอดค้าง · ต้องมีเหตุผล', async () => {
    const { owner, co } = await setup();
    const pi = await asUser(owner, (c) => doc(c, co, 'purchase_invoice', { date: '2026-10-05', party_code: 'V1', lines: [goods('10', '1000')] }));
    const pn = await asUser(owner, (c) => doc(c, co, 'purchase_credit_note', { date: '2026-10-08', ref_document_id: pi, reason: 'ส่งคืนชำรุด', lines: [goods('1', '1000')] }));
    expect(await getDoc(co, pn)).toMatchObject({ doc_no: 'PN-0001', party_code: 'V1', total: '1070.00', ref_document_id: pi, reason: 'ส่งคืนชำรุด' });
    expect(await entry(co, pn)).toEqual([['1410', '0.00', '70.00'], ['2110', '1070.00', '0.00'], ['5140', '0.00', '1000.00']]);
    await invariants(co);
    expect(await asUser(owner, (c) => doc(c, co, 'purchase_credit_note', { date: '2026-10-08', ref_document_id: pi, reason: 'เกิน', lines: [goods('9', '1000.01')] })).then(() => 'ok', sqlstate)).toBe('ACC15');
    expect(await asUser(owner, (c) => doc(c, co, 'purchase_credit_note', { date: '2026-10-08', ref_document_id: pi, lines: [goods('1', '1')] })).then(() => 'ok', sqlstate)).toBe('22023');
    // เลขที่ใบลดหนี้ของผู้ขายซ้ำกับเลขใบกำกับได้ (คนละชุด)
    const piNo = (await getDoc(co, pi)).vendor_doc_no;
    await asUser(owner, (c) => doc(c, co, 'purchase_credit_note', { date: '2026-10-08', ref_document_id: pi, reason: 'ลดราคา', vendor_doc_no: piNo, lines: [goods('1', '10')] }));
  });

  it('ลดหนี้บริการที่ยังไม่จ่าย: ลดภาษีซื้อยังไม่ถึงกำหนด กลับเข้าบัญชีค่าใช้จ่ายเดิม · จ่ายส่วนที่เหลือแล้ว 1411 เป็นศูนย์', async () => {
    const { owner, co } = await setup();
    const pi = await asUser(owner, (c) => doc(c, co, 'purchase_invoice', { date: '2026-10-05', party_code: 'V1', lines: [{ item_code: 'R1', qty: '1', unit_price: '5000' }] }));
    const pn = await asUser(owner, (c) => doc(c, co, 'purchase_credit_note', { date: '2026-10-08', ref_document_id: pi, reason: 'ลดค่าเช่า', lines: [{ description: 'ลดค่าเช่า', qty: '1', unit_price: '1000' }] }));
    expect(await entry(co, pn)).toEqual([['1411', '0.00', '70.00'], ['2110', '1070.00', '0.00'], ['5220', '0.00', '1000.00']]);
    await invariants(co);
    await asUser(owner, (c) => payment(c, co, { date: '2026-10-15', party_code: 'V1', wht_kind: 'rent', allocations: [{ document_id: pi, amount: '4280' }] }));
    expect(await balance(co, '1411')).toBe('0.00');
    expect(await balance(co, '2110')).toBe('0.00');
    expect(await balance(co, '2230')).toBe('-200.00'); // 5% ของ 4,000
    await invariants(co);
  });

  it('ยกเลิก: ใบที่มีจ่ายชำระอ้างอยู่ยกเลิกไม่ได้ · ยกเลิกจ่ายชำระแล้ว 50 ทวิ ถูกยกเลิกด้วย · ยอดกลับเป็นศูนย์', async () => {
    const { owner, co } = await setup();
    const pi = await asUser(owner, (c) => doc(c, co, 'purchase_invoice', { date: '2026-10-05', party_code: 'V1', lines: [service('1', '1000')] }));
    const pv = await asUser(owner, (c) => payment(c, co, { date: '2026-10-06', party_code: 'V1', wht_kind: 'service', allocations: [{ document_id: pi, amount: '535' }] }));
    expect(await asUser(owner, (c) => voidDoc(c, co, pi)).then(() => 'ok', sqlstate)).toBe('ACC16');
    const key = randomUUID();
    const rv = await asUser(owner, (c) => voidDoc(c, co, pv, '2026-10-07', key));
    expect(await asUser(owner, (c) => voidDoc(c, co, pv, '2026-10-07', key))).toBe(rv); // กดซ้ำ
    expect(await asUser(owner, (c) => voidDoc(c, co, pv)).then(() => 'ok', sqlstate)).toBe('ACC16');
    expect((await getCert(co, pv)).voided_at).not.toBeNull();
    await invariants(co);
    await asUser(owner, (c) => voidDoc(c, co, pi));
    for (const code of ['1110', '1410', '1411', '2110', '2230', '5260']) expect(await balance(co, code)).toBe('0.00');
    expect((await getDoc(co, pi)).void_reason).toBe('ทดสอบยกเลิก');
    // เลข WT ไม่นำกลับมาใช้
    const cp = await asUser(owner, (c) => doc(c, co, 'cash_purchase', { date: '2026-10-08', party_code: 'V1', wht_kind: 'service', lines: [service('1', '1000')] }));
    expect((await getCert(co, cp)).cert_no).toBe('WT-0002');
    await invariants(co);
  });

  it('เอกสารและ 50 ทวิ ที่ออกแล้วแก้/ลบไม่ได้แม้จากชั้นฐานข้อมูล', async () => {
    const { owner, co } = await setup();
    const cp = await asUser(owner, (c) => doc(c, co, 'cash_purchase', { date: '2026-10-05', party_code: 'V1', wht_kind: 'service', lines: [service('1', '1000')] }));
    await expect(db.query('update acc.purchase_documents set total = 1 where id = $1', [cp])).rejects.toMatchObject({ code: 'ACC06' });
    await expect(db.query('delete from acc.purchase_documents where id = $1', [cp])).rejects.toThrow();
    await expect(db.query('update acc.purchase_document_lines set amount = 1 where document_id = $1', [cp])).rejects.toThrow();
    await expect(db.query('update acc.wht_certificates set amount = 1 where document_id = $1', [cp])).rejects.toMatchObject({ code: 'ACC06' });
    await expect(db.query('delete from acc.wht_certificates where document_id = $1', [cp])).rejects.toThrow();
  });
});

describe('ค่าคงที่เจ้าหนี้หลังลำดับเอกสารสุ่ม', () => {
  it('ซื้อ/จ่ายบางส่วน (มีหัก)/ลดหนี้/ยกเลิก 200 ครั้ง: 2110 = ยอดค้างรวม และ 1411 = ภาษีบริการค้างจ่าย ทุกขั้น', async () => {
    const { owner, co } = await setup();
    let seed = 11;
    const rnd = (n: number) => { seed = (seed * 48271) % 2147483647; return seed % n; };
    const money = (max: number) => (rnd(max * 100) / 100 + 1).toFixed(2);
    for (let i = 0; i < 200; i++) {
      const open = (await db.query('select document_id, open::text, is_service from acc.ap_open_items($1)', [co])).rows;
      const op = rnd(10);
      await asUser(owner, async (c) => {
        if (op < 3 || open.length === 0) {
          await doc(c, co, 'purchase_invoice', { date: '2026-10-05', party_code: 'V1', price_mode: rnd(2) ? 'inclusive' : 'exclusive', discount: rnd(3) ? '0' : '1.11',
            lines: [rnd(2) ? service(String(rnd(5) + 1), money(3000)) : goods(String(rnd(5) + 1), money(3000))] });
        } else {
          const t = open[rnd(open.length)]!;
          const part = Math.min(Number(t.open), Math.max(1, Math.floor(Number(t.open) * (rnd(100) + 1)) / 100)).toFixed(2);
          if (op < 7) await payment(c, co, { date: '2026-10-10', party_code: 'V1', ...(rnd(2) && Number(part) >= 1 ? { wht_kind: 'service' } : {}), allocations: [{ document_id: t.document_id, amount: part }] });
          // ลดหนี้บริการที่ภาษีที่ปัดแล้วเกินภาษียังไม่ถึงกำหนดที่เหลือถูกปฏิเสธได้ตามกติกา (ACC15) นอกนั้นต้องผ่าน
          else if (op < 9) await doc(c, co, 'purchase_credit_note', { date: '2026-10-10', ref_document_id: t.document_id, reason: 'สุ่ม',
            lines: [{ description: 'ลด', qty: '1', unit_price: (Math.floor(Number(part) / 1.07 * 100) / 100).toFixed(2) }] })
            .catch((e) => { if (sqlstate(e) !== 'ACC15' || !t.is_service) throw e; });
          else {
            const src = (await c.query(`select id from acc.purchase_documents where company_id = $1 and kind in ('payment','purchase_credit_note') and voided_at is null order by random() limit 1`, [co])).rows[0];
            if (src) await voidDoc(c, co, src.id);
          }
        }
      });
      await invariants(co);
    }
    const sum = await db.query(`select count(*) filter (where kind = 'payment')::int pv, count(*) filter (where voided_at is not null)::int v,
      count(*) filter (where is_service and kind = 'purchase_invoice')::int svc, count(*) filter (where kind = 'purchase_credit_note')::int notes,
      (select count(*) from acc.wht_certificates w where w.company_id = $1)::int wt
      from acc.purchase_documents where company_id = $1`, [co]);
    expect(sum.rows[0].pv).toBeGreaterThan(20);
    expect(sum.rows[0].v).toBeGreaterThan(3);
    expect(sum.rows[0].svc).toBeGreaterThan(10);
    expect(sum.rows[0].notes).toBeGreaterThan(10);
    expect(sum.rows[0].wt).toBeGreaterThan(10);
    // ภาษีหัก ณ ที่จ่ายค้างจ่าย = ผลรวม 50 ทวิ ที่ยังไม่ยกเลิก
    const wt = await db.query(`select coalesce(sum(amount), 0)::numeric(18,2)::text s from acc.wht_certificates where company_id = $1 and voided_at is null`, [co]);
    expect((-Number(await balance(co, '2230'))).toFixed(2)).toBe(wt.rows[0].s);
  });
});

describe('สิทธิ์และการล็อก', () => {
  it('นักเรียนคนอื่นอ่านเอกสาร/50 ทวิ ไม่ได้ ครูอ่านได้แต่บันทึกไม่ได้ · ส่งงานแล้วบันทึกไม่ได้', async () => {
    const { owner, co } = await setup();
    await asUser(owner, (c) => doc(c, co, 'cash_purchase', { date: '2026-10-05', party_code: 'V1', wht_kind: 'service', lines: [service('1', '1000')] }));
    const other = await newUser(school, 'student');
    const count = (u: string) => asUser(u, async (c) => (await c.query(`select (select count(*) from acc.purchase_documents where company_id = $1)::int
      + (select count(*) from acc.wht_certificates where company_id = $1)::int n`, [co])).rows[0].n);
    expect(await count(other)).toBe(0);
    expect(await count(teacher)).toBe(2);
    expect(await asUser(teacher, (c) => doc(c, co, 'purchase_invoice', { date: '2026-10-05', party_code: 'V1', lines: [goods('1', '100')] })).then(() => 'ok', sqlstate)).toBe('42501');
    await db.query(`insert into acc.submissions (company_id, status) values ($1, 'submitted')`, [co]);
    expect(await asUser(owner, (c) => doc(c, co, 'purchase_invoice', { date: '2026-10-05', party_code: 'V1', lines: [goods('1', '100')] })).then(() => 'ok', sqlstate)).toBe('ACC10');
  });

  it('บริษัทที่ไม่มีบัญชีที่ฝั่งซื้อใช้ ได้บัญชีคืนจากแม่แบบตอนบันทึกครั้งแรก', async () => {
    const { owner, co } = await setup();
    await db.query(`delete from acc.chart_of_accounts where company_id = $1 and code in ('1411', '5140')`, [co]);
    await asUser(owner, (c) => doc(c, co, 'purchase_invoice', { date: '2026-10-05', party_code: 'V1', lines: [service('1', '100')] }));
    expect((await db.query(`select count(*)::int n from acc.chart_of_accounts where company_id = $1 and code in ('1411', '5140')`, [co])).rows[0].n).toBe(2);
  });
});
