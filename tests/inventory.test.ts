import { afterAll, describe, expect, it } from 'vitest';
import { asUser, newCompany, newSchool, newUser, pool, sqlstate } from './helpers';

afterAll(() => pool.end());

async function setup() {
  const school = await newSchool();
  const owner = await newUser(school, 'student');
  const company = await newCompany(owner);
  await asUser(owner, (c) => c.query(
    `insert into acc.items (company_id, code, name, unit, is_service, track_inventory)
     values ($1, 'SKU-001', 'สินค้า A', 'ชิ้น', false, true)`, [company]));
  return { owner, company };
}

describe('สินค้าคงเหลือ', () => {
  it('รับเข้าและตัดออกตามต้นทุนถัวเฉลี่ยเคลื่อนที่ พร้อมลงบัญชีดุล', async () => {
    const { owner, company } = await setup();
    const post = (qty: string, cost: string | null, key: string) => asUser(owner, (c) => c.query(
      `select acc.post_inventory_adjustment($1, 'SKU-001', '2026-10-01', $2, $3, '5210', 'ตรวจนับสต็อก', $4) id`,
      [company, qty, cost, key]));
    await post('10', '10', 'inventory-in-1');
    await post('10', '20', 'inventory-in-2');
    await post('-4', null, 'inventory-out-1');

    const balance = await asUser(owner, (c) => c.query(
      `select * from acc.inventory_balance($1, (select id from acc.items where company_id = $1 and code = 'SKU-001'))`, [company]));
    expect(balance.rows[0]).toEqual({ quantity: '16.000', value: '240.00', unit_cost: '15.000000' });

    const moves = await asUser(owner, (c) => c.query(
      `select quantity::text, unit_cost::text, value::text from acc.inventory_movements where company_id = $1 order by created_at`, [company]));
    expect(moves.rows).toEqual([
      { quantity: '10.000', unit_cost: '10.000000', value: '100.00' },
      { quantity: '10.000', unit_cost: '20.000000', value: '200.00' },
      { quantity: '-4.000', unit_cost: '15.000000', value: '-60.00' },
    ]);
    const card = await asUser(owner, (c) => c.query(
      `select balance_qty::text, balance_value::text from acc.inventory_card($1, (select id from acc.items where company_id = $1 and code = 'SKU-001'))`, [company]));
    expect(card.rows).toEqual([
      { balance_qty: '10.000', balance_value: '100.00' },
      { balance_qty: '20.000', balance_value: '300.00' },
      { balance_qty: '16.000', balance_value: '240.00' },
    ]);
    const gl = await pool.query(
      `select a.code, sum(l.debit)::text debit, sum(l.credit)::text credit
         from acc.journal_lines l join acc.chart_of_accounts a on a.company_id=l.company_id and a.id=l.account_id
        where l.company_id=$1 and a.code in ('1310','5210') group by a.code order by a.code`, [company]);
    expect(gl.rows).toEqual([
      { code: '1310', debit: '300.00', credit: '60.00' },
      { code: '5210', debit: '60.00', credit: '300.00' },
    ]);
  });

  it('ห้ามสต็อกติดลบ และ idempotency ไม่เพิ่ม movement ซ้ำ', async () => {
    const { owner, company } = await setup();
    const run = (qty: string, key: string) => asUser(owner, (c) => c.query(
      `select acc.post_inventory_adjustment($1, 'SKU-001', '2026-10-01', $2, 12, '5210', '', $3) id`, [company, qty, key]));
    const a = await run('2', 'inventory-once');
    const b = await run('2', 'inventory-once');
    expect(b.rows[0].id).toBe(a.rows[0].id);
    await expect(run('-3', 'inventory-too-low')).rejects.toSatisfy((e: unknown) => sqlstate(e) === 'ACC15');
    const count = await pool.query(`select count(*)::int n from acc.inventory_movements where company_id = $1`, [company]);
    expect(count.rows[0].n).toBe(1);
  });
});

describe('สินค้าคงเหลือกับเอกสารซื้อ/ขาย', () => {
  async function trading() {
    const { owner, company } = await setup();
    await pool.query(`update acc.companies set tax_id = '0105558012349', address = 'กรุงเทพฯ', version = version + 1 where id = $1`, [company]);
    await pool.query(`insert into acc.parties (company_id, code, name, is_customer, is_vendor, tax_id, vat_registered)
      values ($1, 'V1', 'ผู้ขาย', false, true, '0105558012349', true), ($1, 'C1', 'ลูกค้า', true, false, null, false)`, [company]);
    return { owner, company };
  }
  const buy = (owner: string, co: string, qty: string, price: string) => asUser(owner, (c) => c.query(
    `select acc.post_purchase_document($1, 'cash_purchase', $2::jsonb, $3) id`,
    [co, JSON.stringify({ date: '2026-10-05', party_code: 'V1', vendor_doc_no: `R-${Math.random()}`, lines: [{ item_code: 'SKU-001', qty, unit_price: price }] }), `buy-${Math.random()}`]))
    .then((r) => r.rows[0].id as string);
  const sell = (owner: string, co: string, qty: string, price: string) => asUser(owner, (c) => c.query(
    `select acc.post_sales_document($1, 'cash_sale', $2::jsonb, $3) id`,
    [co, JSON.stringify({ date: '2026-10-06', party_code: 'C1', lines: [{ item_code: 'SKU-001', qty, unit_price: price }] }), `sell-${Math.random()}`]))
    .then((r) => r.rows[0].id as string);
  const stock = async (co: string) => (await pool.query(
    `select quantity::text, value::text from acc.inventory_balance($1, (select id from acc.items where company_id = $1 and code = 'SKU-001'))`, [co])).rows[0];
  const bal = async (co: string, code: string) => (await pool.query(
    `select coalesce(sum(l.debit - l.credit), 0)::numeric(18,2)::text b from acc.journal_lines l join acc.chart_of_accounts a on a.company_id = l.company_id and a.id = l.account_id where l.company_id = $1 and a.code = $2`, [co, code])).rows[0].b;

  it('ยกเลิกใบขายและใบซื้อที่มีสินค้าคงเหลือได้ สต็อกและบัญชี 1310 กลับตามจริง', async () => {
    const { owner, company } = await trading();
    const p = await buy(owner, company, '10', '100');
    const s = await sell(owner, company, '4', '150');
    expect(await stock(company)).toEqual({ quantity: '6.000', value: '600.00' });

    await asUser(owner, (c) => c.query(`select acc.void_document($1, $2, '2026-10-20', 'ผิด', $3)`, [company, s, `v-${Math.random()}`]));
    expect(await stock(company)).toEqual({ quantity: '10.000', value: '1000.00' });
    expect(await bal(company, '1310')).toBe('1000.00');

    await asUser(owner, (c) => c.query(`select acc.void_purchase_document($1, $2, '2026-10-21', 'ผิด', $3)`, [company, p, `v-${Math.random()}`]));
    expect(await stock(company)).toEqual({ quantity: '0.000', value: '0.00' });
    expect(await bal(company, '1310')).toBe('0.00');
    expect(await bal(company, '5130')).toBe('0.00');
  });

  it('ยกเลิกใบซื้อไม่ได้ถ้าสินค้าถูกขายไปแล้วจนสต็อกไม่พอ', async () => {
    const { owner, company } = await trading();
    const p = await buy(owner, company, '5', '100');
    await sell(owner, company, '3', '150');
    await expect(asUser(owner, (c) => c.query(`select acc.void_purchase_document($1, $2, '2026-10-21', 'ผิด', $3)`, [company, p, `v-${Math.random()}`])))
      .rejects.toSatisfy((e: unknown) => sqlstate(e) === 'ACC16');
    expect(await stock(company)).toEqual({ quantity: '2.000', value: '200.00' });
  });
});
