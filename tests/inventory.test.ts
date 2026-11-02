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
