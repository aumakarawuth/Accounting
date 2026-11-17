import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { pool as db, asUser, newSchool, newUser, newClassroom, newCompany, sqlstate } from './helpers';
import { cumulativeDepreciation, depreciationFor, monthlyDepreciation, schedule } from '../apps/web/lib/depreciation';
import { fromCents } from '../apps/web/lib/money';

// เฟส 3.4 สินทรัพย์ถาวร (ชั้นฐานข้อมูล): สูตรค่าเสื่อม SQL = TypeScript ทุกสตางค์, AJ สิ้นเดือนเข้ากระดาษทำการ,
// ลงย้อนเดือนที่ตกหล่น, กลับรายการ, จำหน่าย/ขาย กำไรขาดทุน และค่าคงที่: ค่าเสื่อมสะสมในบัญชี = ผลรวมในทะเบียน
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
  // บริษัทไม่จด VAT: เทสต์นี้ดูค่าเสื่อม/กำไรขาดทุน (ขายสินทรัพย์ของบริษัทจด VAT อยู่ใน tests/daily-depreciation-asset-vat.test.ts)
  await db.query('update acc.companies set vat_registered = false, version = version + 1 where id = $1', [co]);
  return { owner, co };
}

const asset = (over: object = {}) => ({
  code: 'EQ-01', name: 'คอมพิวเตอร์', acquired_date: '2026-01-10', cost: '36000.00', salvage: '0', life_months: 36,
  asset_account: '1630', accum_account: '1631', expense_account: '5250', counter_account: '1110', ...over,
});
const register = (c: pg.PoolClient, co: string, p: object, key = randomUUID()) =>
  c.query('select acc.register_fixed_asset($1, $2::jsonb, $3) id', [co, JSON.stringify(p), key]).then((r) => r.rows[0].id as string);
const depreciate = (c: pg.PoolClient, co: string, month: string, key = randomUUID()) =>
  c.query('select acc.post_depreciation($1, $2, $3) id', [co, `${month}-01`, key]).then((r) => r.rows[0].id as string);
const dispose = (c: pg.PoolClient, co: string, id: string, p: object, key = randomUUID()) =>
  c.query('select acc.dispose_fixed_asset($1, $2, $3::jsonb, $4) id', [co, id, JSON.stringify(p), key]).then((r) => r.rows[0].id as string);
const voidRun = (c: pg.PoolClient, co: string, id: string, key = randomUUID()) =>
  c.query('select acc.void_depreciation_run($1, $2, null, $3) id', [co, id, key]).then((r) => r.rows[0].id as string);

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
const register_ = (co: string, month: string) => db.query('select * from acc.fixed_asset_register($1, $2)', [co, `${month}-01`]).then((r) => r.rows);
/** ค่าเสื่อมสะสมในบัญชี 1631 = ผลรวมค่าเสื่อมสะสมของสินทรัพย์ที่ยังไม่จำหน่ายในทะเบียน · งบทดลองดุล */
async function invariants(co: string) {
  const rows = await register_(co, '2099-12');
  const accum = rows.filter((r) => r.status !== 'disposed' && !r.voided).reduce((s, r) => s + Math.round(Number(r.accumulated) * 100), 0);
  expect(await balance(co, '1631')).toBe(fromCents(BigInt(-accum)));
  const tb = await db.query('select sum(debit_total) d, sum(credit_total) c from acc.trial_balance($1)', [co]);
  expect(tb.rows[0].d).toBe(tb.rows[0].c);
}

describe('สูตรค่าเสื่อมราคา', () => {
  it('SQL (app.depreciation_cum) กับ TypeScript (lib/depreciation.ts) ตรงกันทุกสตางค์ 5,000 ชุดสุ่ม และรวมทั้งอายุ = ราคาทุน − ราคาซาก', async () => {
    let seed = 20261103;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % n; };
    const cases = Array.from({ length: 5000 }, () => {
      const cost = BigInt(rnd(1_000_000_00) + 1);
      const salvage = BigInt(rnd(Number(cost)));
      const life = [1, 3, 7, 12, 36, 60, 120, 199, 240, 1200][rnd(10)]!;
      return { cost, salvage, life, n: rnd(life + 2) };
    });
    const r = await db.query(
      `select app.depreciation_cum(u.c, u.s, u.l, u.n)::numeric(18,2)::text v
         from unnest($1::numeric[], $2::numeric[], $3::int[], $4::int[]) with ordinality u(c, s, l, n, o) order by u.o`,
      [cases.map((c) => fromCents(c.cost)), cases.map((c) => fromCents(c.salvage)), cases.map((c) => c.life), cases.map((c) => c.n)]);
    expect(r.rows.map((x) => x.v)).toEqual(cases.map((c) => fromCents(cumulativeDepreciation(c.cost, c.salvage, c.life, c.n))));
    for (const c of cases.slice(0, 300)) {
      const s = schedule(c.cost, c.salvage, c.life);
      expect(s.reduce((a, b) => a + b, 0n)).toBe(c.cost - c.salvage);
      expect(s.every((x) => x >= 0n)).toBe(true);
    }
  });

  it('ปัดเศษ: 10,000 / 3 เดือน = 3,333.33 · 3,333.33 · 3,333.34 และยอดเล็กมากไม่ติดลบ', () => {
    expect(schedule(1_000_000n, 0n, 3).map(fromCents)).toEqual(['3333.33', '3333.33', '3333.34']);
    expect(monthlyDepreciation(100n, 0n, 200)).toBe(1n); // 0.005 ปัดขึ้น
    expect(schedule(100n, 0n, 200).filter((x) => x > 0n)).toHaveLength(100);
    expect(depreciationFor(100n, 0n, 200, 200)).toBe(0n);
  });
});

describe('ทะเบียนและค่าเสื่อมประจำเดือน', () => {
  it('ลงทะเบียนพร้อมบันทึกการได้มา (FA) · ค่าเสื่อมเดือนแรกเป็น AJ วันสิ้นเดือน เข้าช่องปรับปรุงของกระดาษทำการ', async () => {
    const { owner, co } = await setup();
    const id = await asUser(owner, (c) => register(c, co, asset()));
    const fa = (await db.query('select * from acc.fixed_assets where company_id = $1 and id = $2', [co, id])).rows[0];
    expect(await lines(co, fa.entry_id)).toEqual([['1630', '36000.00', '0.00'], ['1110', '0.00', '36000.00']]);
    const run = await asUser(owner, (c) => depreciate(c, co, '2026-01'));
    const r = (await db.query(`select e.doc_no, to_char(e.entry_date, 'YYYY-MM-DD') d, e.id from acc.depreciation_runs r
                                 join acc.journal_entries e on e.company_id = r.company_id and e.id = r.entry_id where r.id = $1`, [run])).rows[0];
    expect([r.doc_no, r.d]).toEqual(['AJ-0001', '2026-01-31']);
    expect(await lines(co, r.id)).toEqual([['5250', '1000.00', '0.00'], ['1631', '0.00', '1000.00']]);
    const ws = (await db.query(`select code, adj_debit::text, adj_credit::text from acc.worksheet($1, '2026-01-01') where code in ('1631', '5250') order by code`, [co])).rows;
    expect(ws).toEqual([{ code: '1631', adj_debit: '0.00', adj_credit: '1000.00' }, { code: '5250', adj_debit: '1000.00', adj_credit: '0.00' }]);
    // เดือนเดิมลงซ้ำไม่ได้ (ไม่มีอะไรถึงกำหนด)
    expect(await asUser(owner, (c) => depreciate(c, co, '2026-01')).then(() => 'ok', sqlstate)).toBe('ACC18');
    await invariants(co);
  });

  it('เดือนที่ตกหล่นลงรวมในรอบถัดไป แยกบรรทัดตามเดือน · เดือนสุดท้ายรับส่วนต่าง · ครบอายุแล้วหยุด', async () => {
    const { owner, co } = await setup();
    const id = await asUser(owner, (c) => register(c, co, asset({ cost: '10000.00', salvage: '0', life_months: 3, acquired_date: '2026-03-20', counter_account: '' })));
    expect((await db.query('select entry_id from acc.fixed_assets where id = $1', [id])).rows[0].entry_id).toBeNull();
    const run = await asUser(owner, (c) => depreciate(c, co, '2026-04'));
    const dl = (await db.query(`select to_char(dep_month, 'YYYY-MM') m, seq, amount::text from acc.depreciation_lines where run_id = $1 order by seq`, [run])).rows;
    expect(dl).toEqual([{ m: '2026-03', seq: 1, amount: '3333.33' }, { m: '2026-04', seq: 2, amount: '3333.33' }]);
    await asUser(owner, (c) => depreciate(c, co, '2026-05'));
    expect(await balance(co, '1631')).toBe('-10000.00');
    expect(await asUser(owner, (c) => depreciate(c, co, '2026-06')).then(() => 'ok', sqlstate)).toBe('ACC18');
    const reg = (await register_(co, '2026-05'))[0];
    expect([reg.status, reg.months_posted, reg.accumulated, reg.book_value, reg.dep_this_month]).toEqual(['fully_depreciated', 3, '10000.00', '0.00', '3333.34']);
    const april = (await register_(co, '2026-04'))[0];
    expect([april.accumulated, april.book_value]).toEqual(['6666.66', '3333.34']);
    await invariants(co);
  });

  it('เริ่มคิดค่าเสื่อมเดือนถัดไปได้ · สินทรัพย์หลายตัวในรอบเดียว', async () => {
    const { owner, co } = await setup();
    await asUser(owner, (c) => register(c, co, asset({ code: 'A', dep_start: '2026-02-01' })));
    await asUser(owner, (c) => register(c, co, asset({ code: 'B', cost: '1200000', salvage: '200000', life_months: 240, asset_account: '1620', accum_account: '1621', counter_account: '3110' })));
    const run = await asUser(owner, (c) => depreciate(c, co, '2026-01'));
    const e = (await db.query('select entry_id from acc.depreciation_runs where id = $1', [run])).rows[0].entry_id;
    expect(await lines(co, e)).toEqual([['5250', '4166.67', '0.00'], ['1621', '0.00', '4166.67']]);
    await asUser(owner, (c) => depreciate(c, co, '2026-02'));
    expect(await balance(co, '1631')).toBe('-1000.00');
    expect(await balance(co, '1621')).toBe('-8333.34');
  });

  it('กลับรายการค่าเสื่อมได้เฉพาะรอบล่าสุด แล้วลงใหม่ได้', async () => {
    const { owner, co } = await setup();
    await asUser(owner, (c) => register(c, co, asset()));
    const jan = await asUser(owner, (c) => depreciate(c, co, '2026-01'));
    const feb = await asUser(owner, (c) => depreciate(c, co, '2026-02'));
    expect(await asUser(owner, (c) => voidRun(c, co, jan)).then(() => 'ok', sqlstate)).toBe('ACC18');
    const rv = await asUser(owner, (c) => voidRun(c, co, feb));
    const e = (await db.query(`select doc_no, to_char(entry_date, 'YYYY-MM-DD') d from acc.journal_entries where id = $1`, [rv])).rows[0];
    expect([e.doc_no.slice(0, 3), e.d]).toEqual(['RV-', '2026-02-28']);
    expect(await balance(co, '1631')).toBe('-1000.00');
    await asUser(owner, (c) => depreciate(c, co, '2026-02'));
    expect(await balance(co, '1631')).toBe('-2000.00');
    await invariants(co);
  });
});

describe('จำหน่าย / ขายสินทรัพย์', () => {
  it('ขายมีกำไร: ตัดราคาทุนและค่าเสื่อมสะสม กำไรเข้า 4330 · ไม่คิดค่าเสื่อมเดือนที่จำหน่าย', async () => {
    const { owner, co } = await setup();
    const id = await asUser(owner, (c) => register(c, co, asset()));
    for (const m of ['2026-01', '2026-02', '2026-03']) await asUser(owner, (c) => depreciate(c, co, m));
    // ยังไม่ลงเดือน มี.ค. ก่อนจำหน่ายเม.ย. ไม่ได้ / ลงแล้ว
    const d = await asUser(owner, (c) => dispose(c, co, id, { date: '2026-04-15', proceeds: '34000', proceeds_account: '1120' }));
    const row = (await db.query('select * from acc.asset_disposals where id = $1', [d])).rows[0];
    expect([row.accumulated, row.book_value, row.gain_loss]).toEqual(['3000.00', '33000.00', '1000.00']);
    expect(await lines(co, row.entry_id)).toEqual([['1631', '3000.00', '0.00'], ['1120', '34000.00', '0.00'], ['1630', '0.00', '36000.00'], ['4330', '0.00', '1000.00']]);
    expect(await balance(co, '1630')).toBe('0.00');
    expect(await balance(co, '1631')).toBe('0.00');
    // จำหน่ายแล้วไม่คิดค่าเสื่อมต่อ
    expect(await asUser(owner, (c) => depreciate(c, co, '2026-04')).then(() => 'ok', sqlstate)).toBe('ACC18');
    const reg = (await register_(co, '2026-04'))[0];
    expect([reg.status, reg.book_value, reg.gain_loss]).toEqual(['disposed', '0.00', '1000.00']);
    await invariants(co);
  });

  it('ตัดจำหน่ายไม่มีราคาขาย = ขาดทุนเท่ามูลค่าตามบัญชี (5320) · ต้องลงค่าเสื่อมถึงเดือนก่อนจำหน่ายก่อน', async () => {
    const { owner, co } = await setup();
    const id = await asUser(owner, (c) => register(c, co, asset()));
    await asUser(owner, (c) => depreciate(c, co, '2026-01'));
    expect(await asUser(owner, (c) => dispose(c, co, id, { date: '2026-03-01' })).then(() => 'ok', sqlstate)).toBe('ACC18');
    expect(await asUser(owner, (c) => dispose(c, co, id, { date: '2026-01-20' })).then(() => 'ok', sqlstate)).toBe('ACC18'); // ลงเดือน ม.ค. แล้ว
    const d = await asUser(owner, (c) => dispose(c, co, id, { date: '2026-02-05' }));
    const row = (await db.query('select * from acc.asset_disposals where id = $1', [d])).rows[0];
    expect(await lines(co, row.entry_id)).toEqual([['1631', '1000.00', '0.00'], ['5320', '35000.00', '0.00'], ['1630', '0.00', '36000.00']]);
    expect(await asUser(owner, (c) => dispose(c, co, id, { date: '2026-02-06' })).then(() => 'ok', sqlstate)).toBe('ACC18');
    // กลับรายการจำหน่าย แล้วคิดค่าเสื่อมต่อได้
    await asUser(owner, (c) => c.query(`select acc.void_asset_disposal($1, $2, null, 'ลงผิด', $3)`, [co, d, randomUUID()]));
    expect(await balance(co, '1630')).toBe('36000.00');
    await asUser(owner, (c) => depreciate(c, co, '2026-02'));
    await invariants(co);
  });

  it('ยกเลิกทะเบียนได้เมื่อยังไม่ลงค่าเสื่อม (กลับรายการ FA) รหัสเดิมใช้ใหม่ได้', async () => {
    const { owner, co } = await setup();
    const id = await asUser(owner, (c) => register(c, co, asset()));
    expect(await asUser(owner, (c) => register(c, co, asset())).then(() => 'ok', sqlstate)).toBe('ACC18');
    await asUser(owner, (c) => c.query(`select acc.void_fixed_asset($1, $2, null, 'ราคาผิด', $3)`, [co, id, randomUUID()]));
    expect(await balance(co, '1630')).toBe('0.00');
    await asUser(owner, (c) => register(c, co, asset({ cost: '30000' })));
    await asUser(owner, (c) => depreciate(c, co, '2026-01'));
    const second = (await db.query(`select id from acc.fixed_assets where company_id = $1 and voided_at is null`, [co])).rows[0].id;
    expect(await asUser(owner, (c) => c.query(`select acc.void_fixed_asset($1, $2, null, 'x', $3)`, [co, second, randomUUID()])).then(() => 'ok', sqlstate)).toBe('ACC18');
    await invariants(co);
  });

  it('ตรวจข้อมูลทะเบียน: บัญชี 16xx, ราคาซากน้อยกว่าราคาทุน, อายุ, เดือนเริ่มคิด', async () => {
    const { owner, co } = await setup();
    const tryReg = (over: object) => asUser(owner, (c) => register(c, co, asset(over))).then(() => 'ok', sqlstate);
    expect(await tryReg({ asset_account: '5250' })).toBe('ACC04');
    expect(await tryReg({ accum_account: '1630' })).toBe('ACC04');
    expect(await tryReg({ expense_account: '1110' })).toBe('ACC04');
    expect(await tryReg({ salvage: '36000' })).toBe('ACC05');
    expect(await tryReg({ life_months: 0 })).toBe('22023');
    expect(await tryReg({ dep_start: '2025-12-01' })).toBe('22023');
    expect(await tryReg({ code: 'eq 1' })).toBe('22023');
  });
});

describe('การแข่งกัน สิทธิ์ และการล็อก', () => {
  it('ลงค่าเสื่อมเดือนเดียวกันพร้อมกันได้ครั้งเดียว · คีย์เดิมได้รอบเดิม', async () => {
    const { owner, co } = await setup();
    await asUser(owner, (c) => register(c, co, asset()));
    const results = await Promise.all([1, 2, 3, 4].map(() => asUser(owner, (c) => depreciate(c, co, '2026-01')).then(() => 'ok', sqlstate)));
    expect(results.filter((r) => r === 'ok')).toHaveLength(1);
    expect(await balance(co, '1631')).toBe('-1000.00');
    const key = randomUUID();
    const a = await asUser(owner, (c) => depreciate(c, co, '2026-02', key));
    expect(await asUser(owner, (c) => depreciate(c, co, '2026-02', key))).toBe(a);
    await invariants(co);
  });

  it('นักเรียนอื่นอ่าน/ลงไม่ได้ · ครูอ่านได้ · แก้ตารางตรงไม่ได้ · ส่งงานแล้วลงไม่ได้', async () => {
    const { owner, co } = await setup();
    const other = await newUser(school, 'student');
    const id = await asUser(owner, (c) => register(c, co, asset()));
    expect(await asUser(other, (c) => depreciate(c, co, '2026-01')).then(() => 'ok', sqlstate)).toBe('42501');
    expect((await asUser(other, (c) => c.query('select * from acc.fixed_asset_register($1, $2)', [co, '2026-01-01']))).rowCount).toBe(0);
    expect((await asUser(teacher, (c) => c.query('select * from acc.fixed_asset_register($1, $2)', [co, '2026-01-01']))).rowCount).toBe(1);
    expect(await asUser(teacher, (c) => depreciate(c, co, '2026-01')).then(() => 'ok', sqlstate)).toBe('42501');
    expect(await asUser(owner, (c) => c.query(`insert into acc.depreciation_runs(company_id, month, idem_key, created_by) values ($1, '2026-01-01', 'xxxxxxxxxx', $2)`, [co, owner]))
      .then(() => 'ok', sqlstate)).toBe('42501');
    expect(await db.query(`update acc.fixed_assets set cost = 1 where id = $1`, [id]).then(() => 'ok', sqlstate)).toBe('ACC06');
    await asUser(owner, (c) => depreciate(c, co, '2026-01'));
    expect(await db.query(`delete from acc.depreciation_lines where company_id = $1`, [co]).then(() => 'ok', sqlstate)).toBe('ACC06');
    await db.query(`insert into acc.submissions (company_id, status) values ($1, 'submitted')`, [co]);
    expect(await asUser(owner, (c) => depreciate(c, co, '2026-02')).then(() => 'ok', sqlstate)).toBe('ACC10');
    expect(await asUser(owner, (c) => dispose(c, co, id, { date: '2026-02-03' })).then(() => 'ok', sqlstate)).toBe('ACC10');
  });
});
