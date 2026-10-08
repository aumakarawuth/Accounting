import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { pool as db, asUser, newSchool, newUser, newClassroom, newCompany, sqlstate, taxId, post } from './helpers';

// เฟส 2.4 ภาษี (ชั้นฐานข้อมูล): รายงานภาษีขาย/ภาษีซื้อตรงกับบัญชีแยกประเภท 2210/1410 ทุกเดือน
// ปิด ภ.พ.30 เรียงเดือน ยกภาษีชำระเกิน (1430) ไปหักเดือนถัดไป เดือนที่ปิดแล้วลงภาษีย้อนไม่ได้ ยกเลิกการปิด ชำระภาษี
// นำส่ง ภ.ง.ด.3/53 ตามหนังสือรับรองของเดือน และหลังนำส่งแล้วออก/ยกเลิก 50 ทวิ ของเดือนนั้นไม่ได้
afterAll(async () => { await db.end(); });

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

/** บริษัทใหม่ (จด VAT): ลูกค้า C1 ผู้ขาย V1 นิติบุคคล V2 บุคคลธรรมดา สินค้า G1 บริการ S1 */
async function setup(opts: { vat?: boolean } = {}) {
  const owner = await newUser(school, 'student');
  await db.query('insert into acc.enrollments values ($1, $2)', [room, owner]);
  const co = await newCompany(owner, room);
  await db.query(`update acc.companies set tax_id = $2, vat_registered = $3, address = 'กรุงเทพฯ', version = version + 1 where id = $1`,
    [co, juristicId(Math.floor(Math.random() * 1e9)), opts.vat ?? true]);
  await db.query(`insert into acc.parties (company_id, code, name, is_customer, is_vendor, credit_days, vat_registered, tax_id) values
    ($1, 'C1', 'ลูกค้าหนึ่ง', true, false, 30, false, null),
    ($1, 'V1', 'บริษัท วัสดุ จำกัด', false, true, 30, true, $2), ($1, 'V2', 'นายช่าง ใจดี', false, true, 0, false, $3)`,
    [co, juristicId(7), taxId(77)]);
  await db.query(`insert into acc.items (company_id, code, name, unit, is_service) values ($1, 'G1', 'สินค้า', 'ชิ้น', false), ($1, 'S1', 'ค่าบริการ', 'งาน', true)`, [co]);
  return { owner, co };
}

const goods = (qty: string, price: string) => ({ item_code: 'G1', qty, unit_price: price });
const service = (qty: string, price: string) => ({ item_code: 'S1', qty, unit_price: price });
const q = <T>(c: pg.PoolClient, sql: string, args: unknown[]) => c.query(sql, args).then((r) => r.rows[0].id as T);
const sale = (c: pg.PoolClient, co: string, kind: string, p: object) =>
  q<string>(c, 'select acc.post_sales_document($1, $2, $3::jsonb, $4) id', [co, kind, JSON.stringify(p), randomUUID()]);
const receipt = (c: pg.PoolClient, co: string, p: object) =>
  q<string>(c, 'select acc.post_receipt($1, $2::jsonb, $3) id', [co, JSON.stringify(p), randomUUID()]);
const voidSale = (c: pg.PoolClient, co: string, id: string, date: string) =>
  q<string>(c, `select acc.void_document($1, $2, $3, 'ทดสอบยกเลิก', $4) id`, [co, id, date, randomUUID()]);
const purchase = (c: pg.PoolClient, co: string, kind: string, p: object) =>
  q<string>(c, 'select acc.post_purchase_document($1, $2, $3::jsonb, $4) id',
    [co, kind, JSON.stringify({ vendor_doc_no: `INV-${randomUUID().slice(0, 8)}`, ...p }), randomUUID()]);
const payment = (c: pg.PoolClient, co: string, p: object) =>
  q<string>(c, 'select acc.post_payment($1, $2::jsonb, $3) id', [co, JSON.stringify(p), randomUUID()]);
const voidPurchase = (c: pg.PoolClient, co: string, id: string, date: string) =>
  q<string>(c, `select acc.void_purchase_document($1, $2, $3, 'ทดสอบยกเลิก', $4) id`, [co, id, date, randomUUID()]);
const close = (c: pg.PoolClient, co: string, month: string, key = randomUUID()) =>
  q<string>(c, 'select acc.close_vat_month($1, $2, $3) id', [co, month, key]);
const voidClose = (c: pg.PoolClient, co: string, id: string, key = randomUUID()) =>
  q<string>(c, `select acc.void_vat_close($1, $2, 'กรอกผิด', $3) id`, [co, id, key]);
const payVat = (c: pg.PoolClient, co: string, id: string, date: string, key = randomUUID()) =>
  q<string>(c, `select acc.pay_vat($1, $2, $3, '1120', $4) id`, [co, id, date, key]);
const remit = (c: pg.PoolClient, co: string, month: string, form: string, date: string, key = randomUUID()) =>
  q<string>(c, `select acc.remit_wht($1, $2, $3, $4, '1110', $5) id`, [co, month, form, date, key]);

async function balance(co: string, code: string) {
  const r = await db.query(
    `select coalesce(sum(l.debit - l.credit), 0)::numeric(18,2)::text b from acc.journal_lines l
       join acc.chart_of_accounts a on a.company_id = l.company_id and a.id = l.account_id where l.company_id = $1 and a.code = $2`, [co, code]);
  return r.rows[0].b as string;
}
async function report(co: string, month: string, side: 'sales' | 'purchases') {
  const r = await db.query(`select doc_no, kind, base::text, vat::text, status, ref_no from acc.vat_report($1, $2, $3)`, [co, month, side]);
  return r.rows;
}
const sum = (rows: { vat: string }[]) => (rows.reduce((s, x) => s + Math.round(Number(x.vat) * 100), 0) / 100).toFixed(2);
/** ภาษีขาย (เครดิตสุทธิ 2210) / ภาษีซื้อ (เดบิตสุทธิ 1410) ของเดือนตามสมุดรายวัน ไม่นับรายการปิดภาษีและการกลับรายการปิด */
async function ledgerVat(co: string, month: string, code: '2210' | '1410') {
  const r = await db.query(
    `select coalesce(sum(l.debit - l.credit), 0)::numeric(18,2) m from acc.journal_lines l
       join acc.journal_entries e on e.company_id = l.company_id and e.id = l.entry_id
       join acc.chart_of_accounts a on a.company_id = l.company_id and a.id = l.account_id
       left join acc.journal_entries o on o.company_id = e.company_id and o.id = e.reverses_entry_id
      where l.company_id = $1 and a.code = $3 and date_trunc('month', e.entry_date) = $2::date
        and e.doc_prefix <> 'VC' and coalesce(o.doc_prefix, '') <> 'VC'`, [co, month, code]);
  return (code === '2210' ? -Number(r.rows[0].m) : Number(r.rows[0].m)).toFixed(2);
}
async function entryLines(co: string, entryId: string) {
  const r = await db.query(
    `select a.code, l.debit::text, l.credit::text from acc.journal_lines l
       join acc.chart_of_accounts a on a.company_id = l.company_id and a.id = l.account_id
      where l.company_id = $1 and l.entry_id = $2 order by l.line_no`, [co, entryId]);
  return r.rows.map((x) => [x.code, x.debit, x.credit]);
}
const closing = (co: string, id: string) => db.query('select * from acc.vat_closings where company_id = $1 and id = $2', [co, id]).then((r) => r.rows[0]);

/** ตุลาคม: ขาย สินค้า/บริการ ลดหนี้ ยกเลิกในเดือน ยกเลิกข้ามเดือน · ซื้อ สินค้า/บริการ ลดหนี้ หัก ณ ที่จ่าย */
async function october(owner: string, co: string) {
  return asUser(owner, async (c) => {
    const iv = await sale(c, co, 'sales_invoice', { date: '2026-10-05', party_code: 'C1', lines: [goods('10', '1000')] }); // 700
    const sv = await sale(c, co, 'sales_invoice', { date: '2026-10-06', party_code: 'C1', lines: [service('1', '5000')] }); // ยังไม่ถึงกำหนด
    await receipt(c, co, { date: '2026-10-20', party_code: 'C1', allocations: [{ document_id: sv, amount: '5350' }] }); // 350
    const cs = await sale(c, co, 'cash_sale', { date: '2026-10-07', party_code: 'C1', lines: [goods('2', '1000')] }); // 140
    await sale(c, co, 'credit_note', { date: '2026-10-08', party_code: 'C1', ref_document_id: iv, reason: 'ชำรุด', lines: [goods('1', '1000')] }); // −70
    const same = await sale(c, co, 'cash_sale', { date: '2026-10-09', party_code: 'C1', lines: [goods('1', '1000')] });
    await voidSale(c, co, same, '2026-10-09'); // ยกเลิกในเดือน: แถวศูนย์
    const later = await sale(c, co, 'cash_sale', { date: '2026-10-10', party_code: 'C1', lines: [goods('3', '1000')] }); // 210 ยกเลิกเดือนหน้า

    const pi = await purchase(c, co, 'purchase_invoice', { date: '2026-10-05', party_code: 'V1', lines: [goods('4', '1000')] }); // 280
    const ps = await purchase(c, co, 'purchase_invoice', { date: '2026-10-06', party_code: 'V1', lines: [service('1', '2000')] });
    const pv = await payment(c, co, { date: '2026-10-15', party_code: 'V1', wht_kind: 'service', allocations: [{ document_id: ps, amount: '2140' }] }); // 140, หัก 60
    await purchase(c, co, 'cash_purchase', { date: '2026-10-07', party_code: 'V1', lines: [goods('1', '1000')] }); // 70
    await purchase(c, co, 'purchase_credit_note', { date: '2026-10-08', party_code: 'V1', ref_document_id: pi, reason: 'คืน', lines: [goods('1', '500')] }); // −35
    await purchase(c, co, 'cash_purchase', { date: '2026-10-12', party_code: 'V1', wht_kind: 'service', lines: [service('1', '1000')] }); // 70, หัก 30
    await purchase(c, co, 'cash_purchase', { date: '2026-10-13', party_code: 'V2', wht_kind: 'rent', lines: [service('1', '1000')] }); // ไม่มีภาษี หัก 50 (ภ.ง.ด.3)
    return { cs, later, pv };
  });
}

describe('รายงานภาษีขาย/ภาษีซื้อ', () => {
  it('แถวของแต่ละเอกสาร ยกเลิกในเดือน = แถวศูนย์ ยกเลิกข้ามเดือน = แถวติดลบเดือนที่ยกเลิก ยอดรวมตรงสมุดรายวันทุกเดือน', async () => {
    const { owner, co } = await setup();
    const { later } = await october(owner, co);
    await asUser(owner, (c) => voidSale(c, co, later, '2026-11-03'));

    const out = await report(co, '2026-10-01', 'sales');
    expect(out.map((r) => [r.doc_no, r.vat, r.status])).toEqual([
      ['IV-0001', '700.00', 'normal'], ['CS-0001', '140.00', 'normal'], ['CN-0001', '-70.00', 'normal'],
      ['CS-0002', '0', 'voided'], ['CS-0003', '210.00', 'normal'], ['RE-0001', '350.00', 'normal'],
    ]);
    expect(out.find((r) => r.doc_no === 'RE-0001')!.base).toBe('5000.00');
    expect(sum(out)).toBe('1330.00');
    expect(await ledgerVat(co, '2026-10-01', '2210')).toBe('1330.00');

    const inp = await report(co, '2026-10-01', 'purchases');
    expect(inp.map((r) => [r.doc_no, r.vat])).toEqual([
      ['PI-0001', '280.00'], ['CP-0001', '70.00'], ['PN-0001', '-35.00'], ['CP-0002', '70.00'], ['PV-0001', '140.00'],
    ]);
    expect(inp.find((r) => r.doc_no === 'PV-0001')).toMatchObject({ base: '2000.00', ref_no: expect.stringMatching(/^INV-/) });
    expect(sum(inp)).toBe('525.00');
    expect(await ledgerVat(co, '2026-10-01', '1410')).toBe('525.00');

    const nov = await report(co, '2026-11-01', 'sales');
    expect(nov).toEqual([expect.objectContaining({ doc_no: 'CS-0003', vat: '-210.00', base: '-3000.00', status: 'void_reversal' })]);
    expect(await ledgerVat(co, '2026-11-01', '2210')).toBe('-210.00');
  });

  it('บริษัทไม่จด VAT ไม่มีแถวภาษีซื้อ (ภาษีรวมเป็นต้นทุน)', async () => {
    const { owner, co } = await setup({ vat: false });
    await asUser(owner, (c) => purchase(c, co, 'purchase_invoice', { date: '2026-10-05', party_code: 'V1', lines: [goods('1', '1000')] }));
    expect(await report(co, '2026-10-01', 'purchases')).toEqual([]);
    expect(await asUser(owner, (c) => close(c, co, '2026-10-01')).then(() => 'ok', sqlstate)).toBe('22023');
  });
  it('เอกสารสุ่ม 3 เดือน (ยกเลิกสุ่มทั้งในเดือนและข้ามเดือน) ผลรวมรายงานเท่ากับสมุดรายวันทุกเดือน ปิดครบแล้ว 2210/1410 เป็นศูนย์', async () => {
    const { owner, co } = await setup();
    let seed = 20261013;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % n; };
    const months = ['2026-10', '2026-11', '2026-12'];
    const day = (m: number) => `${months[m]}-${String(1 + rnd(28)).padStart(2, '0')}`;
    const line = () => (rnd(2) ? goods : service)(String(1 + rnd(5)), `${100 + rnd(5000)}.${String(rnd(100)).padStart(2, '0')}`);
    await asUser(owner, async (c) => {
      const live: { id: string; m: number; side: 's' | 'p' }[] = [];
      for (let i = 0; i < 60; i++) {
        const m = rnd(3);
        const kind = rnd(4);
        if (kind === 0) live.push({ id: await sale(c, co, 'cash_sale', { date: day(m), party_code: 'C1', price_mode: rnd(2) ? 'inclusive' : 'exclusive', lines: [line()] }), m, side: 's' });
        else if (kind === 1) {
          const sv = await sale(c, co, 'sales_invoice', { date: `${months[m]}-01`, party_code: 'C1', lines: [service('1', `${1000 + rnd(9000)}`)] });
          const total = (await db.query('select total::text from acc.documents where company_id = $1 and id = $2', [co, sv])).rows[0].total;
          live.push({ id: await receipt(c, co, { date: day(m), party_code: 'C1', allocations: [{ document_id: sv, amount: total }] }), m, side: 's' });
        } else if (kind === 2) live.push({ id: await purchase(c, co, 'cash_purchase', { date: day(m), party_code: 'V1', lines: [line()] }), m, side: 'p' });
        else {
          const ps = await purchase(c, co, 'purchase_invoice', { date: `${months[m]}-01`, party_code: 'V1', lines: [service('1', `${1000 + rnd(9000)}`)] });
          const total = (await db.query('select total::text from acc.purchase_documents where company_id = $1 and id = $2', [co, ps])).rows[0].total;
          live.push({ id: await payment(c, co, { date: day(m), party_code: 'V1', allocations: [{ document_id: ps, amount: total }] }), m, side: 'p' });
        }
      }
      for (const d of live) {
        if (rnd(4) !== 0) continue;
        const date = `${months[d.m + rnd(3 - d.m)]}-28`;
        await (d.side === 's' ? voidSale(c, co, d.id, date) : voidPurchase(c, co, d.id, date));
      }
    });
    for (const m of months) {
      expect(sum(await report(co, `${m}-01`, 'sales'))).toBe(await ledgerVat(co, `${m}-01`, '2210'));
      expect(sum(await report(co, `${m}-01`, 'purchases'))).toBe(await ledgerVat(co, `${m}-01`, '1410'));
    }
    for (const m of months) await asUser(owner, (c) => close(c, co, `${m}-01`));
    expect([await balance(co, '2210'), await balance(co, '1410')]).toEqual(['0.00', '0.00']);
    const t = await db.query('select sum(payable - refundable + carry_used)::text p, sum(output_vat - input_vat)::text n from acc.vat_closings where company_id = $1', [co]);
    expect(t.rows[0].p).toBe(t.rows[0].n);
  });
});

describe('ปิดภาษีมูลค่าเพิ่ม (ภ.พ.30)', () => {
  it('ปิดเรียงเดือน รายการปิดลงวันสิ้นเดือน ภาษีชำระเกินยกไปหักเดือนถัดไป', async () => {
    const { owner, co } = await setup();
    const { later } = await october(owner, co);
    await asUser(owner, async (c) => {
      await voidSale(c, co, later, '2026-11-03'); // −210
      await sale(c, co, 'sales_invoice', { date: '2026-11-02', party_code: 'C1', lines: [goods('1', '1000')] }); // 70
      await purchase(c, co, 'purchase_invoice', { date: '2026-11-05', party_code: 'V1', lines: [goods('10', '1000')] }); // 700
      await sale(c, co, 'sales_invoice', { date: '2026-12-01', party_code: 'C1', lines: [goods('20', '1000')] }); // 1400
    });
    // เดือนตุลาคมยังไม่ปิด ปิดพฤศจิกายนก่อนไม่ได้
    expect(await asUser(owner, (c) => close(c, co, '2026-11-01')).then(() => 'ok', sqlstate)).toBe('ACC17');

    const key = randomUUID();
    const oct = await asUser(owner, (c) => close(c, co, '2026-10-01', key));
    expect(await asUser(owner, (c) => close(c, co, '2026-10-01', key))).toBe(oct); // กดซ้ำ
    expect(await asUser(owner, (c) => close(c, co, '2026-10-01')).then(() => 'ok', sqlstate)).toBe('ACC17');
    const o = await closing(co, oct);
    expect(o).toMatchObject({ month: expect.any(Date), output_vat: '1330.00', input_vat: '525.00', carry_used: '0.00', payable: '805.00', refundable: '0.00' });
    expect(await entryLines(co, o.entry_id)).toEqual([['2210', '1330.00', '0.00'], ['1410', '0.00', '525.00'], ['2220', '0.00', '805.00']]);
    const e = await db.query('select doc_prefix, entry_date::text d from acc.journal_entries where company_id = $1 and id = $2', [co, o.entry_id]);
    expect(e.rows[0]).toEqual({ doc_prefix: 'VC', d: '2026-10-31' });

    const nov = await closing(co, await asUser(owner, (c) => close(c, co, '2026-11-01')));
    expect(nov).toMatchObject({ output_vat: '-140.00', input_vat: '700.00', carry_used: '0.00', payable: '0.00', refundable: '840.00' });
    expect(await entryLines(co, nov.entry_id)).toEqual([['2210', '0.00', '140.00'], ['1410', '0.00', '700.00'], ['1430', '840.00', '0.00']]);

    const dec = await closing(co, await asUser(owner, (c) => close(c, co, '2026-12-01')));
    expect(dec).toMatchObject({ output_vat: '1400.00', input_vat: '0.00', carry_used: '840.00', payable: '560.00', refundable: '0.00' });
    expect(await entryLines(co, dec.entry_id)).toEqual([['2210', '1400.00', '0.00'], ['1430', '0.00', '840.00'], ['2220', '0.00', '560.00']]);
    for (const code of ['2210', '1410', '1430']) expect(await balance(co, code)).toBe('0.00');
    expect(await balance(co, '2220')).toBe('-1365.00');

    // ยกเลิกได้เฉพาะเดือนล่าสุด หลังยกเลิกยอดยกมากลับคืน ปิดใหม่ได้ผลเดิม
    expect(await asUser(owner, (c) => voidClose(c, co, nov.id)).then(() => 'ok', sqlstate)).toBe('ACC16');
    await asUser(owner, (c) => voidClose(c, co, dec.id));
    expect(await balance(co, '1430')).toBe('840.00');
    expect(await balance(co, '2210')).toBe('-1400.00');
    expect(await asUser(owner, (c) => voidClose(c, co, dec.id)).then(() => 'ok', sqlstate)).toBe('ACC16');
    const dec2 = await closing(co, await asUser(owner, (c) => close(c, co, '2026-12-01')));
    expect(dec2).toMatchObject({ carry_used: '840.00', payable: '560.00' });
    expect(await db.query('select count(*)::int n from acc.vat_closings where company_id = $1', [co]).then((r) => r.rows[0].n)).toBe(4);
  });

  it('เดือนที่ปิดแล้ว ลงภาษีขาย/ภาษีซื้อลงวันที่ในเดือนนั้นไม่ได้ ทั้งเอกสาร การยกเลิก และสมุดรายวันทั่วไป บัญชีอื่นลงได้', async () => {
    const { owner, co } = await setup();
    const { cs } = await october(owner, co);
    const oct = await asUser(owner, (c) => close(c, co, '2026-10-01'));
    const fail = (fn: (c: pg.PoolClient) => Promise<unknown>) => asUser(owner, fn).then(() => 'ok', sqlstate);

    expect(await fail((c) => sale(c, co, 'cash_sale', { date: '2026-10-25', party_code: 'C1', lines: [goods('1', '100')] }))).toBe('ACC17');
    expect(await fail((c) => purchase(c, co, 'purchase_invoice', { date: '2026-10-25', party_code: 'V1', lines: [goods('1', '100')] }))).toBe('ACC17');
    expect(await fail((c) => voidSale(c, co, cs, '2026-10-31'))).toBe('ACC17');
    expect(await fail((c) => post(c, co, '2026-10-30', [{ account_code: '1410', debit: '7' }, { account_code: '1110', credit: '7' }]))).toBe('ACC17');
    expect(await fail((c) => post(c, co, '2026-09-30', [{ account_code: '2210', debit: '7' }, { account_code: '1110', credit: '7' }]))).toBe('ACC17');
    // ไม่เกี่ยวกับภาษี หรือลงวันที่เดือนถัดไป ลงได้
    expect(await fail((c) => post(c, co, '2026-10-30', [{ account_code: '5220', debit: '7' }, { account_code: '1110', credit: '7' }]))).toBe('ok');
    expect(await fail((c) => sale(c, co, 'cash_sale', { date: '2026-11-01', party_code: 'C1', lines: [goods('1', '100')] }))).toBe('ok');
    expect(await fail((c) => voidSale(c, co, cs, '2026-11-01'))).toBe('ok');

    // ยกเลิกการปิดแล้วลงเดือนนั้นได้อีก
    await asUser(owner, (c) => voidClose(c, co, oct));
    expect(await fail((c) => sale(c, co, 'cash_sale', { date: '2026-10-25', party_code: 'C1', lines: [goods('1', '100')] }))).toBe('ok');
  });

  it('ชำระภาษี: หลังสิ้นเดือน ครั้งเดียว กดซ้ำได้ผลเดิม ชำระแล้วยกเลิกการปิดไม่ได้', async () => {
    const { owner, co } = await setup();
    await october(owner, co);
    const oct = await asUser(owner, (c) => close(c, co, '2026-10-01'));
    const fail = (fn: (c: pg.PoolClient) => Promise<unknown>) => asUser(owner, fn).then(() => 'ok', sqlstate);
    expect(await fail((c) => payVat(c, co, oct, '2026-10-31'))).toBe('22023');
    const key = randomUUID();
    const tx = await asUser(owner, (c) => payVat(c, co, oct, '2026-11-15', key));
    expect(await asUser(owner, (c) => payVat(c, co, oct, '2026-11-15', key))).toBe(tx);
    expect(await fail((c) => payVat(c, co, oct, '2026-11-16'))).toBe('ACC16');
    expect(await entryLines(co, tx)).toEqual([['2220', '805.00', '0.00'], ['1120', '0.00', '805.00']]);
    expect(await balance(co, '2220')).toBe('0.00');
    expect(await fail((c) => voidClose(c, co, oct))).toBe('ACC16');

    // เดือนที่ภาษีซื้อมากกว่า ไม่มียอดต้องชำระ
    await asUser(owner, (c) => purchase(c, co, 'purchase_invoice', { date: '2026-11-05', party_code: 'V1', lines: [goods('1', '1000')] }));
    const nov = await asUser(owner, (c) => close(c, co, '2026-11-01'));
    expect(await fail((c) => payVat(c, co, nov, '2026-12-15'))).toBe('22023');
  });

  it('เดือนที่ไม่มีรายการปิดได้ (ไม่มีรายการบัญชี) ปิดย้อนหลังเดือนก่อนหน้าที่ปิดแล้วไม่ได้', async () => {
    const { owner, co } = await setup();
    const id = await asUser(owner, (c) => close(c, co, '2026-09-01'));
    expect(await closing(co, id)).toMatchObject({ output_vat: '0.00', input_vat: '0.00', payable: '0.00', entry_id: null });
    await asUser(owner, (c) => close(c, co, '2026-11-01'));
    expect(await asUser(owner, (c) => close(c, co, '2026-10-01')).then(() => 'ok', sqlstate)).toBe('ACC17');
  });

  it('ปิดเดือนเดียวกันพร้อมกันสองคำขอ สำเร็จครั้งเดียว · คนอื่นปิดไม่ได้ · แก้บันทึกการปิดตรงๆ ไม่ได้', async () => {
    const { owner, co } = await setup();
    await october(owner, co);
    const both = await Promise.all([1, 2].map(() => asUser(owner, (c) => close(c, co, '2026-10-01')).then(() => 'ok', sqlstate)));
    expect(both.sort()).toEqual(['ACC17', 'ok']);
    expect(await balance(co, '2220')).toBe('-805.00');

    const other = await newUser(school, 'student');
    expect(await asUser(other, (c) => close(c, co, '2026-11-01')).then(() => 'ok', sqlstate)).toBe('42501');
    expect(await asUser(owner, (c) => c.query('update acc.vat_closings set payable = 0 where company_id = $1', [co])).then(() => 'ok', sqlstate)).toBe('42501');
    expect(await db.query('update acc.vat_closings set payable = 0, output_vat = output_vat - 805 where company_id = $1', [co]).then(() => 'ok', sqlstate)).toBe('ACC06');
  });
});

describe('นำส่งภาษีหัก ณ ที่จ่าย (ภ.ง.ด.3 / ภ.ง.ด.53)', () => {
  it('ยอดนำส่ง = หนังสือรับรองของเดือน/แบบ นำส่งแล้วออกหรือยกเลิก 50 ทวิ ของเดือนนั้นไม่ได้', async () => {
    const { owner, co } = await setup();
    const { pv } = await october(owner, co);
    const fail = (fn: (c: pg.PoolClient) => Promise<unknown>) => asUser(owner, fn).then(() => 'ok', sqlstate);

    expect(await fail((c) => remit(c, co, '2026-10-01', 'pnd53', '2026-10-31'))).toBe('22023');
    expect(await fail((c) => remit(c, co, '2026-09-01', 'pnd53', '2026-10-07'))).toBe('22023');
    const key = randomUUID();
    const id = await asUser(owner, (c) => remit(c, co, '2026-10-01', 'pnd53', '2026-11-07', key));
    expect(await asUser(owner, (c) => remit(c, co, '2026-10-01', 'pnd53', '2026-11-07', key))).toBe(id);
    expect(await fail((c) => remit(c, co, '2026-10-01', 'pnd53', '2026-11-08'))).toBe('ACC17');
    const r = (await db.query('select * from acc.wht_remittances where company_id = $1 and id = $2', [co, id])).rows[0];
    expect(r).toMatchObject({ form: 'pnd53', amount: '90.00', cert_count: 2 });
    expect(await entryLines(co, r.entry_id)).toEqual([['2230', '90.00', '0.00'], ['1110', '0.00', '90.00']]);
    expect(await balance(co, '2230')).toBe('-50.00'); // ภ.ง.ด.3 ยังไม่นำส่ง

    expect(await fail((c) => voidPurchase(c, co, pv, '2026-11-01'))).toBe('ACC17');
    expect(await fail((c) => purchase(c, co, 'cash_purchase', { date: '2026-10-28', party_code: 'V1', wht_kind: 'service', lines: [service('1', '1000')] }))).toBe('ACC17');
    expect(await fail((c) => purchase(c, co, 'cash_purchase', { date: '2026-10-28', party_code: 'V2', wht_kind: 'rent', lines: [service('1', '1000')] }))).toBe('ok');
    expect(await fail((c) => purchase(c, co, 'cash_purchase', { date: '2026-11-02', party_code: 'V1', wht_kind: 'service', lines: [service('1', '1000')] }))).toBe('ok');

    await asUser(owner, (c) => remit(c, co, '2026-10-01', 'pnd3', '2026-11-07'));
    // 2230 = หนังสือรับรองที่ยังไม่ยกเลิก − ที่นำส่งแล้ว
    const live = await db.query(
      `select coalesce(sum(amount), 0)::numeric(18,2)::text a from acc.wht_certificates where company_id = $1 and voided_at is null`, [co]);
    const remitted = await db.query(`select coalesce(sum(amount), 0)::numeric(18,2)::text a from acc.wht_remittances where company_id = $1`, [co]);
    expect((-Number(await balance(co, '2230'))).toFixed(2)).toBe((Number(live.rows[0].a) - Number(remitted.rows[0].a)).toFixed(2));
    expect(await balance(co, '2230')).toBe('-30.00');
  });
});
