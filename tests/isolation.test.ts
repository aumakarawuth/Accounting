import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { pool, asUser, newSchool, newUser, newClassroom, newCompany, post, sqlstate } from './helpers';

afterAll(() => pool.end());

const lines = [{ account_code: '1110', debit: '100.00' }, { account_code: '4110', credit: '100.00' }];
let school: string, teacherA: string, teacherB: string, admin: string, a: string, b: string, coA: string, coB: string;

beforeAll(async () => {
  school = await newSchool();
  teacherA = await newUser(school, 'teacher');
  teacherB = await newUser(school, 'teacher');
  admin = await newUser(school, 'admin');
  a = await newUser(school, 'student');
  b = await newUser(school, 'student');
  const roomA = await newClassroom(school, teacherA, [a]);
  const roomB = await newClassroom(school, teacherB, [b]);
  coA = await newCompany(a, roomA);
  coB = await newCompany(b, roomB);
  await asUser(a, (c) => post(c, coA, '2026-10-01', lines));
  await asUser(b, (c) => post(c, coB, '2026-10-01', lines));
});

const count = (user: string | null, table: string, company: string, role = 'app_rw') =>
  asUser(user, async (c) => Number((await c.query(`select count(*) n from acc.${table} where company_id=$1`, [company])).rows[0].n), role);

const TABLES = ['chart_of_accounts', 'periods', 'journal_entries', 'journal_lines', 'account_balances'];

describe('การแยกข้อมูลระหว่างนักเรียน/บริษัท', () => {
  it('นักเรียน A อ่านข้อมูลบริษัท B ไม่ได้เลย ทุกตาราง', async () => {
    for (const t of TABLES) {
      expect(await count(a, t, coB), t).toBe(0);
      expect(await count(a, t, coA), t).toBeGreaterThan(0);
    }
    const r = await asUser(a, (c) => c.query(`select id from acc.companies where id=$1`, [coB]));
    expect(r.rowCount).toBe(0);
    const tb = await asUser(a, (c) => c.query(`select * from acc.trial_balance($1)`, [coB]));
    expect(tb.rows.every((x) => Number(x.debit_total) === 0)).toBe(true);
  });

  it('นักเรียน A เขียน/ลงบัญชี/ปิดงวด/กลับรายการ บริษัท B ไม่ได้', async () => {
    await expect(asUser(a, (c) => post(c, coB, '2026-10-02', lines))).rejects.toSatisfy((e: any) => sqlstate(e) === '42501');
    await expect(asUser(a, (c) => c.query(`select acc.close_period($1,'2026-10-01')`, [coB]))).rejects.toSatisfy((e: any) => sqlstate(e) === '42501');
    const eB = (await pool.query(`select id from acc.journal_entries where company_id=$1`, [coB])).rows[0].id;
    await expect(asUser(a, (c) => c.query(`select acc.reverse_journal($1,$2,'2026-10-02',$3)`, [coB, eB, 'k'.repeat(10)])))
      .rejects.toSatisfy((e: any) => sqlstate(e) === '42501');
    const u = await asUser(a, (c) => c.query(`update acc.chart_of_accounts set name='x', version=version+1 where company_id=$1`, [coB]));
    expect(u.rowCount).toBe(0);
    await expect(asUser(a, (c) => c.query(
      `insert into acc.chart_of_accounts(company_id,code,name,type) values ($1,'9999','x','asset')`, [coB]))).rejects.toThrow(/row-level security/);
    const n = await pool.query(`select count(*)::int n from acc.journal_entries where company_id=$1`, [coB]);
    expect(n.rows[0].n).toBe(1);
  });

  it('ไม่มี session (ไม่ระบุผู้ใช้) อ่านและเขียนอะไรไม่ได้', async () => {
    for (const t of TABLES) expect(await count(null, t, coA), t).toBe(0);
    await expect(asUser(null, (c) => post(c, coA, '2026-10-02', lines))).rejects.toSatisfy((e: any) => sqlstate(e) === '42501');
  });

  it('ครูอ่านบริษัทของนักเรียนในห้องตัวเองได้ แต่เขียนไม่ได้ และอ่านห้องอื่นไม่ได้', async () => {
    expect(await count(teacherA, 'journal_entries', coA)).toBe(1);
    expect(await count(teacherA, 'journal_entries', coB)).toBe(0);
    expect(await count(teacherB, 'journal_entries', coA)).toBe(0);
    await expect(asUser(teacherA, (c) => post(c, coA, '2026-10-02', lines))).rejects.toSatisfy((e: any) => sqlstate(e) === '42501');
    const u = await asUser(teacherA, (c) => c.query(`update acc.chart_of_accounts set name='x', version=version+1 where company_id=$1`, [coA]));
    expect(u.rowCount).toBe(0);
  });

  it('ผู้ดูแลระบบไม่เห็นสมุดรายวันของนักเรียน แต่เห็น audit log; นักเรียนไม่เห็น audit log', async () => {
    expect(await count(admin, 'journal_entries', coA)).toBe(0);
    const adminAudit = await asUser(admin, (c) => c.query(`select count(*)::int n from acc.audit_log where company_id=$1`, [coA]));
    expect(adminAudit.rows[0].n).toBeGreaterThan(0);
    const stuAudit = await asUser(a, (c) => c.query(`select count(*)::int n from acc.audit_log`));
    expect(stuAudit.rows[0].n).toBe(0);
  });

  it('รายงาน (app_ro) อ่านได้ตามสิทธิ์เดียวกัน เขียนไม่ได้', async () => {
    expect(await count(a, 'journal_entries', coA, 'app_ro')).toBe(1);
    expect(await count(a, 'journal_entries', coB, 'app_ro')).toBe(0);
    await expect(asUser(a, (c) => post(c, coA, '2026-10-02', lines), 'app_ro')).rejects.toThrow(/permission denied/);
  });

  it('ตาราง idempotency/เลขที่เอกสาร/ยอดคงเหลือ แก้ตรงจากบทบาทแอปไม่ได้', async () => {
    for (const sql of [
      `select * from acc.idempotency_keys`,
      `select * from acc.document_sequences`,
      `insert into acc.account_balances(company_id,period_id,account_id) select company_id,period_id,account_id from acc.account_balances limit 1`,
      `update acc.account_balances set debit_total=0`,
      `delete from acc.periods`,
      `update acc.periods set closed=true`,
    ]) {
      await expect(asUser(a, (c) => c.query(sql)), sql).rejects.toThrow(/permission denied/);
    }
  });

  it('audit log ผู้ใช้แก้/ลบไม่ได้ และบันทึกค่าก่อน-หลังพร้อมผู้ทำ', async () => {
    await asUser(a, async (c) => {
      await c.query(`select set_config('app.client_info','1.2.3.4 / iPhone',true)`);
      await c.query(`update acc.chart_of_accounts set name='เงินสดในมือ', version=version+1 where company_id=$1 and code='1110'`, [coA]);
    });
    const r = await pool.query(
      `select * from acc.audit_log where company_id=$1 and table_name='chart_of_accounts' and op='UPDATE' order by id desc limit 1`, [coA]);
    expect(r.rows[0].user_id).toBe(a);
    expect(r.rows[0].client).toBe('1.2.3.4 / iPhone');
    expect(r.rows[0].old_row.name).toBe('เงินสด');
    expect(r.rows[0].new_row.name).toBe('เงินสดในมือ');
    await expect(pool.query(`update acc.audit_log set op='X'`)).rejects.toSatisfy((e: any) => sqlstate(e) === 'ACC06');
  });
});

describe('ห้องเรียนและการลงทะเบียน (RLS ไม่วนไม่จบ)', () => {
  it('ครูเห็นห้องและนักเรียนของตัวเอง นักเรียนเห็นห้องที่ตัวเองเรียน คนอื่นไม่เห็น', async () => {
    const q = (u: string) => asUser(u, async (c) => ({
      rooms: (await c.query('select id from acc.classrooms')).rowCount,
      enr: (await c.query('select user_id from acc.enrollments')).rowCount,
    }));
    expect(await q(teacherA)).toEqual({ rooms: 1, enr: 1 });
    expect(await q(a)).toEqual({ rooms: 1, enr: 1 });
    expect(await q(teacherB)).toEqual({ rooms: 1, enr: 1 });
    const crossTeacher = await asUser(teacherB, (c) => c.query('select 1 from acc.enrollments where user_id = $1', [a]));
    expect(crossTeacher.rowCount).toBe(0);
  });
});
