import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { pool as db, asUser, newSchool, newUser, newClassroom, newCompany, sqlstate, taxId } from './helpers';

// เฟส 3.3 เช็ครับ/เช็คจ่าย (ชั้นฐานข้อมูล): บัญชีพักเช็ค เช็คลงวันที่ล่วงหน้า นำฝาก ผ่าน คืน ยกเลิก
// การผูกกับใบเสร็จรับชำระ/จ่ายชำระ และค่าคงที่: ยอดบัญชีพักเช็ค = ผลรวมเช็คที่ยังไม่ผ่าน/คืน/ยกเลิก
afterAll(async () => { await db.end(); });

let school: string, teacher: string, room: string;
beforeAll(async () => {
  school = await newSchool();
  teacher = await newUser(school, 'teacher');
  room = await newClassroom(school, teacher, []);
});

async function setup() {
  const owner = await newUser(school, 'student');
  await db.query('insert into acc.enrollments values ($1, $2)', [room, owner]);
  const co = await newCompany(owner, room);
  await db.query(`update acc.companies set tax_id = $2, vat_registered = true, address = 'กรุงเทพฯ', version = version + 1 where id = $1`,
    [co, taxId(Math.floor(Math.random() * 1e9))]);
  await db.query(`insert into acc.parties (company_id, code, name, is_customer, is_vendor, credit_days, tax_id) values
    ($1, 'C1', 'ลูกค้าหนึ่ง', true, false, 30, null), ($1, 'V1', 'ผู้ขายหนึ่ง', false, true, 30, $2)`, [co, taxId(91)]);
  await db.query(`insert into acc.items (company_id, code, name, unit, is_service) values ($1, 'G1', 'สินค้า', 'ชิ้น', false)`, [co]);
  return { owner, co };
}

const register = (c: pg.PoolClient, co: string, p: object, key = randomUUID()) =>
  c.query('select acc.register_cheque($1, $2::jsonb, $3) id', [co, JSON.stringify(p), key]).then((r) => r.rows[0].id as string);
const act = (c: pg.PoolClient, co: string, id: string, action: string, date: string, bank: string | null = null, key = randomUUID()) =>
  c.query('select acc.cheque_action($1, $2, $3, $4, $5, $6, $7) id', [co, id, action, date, bank, '', key]).then((r) => r.rows[0].id as string);
const status = (co: string, id: string) => db.query('select acc.cheque_status($1, $2) s', [co, id]).then((r) => r.rows[0].s as string);

async function balance(co: string, code: string) {
  const r = await db.query(
    `select coalesce(sum(l.debit - l.credit), 0)::numeric(18,2)::text b from acc.journal_lines l
       join acc.chart_of_accounts a on a.company_id = l.company_id and a.id = l.account_id where l.company_id = $1 and a.code = $2`, [co, code]);
  return r.rows[0].b as string;
}
async function lines(co: string, entryId: string) {
  const r = await db.query(
    `select a.code, l.debit::text, l.credit::text from acc.journal_lines l join acc.chart_of_accounts a on a.company_id = l.company_id and a.id = l.account_id
      where l.company_id = $1 and l.entry_id = $2 order by l.line_no`, [co, entryId]);
  return r.rows.map((x) => [x.code, x.debit, x.credit]);
}
/** ยอดบัญชีพักเช็คต้องเท่ากับเช็คที่ยังค้าง (ยังไม่ผ่าน/คืน/ยกเลิก) ตามทะเบียน */
async function invariants(co: string) {
  const r = await db.query(`select holding_code, coalesce(sum(amount) filter (where status in ('on_hand', 'deposited', 'issued')), 0)::numeric(18,2)::text s
                              from acc.cheque_register($1) group by holding_code`, [co]);
  const want = Object.fromEntries(r.rows.map((x) => [x.holding_code, x.s]));
  for (const code of ['1220', '1221']) expect(await balance(co, code)).toBe(want[code] ?? '0.00');
  for (const code of ['2120', '2121']) expect((-Number(await balance(co, code))).toFixed(2)).toBe(want[code] ?? '0.00');
  const tb = await db.query('select sum(debit_total) d, sum(credit_total) c from acc.trial_balance($1)', [co]);
  expect(tb.rows[0].d).toBe(tb.rows[0].c);
}

const received = { direction: 'received', cheque_no: '1234567', bank_name: 'ธนาคารกรุงไทย', party_name: 'ลูกค้าหนึ่ง' };

describe('เช็ครับ', () => {
  it('รับเช็คลงวันที่ปัจจุบัน → 1220, นำฝาก (ไม่ลงบัญชี) → ผ่าน: เดบิตเงินฝาก เครดิตเช็ครับ', async () => {
    const { owner, co } = await setup();
    const id = await asUser(owner, (c) => register(c, co, { ...received, cheque_date: '2026-10-05', date: '2026-10-05', amount: '5000.00', counter_account: '4110' }));
    const q = (await db.query('select * from acc.cheques where company_id = $1 and id = $2', [co, id])).rows[0];
    expect(await lines(co, q.entry_id)).toEqual([['1220', '5000.00', '0.00'], ['4110', '0.00', '5000.00']]);
    expect(await status(co, id)).toBe('on_hand');
    await invariants(co);

    const entries = async () => Number((await db.query('select count(*) n from acc.journal_entries where company_id = $1', [co])).rows[0].n);
    const before = await entries();
    await asUser(owner, (c) => act(c, co, id, 'deposit', '2026-10-06', '1120'));
    expect(await entries()).toBe(before); // นำฝากไม่ลงบัญชี
    expect(await status(co, id)).toBe('deposited');
    await asUser(owner, (c) => act(c, co, id, 'clear', '2026-10-08'));
    const reg = (await db.query('select * from acc.cheque_register($1)', [co])).rows[0];
    expect([reg.status, reg.deposit_code, reg.status_doc_no]).toEqual(['cleared', '1120', 'CQ-0002']);
    expect(await lines(co, reg.status_entry_id)).toEqual([['1120', '5000.00', '0.00'], ['1220', '0.00', '5000.00']]);
    expect(await balance(co, '1120')).toBe('5000.00');
    await invariants(co);
  });

  it('เช็คลงวันที่ล่วงหน้าใช้ 1221 และนำฝากก่อนวันที่หน้าเช็คไม่ได้', async () => {
    const { owner, co } = await setup();
    const id = await asUser(owner, (c) => register(c, co, { ...received, cheque_date: '2026-11-15', date: '2026-10-20', amount: '1200.50', counter_account: '1210' }));
    const reg = (await db.query('select * from acc.cheque_register($1)', [co])).rows[0];
    expect([reg.holding_code, reg.postdated]).toEqual(['1221', true]);
    expect(await asUser(owner, (c) => act(c, co, id, 'deposit', '2026-11-14', '1120')).then(() => 'ok', sqlstate)).toBe('ACC18');
    await asUser(owner, (c) => act(c, co, id, 'deposit', '2026-11-15', '1120'));
    await asUser(owner, (c) => act(c, co, id, 'clear', '2026-11-16'));
    expect(await balance(co, '1221')).toBe('0.00');
    expect(await balance(co, '1120')).toBe('1200.50');
    await invariants(co);
  });

  it('เช็คคืน = กลับรายการตอนรับเช็ค (RV) ลูกหนี้กลับมา และสถานะเปลี่ยนต่อไม่ได้', async () => {
    const { owner, co } = await setup();
    await asUser(owner, (c) => c.query(`select acc.post_journal($1, '2026-10-01', 'ขายเชื่อ', $2::jsonb, $3)`,
      [co, JSON.stringify([{ account_code: '1210', debit: '800' }, { account_code: '4110', credit: '800' }]), randomUUID()]));
    const id = await asUser(owner, (c) => register(c, co, { ...received, cheque_date: '2026-10-02', date: '2026-10-02', amount: '800', counter_account: '1210' }));
    expect(await balance(co, '1210')).toBe('0.00');
    await asUser(owner, (c) => act(c, co, id, 'deposit', '2026-10-03', '1120'));
    await asUser(owner, (c) => act(c, co, id, 'bounce', '2026-10-05'));
    const reg = (await db.query('select * from acc.cheque_register($1)', [co])).rows[0];
    expect(reg.status).toBe('bounced');
    expect(reg.status_doc_no).toMatch(/^RV-/);
    const rv = (await db.query('select reverses_entry_id from acc.journal_entries where company_id = $1 and id = $2', [co, reg.status_entry_id])).rows[0];
    expect(rv.reverses_entry_id).toBe(reg.entry_id);
    expect(await balance(co, '1210')).toBe('800.00');
    expect(await balance(co, '1120')).toBe('0.00');
    for (const a of ['clear', 'bounce', 'cancel', 'deposit']) {
      expect(await asUser(owner, (c) => act(c, co, id, a, '2026-10-06', '1120')).then(() => 'ok', sqlstate)).toBe('ACC18');
    }
    await invariants(co);
  });

  it('ผูกกับใบเสร็จรับชำระ: ตัดลูกหนี้ด้วยบัญชีพักเช็ค · เช็คคืน = ยกเลิกใบเสร็จ ยอดค้างกลับมา · ยกเลิกใบเสร็จตรง ๆ ไม่ได้', async () => {
    const { owner, co } = await setup();
    const inv = await asUser(owner, (c) => c.query(`select acc.post_sales_document($1, 'sales_invoice', $2::jsonb, $3) id`,
      [co, JSON.stringify({ date: '2026-10-01', party_code: 'C1', lines: [{ item_code: 'G1', qty: '1', unit_price: '1000' }] }), randomUUID()]))
      .then((r) => r.rows[0].id as string);
    const id = await asUser(owner, (c) => register(c, co, {
      direction: 'received', cheque_no: '000111', bank_name: 'ธนาคารออมสิน', cheque_date: '2026-10-31', date: '2026-10-10',
      receipt: { party_code: 'C1', allocations: [{ document_id: inv, amount: '1070.00' }], wht_amount: '10.00' },
    }));
    const q = (await db.query('select * from acc.cheques where company_id = $1 and id = $2', [co, id])).rows[0];
    expect([q.amount, q.party_name]).toEqual(['1060.00', 'ลูกค้าหนึ่ง']);
    const d = (await db.query('select * from acc.documents where company_id = $1 and id = $2', [co, q.document_id])).rows[0];
    expect([d.kind, d.entry_id]).toEqual(['receipt', q.entry_id]);
    expect(await lines(co, q.entry_id)).toEqual([['1221', '1060.00', '0.00'], ['1420', '10.00', '0.00'], ['1210', '0.00', '1070.00']]);
    const open = async () => (await db.query('select coalesce(sum(open), 0)::text o from acc.ar_open_items($1)', [co])).rows[0].o;
    expect(await open()).toBe('0');

    // ยกเลิกใบเสร็จจากฝั่งขายไม่ได้ ต้องทำที่ทะเบียนเช็ค
    expect(await asUser(owner, (c) => c.query(`select acc.void_document($1, $2, '2026-10-12', 'ผิด', $3)`, [co, d.id, randomUUID()]))
      .then(() => 'ok', sqlstate)).toBe('ACC16');
    await asUser(owner, (c) => act(c, co, id, 'deposit', '2026-10-31', '1120'));
    await asUser(owner, (c) => act(c, co, id, 'bounce', '2026-11-02'));
    const after = (await db.query('select voided_at, void_reason from acc.documents where company_id = $1 and id = $2', [co, d.id])).rows[0];
    expect(after.voided_at).not.toBeNull();
    expect(after.void_reason).toContain('เช็คคืน');
    expect(await open()).toBe('1070.00');
    expect(await balance(co, '1221')).toBe('0.00');
    await invariants(co);
  });

  it('บัญชีพักเช็คใช้เป็นบัญชีรับเงินของใบเสร็จนอกทะเบียนเช็คไม่ได้', async () => {
    const { owner, co } = await setup();
    const inv = await asUser(owner, (c) => c.query(`select acc.post_sales_document($1, 'sales_invoice', $2::jsonb, $3) id`,
      [co, JSON.stringify({ date: '2026-10-01', party_code: 'C1', lines: [{ item_code: 'G1', qty: '1', unit_price: '100' }] }), randomUUID()]))
      .then((r) => r.rows[0].id as string);
    expect(await asUser(owner, (c) => c.query('select acc.post_receipt($1, $2::jsonb, $3)', [co,
      JSON.stringify({ date: '2026-10-05', party_code: 'C1', cash_account: '1220', allocations: [{ document_id: inv, amount: '107' }] }), randomUUID()]))
      .then(() => 'ok', sqlstate)).toBe('ACC04');
  });

  it('ยกเลิกเช็คที่ยังไม่นำฝาก · เช็คเลขเดิมลงซ้ำได้เฉพาะหลังยกเลิก', async () => {
    const { owner, co } = await setup();
    const p = { ...received, cheque_no: '555', cheque_date: '2026-10-05', date: '2026-10-05', amount: '300', counter_account: '4320' };
    const id = await asUser(owner, (c) => register(c, co, p));
    expect(await asUser(owner, (c) => register(c, co, p)).then(() => 'ok', sqlstate)).toBe('ACC18');
    expect(await asUser(owner, (c) => act(c, co, id, 'clear', '2026-10-06')).then(() => 'ok', sqlstate)).toBe('ACC18'); // ต้องนำฝากก่อน
    await asUser(owner, (c) => act(c, co, id, 'cancel', '2026-10-06'));
    expect(await status(co, id)).toBe('cancelled');
    await asUser(owner, (c) => register(c, co, p));
    await invariants(co);
  });

  it('คำขอซ้ำด้วยคีย์เดิมไม่เกิดรายการซ้ำ · ทำพร้อมกันได้ผลเดียว', async () => {
    const { owner, co } = await setup();
    const key = randomUUID();
    const p = { ...received, cheque_date: '2026-10-05', date: '2026-10-05', amount: '100', counter_account: '4320' };
    const [a, b] = await Promise.all([asUser(owner, (c) => register(c, co, p, key)), asUser(owner, (c) => register(c, co, p, key)).catch(sqlstate)]);
    expect([a, b].filter((x) => x === a).length).toBeGreaterThanOrEqual(1);
    expect(await asUser(owner, (c) => register(c, co, p, key))).toBe(a);
    await asUser(owner, (c) => act(c, co, a, 'deposit', '2026-10-06', '1120'));
    const results = await Promise.all([1, 2, 3].map(() => asUser(owner, (c) => act(c, co, a, 'clear', '2026-10-07')).then(() => 'ok', sqlstate)));
    expect(results.filter((r) => r === 'ok')).toHaveLength(1);
    expect(await balance(co, '1120')).toBe('100.00');
    const k2 = randomUUID();
    const x = await asUser(owner, (c) => act(c, co, a, 'bounce', '2026-10-08', null, k2).then(() => 'ok', sqlstate));
    expect(x).toBe('ACC18');
    await invariants(co);
  });

  it('นำฝากเข้าเงินสดไม่ได้ · วันที่ก่อนวันรับเช็คไม่ได้', async () => {
    const { owner, co } = await setup();
    const id = await asUser(owner, (c) => register(c, co, { ...received, cheque_date: '2026-10-05', date: '2026-10-05', amount: '10', counter_account: '4320' }));
    expect(await asUser(owner, (c) => act(c, co, id, 'deposit', '2026-10-06', '1110')).then(() => 'ok', sqlstate)).toBe('ACC04');
    expect(await asUser(owner, (c) => act(c, co, id, 'deposit', '2026-10-04', '1120')).then(() => 'ok', sqlstate)).toBe('22023');
  });
});

describe('เช็คจ่าย', () => {
  const paid = { direction: 'paid', cheque_no: 'A-0001', bank_name: 'ธนาคารกสิกรไทย', bank_account: '1120', party_name: 'ผู้ขายหนึ่ง' };

  it('จ่ายเช็ค → 2120, ผ่าน: เดบิตเช็คจ่าย เครดิตเงินฝากที่สั่งจ่าย · ลงวันที่ล่วงหน้าใช้ 2121 ผ่านก่อนวันที่หน้าเช็คไม่ได้', async () => {
    const { owner, co } = await setup();
    const a = await asUser(owner, (c) => register(c, co, { ...paid, cheque_date: '2026-10-05', date: '2026-10-05', amount: '700', counter_account: '5220' }));
    const b = await asUser(owner, (c) => register(c, co, { ...paid, cheque_no: 'A-0002', cheque_date: '2026-12-01', date: '2026-10-05', amount: '300', counter_account: '2110' }));
    const reg = Object.fromEntries((await db.query('select * from acc.cheque_register($1)', [co])).rows.map((r) => [r.id, r]));
    expect([reg[a].holding_code, reg[a].status, reg[b].holding_code]).toEqual(['2120', 'issued', '2121']);
    expect(await lines(co, reg[a].entry_id)).toEqual([['5220', '700.00', '0.00'], ['2120', '0.00', '700.00']]);
    expect(await asUser(owner, (c) => act(c, co, a, 'deposit', '2026-10-06', '1120')).then(() => 'ok', sqlstate)).toBe('ACC18');
    await asUser(owner, (c) => act(c, co, a, 'clear', '2026-10-09'));
    expect(await balance(co, '1120')).toBe('-700.00');
    expect(await asUser(owner, (c) => act(c, co, b, 'clear', '2026-11-30')).then(() => 'ok', sqlstate)).toBe('ACC18');
    await asUser(owner, (c) => act(c, co, b, 'cancel', '2026-11-30'));
    expect(await balance(co, '2110')).toBe('0.00');
    await invariants(co);
  });

  it('ผูกกับการจ่ายชำระเจ้าหนี้ · เช็คจ่ายคืน = ยกเลิกใบสำคัญจ่าย เจ้าหนี้ค้างกลับมา', async () => {
    const { owner, co } = await setup();
    const pi = await asUser(owner, (c) => c.query(`select acc.post_purchase_document($1, 'purchase_invoice', $2::jsonb, $3) id`,
      [co, JSON.stringify({ date: '2026-10-01', party_code: 'V1', vendor_doc_no: 'INV-9', lines: [{ item_code: 'G1', qty: '2', unit_price: '500' }] }), randomUUID()]))
      .then((r) => r.rows[0].id as string);
    const id = await asUser(owner, (c) => register(c, co, {
      ...paid, party_name: '', cheque_date: '2026-10-10', date: '2026-10-10',
      payment: { party_code: 'V1', allocations: [{ document_id: pi, amount: '1000.00' }] },
    }));
    const q = (await db.query('select * from acc.cheques where company_id = $1 and id = $2', [co, id])).rows[0];
    expect([q.amount, q.party_name]).toEqual(['1000.00', 'ผู้ขายหนึ่ง']);
    expect(await lines(co, q.entry_id)).toEqual([['2110', '1000.00', '0.00'], ['2120', '0.00', '1000.00']]);
    expect(await balance(co, '2110')).toBe('0.00');
    await asUser(owner, (c) => act(c, co, id, 'bounce', '2026-10-15'));
    expect(await balance(co, '2110')).toBe('-1000.00');
    await invariants(co);
  });

  it('เช็คจ่ายต้องระบุบัญชีเงินฝาก 11xx ที่ไม่ใช่เงินสด', async () => {
    const { owner, co } = await setup();
    expect(await asUser(owner, (c) => register(c, co, { ...paid, bank_account: '1110', cheque_date: '2026-10-05', date: '2026-10-05', amount: '1', counter_account: '5220' }))
      .then(() => 'ok', sqlstate)).toBe('ACC04');
  });
});

describe('สิทธิ์และการล็อก', () => {
  it('นักเรียนอื่นอ่าน/ลงเช็คบริษัทนี้ไม่ได้ · ครูอ่านได้แต่ลงไม่ได้ · เขียนตารางตรงไม่ได้ · ส่งงานแล้วลงไม่ได้', async () => {
    const { owner, co } = await setup();
    const other = await newUser(school, 'student');
    const p = { ...received, cheque_date: '2026-10-05', date: '2026-10-05', amount: '10', counter_account: '4320' };
    const id = await asUser(owner, (c) => register(c, co, p));
    expect(await asUser(other, (c) => register(c, co, { ...p, cheque_no: '9' })).then(() => 'ok', sqlstate)).toBe('42501');
    expect((await asUser(other, (c) => c.query('select * from acc.cheques where company_id = $1', [co]))).rowCount).toBe(0);
    expect((await asUser(other, (c) => c.query('select * from acc.cheque_register($1)', [co]))).rowCount).toBe(0);
    expect((await asUser(teacher, (c) => c.query('select * from acc.cheque_register($1)', [co]))).rowCount).toBe(1);
    expect(await asUser(teacher, (c) => act(c, co, id, 'cancel', '2026-10-06')).then(() => 'ok', sqlstate)).toBe('42501');
    expect(await asUser(owner, (c) => c.query(`update acc.cheques set amount = 1 where id = $1`, [id])).then(() => 'ok', sqlstate)).toBe('42501');
    expect(await db.query(`update acc.cheques set amount = 1 where id = $1`, [id]).then(() => 'ok', sqlstate)).toBe('ACC06');
    expect(await db.query(`delete from acc.cheque_events where company_id = $1`, [co]).then(() => 'ok', sqlstate)).toBe('ok'); // ไม่มีแถว
    await asUser(owner, (c) => act(c, co, id, 'deposit', '2026-10-06', '1120'));
    expect(await db.query(`delete from acc.cheque_events where company_id = $1`, [co]).then(() => 'ok', sqlstate)).toBe('ACC06');
    await db.query(`insert into acc.submissions (company_id, status) values ($1, 'submitted')`, [co]);
    expect(await asUser(owner, (c) => act(c, co, id, 'clear', '2026-10-07')).then(() => 'ok', sqlstate)).toBe('ACC10');
    expect(await asUser(owner, (c) => register(c, co, { ...p, cheque_no: '10' })).then(() => 'ok', sqlstate)).toBe('ACC10');
  });
});
