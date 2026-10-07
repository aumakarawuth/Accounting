import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { pool, asUser, newSchool, newUser, newCompany, post, money, sqlstate } from './helpers';

afterAll(() => pool.end());

const CODES = ['1110', '1210', '2110', '3110', '4110', '5210', '5220'];

async function setup() {
  const school = await newSchool();
  const owner = await newUser(school, 'student');
  const company = await newCompany(owner);
  return { school, owner, company };
}

const expectCode = async (p: Promise<unknown>, code: string) => {
  await expect(p).rejects.toSatisfy((e: any) => sqlstate(e) === code);
};

describe('ความถูกต้องของสมุดรายวัน', () => {
  it('ธุรกรรมสุ่ม 20,000 รายการ (พร้อมกัน 16 คำขอ) งบทดลองดุลและตรงกับสมุดรายวัน', async () => {
    const school = await newSchool();
    const owners = await Promise.all([1, 2, 3, 4].map(() => newUser(school, 'student')));
    const companies = await Promise.all(owners.map((o) => newCompany(o)));
    const N = 20_000;
    let next = 0;
    const rnd = (n: number) => Math.floor(Math.random() * n);

    async function worker() {
      while (next < N) {
        const i = next++;
        const k = i % 4;
        // สุ่มจำนวนบรรทัดเดบิต/เครดิต แล้วแบ่งยอดเป็นสตางค์ให้ดุลพอดี
        const total = 1 + rnd(5_000_000);
        const split = (parts: number) => {
          const cuts = Array.from({ length: parts - 1 }, () => rnd(total)).sort((a, b) => a - b);
          const out: number[] = [];
          let prev = 0;
          for (const c of [...cuts, total]) { out.push(c - prev); prev = c; }
          return out.filter((x) => x > 0);
        };
        const dr = split(1 + rnd(3)), cr = split(1 + rnd(3));
        const lines = [
          ...dr.map((x) => ({ account_code: CODES[rnd(7)], debit: money(x) })),
          ...cr.map((x) => ({ account_code: CODES[rnd(7)], credit: money(x) })),
        ];
        const month = 1 + rnd(12);
        await asUser(owners[k], (c) => post(c, companies[k], `2026-${String(month).padStart(2, '0')}-10`, lines));
      }
    }
    await Promise.all(Array.from({ length: 16 }, worker));

    for (const co of companies) {
      const truth = await pool.query(
        `select coalesce(sum(debit),0) d, coalesce(sum(credit),0) c, count(distinct entry_id) n from acc.journal_lines where company_id=$1`, [co]);
      expect(truth.rows[0].d).toBe(truth.rows[0].c);
      expect(Number(truth.rows[0].n)).toBe(N / 4);

      // account_balances ต้องเท่ากับที่รวมใหม่จากสมุดรายวันทุกบัญชี ทุกงวด
      const diff = await pool.query(
        `with t as (
           select e.period_id, l.account_id, sum(l.debit) d, sum(l.credit) c
             from acc.journal_lines l join acc.journal_entries e on e.company_id=l.company_id and e.id=l.entry_id
            where l.company_id=$1 group by 1,2),
         b as (select period_id, account_id, debit_total, credit_total from acc.account_balances where company_id=$1)
         select count(*)::int n from t full join b using (period_id, account_id)
          where t.d is distinct from b.debit_total or t.c is distinct from b.credit_total`, [co]);
      expect(diff.rows[0].n).toBe(0);

      const tb = await asUser(owners[companies.indexOf(co)], (c) => c.query('select * from acc.trial_balance($1)', [co]));
      const sd = tb.rows.reduce((a, r) => a + Math.round(Number(r.debit_total) * 100), 0);
      const sc = tb.rows.reduce((a, r) => a + Math.round(Number(r.credit_total) * 100), 0);
      expect(sd).toBe(sc);
    }
  });

  it('ลงรายการไม่ดุลถูกปฏิเสธ พร้อมข้อความบอกผลต่าง', async () => {
    const { owner, company } = await setup();
    const p = asUser(owner, (c) => post(c, company, '2026-10-01', [
      { account_code: '1110', debit: '12500.00' }, { account_code: '4110', credit: '12000.00' }]));
    await expectCode(p, 'ACC01');
    await expect(p).rejects.toThrow('เดบิต 12,500.00 ไม่เท่าเครดิต 12,000.00 ผลต่าง 500.00');
  });

  it('เขียนตรงเข้าตารางแบบไม่ดุลจากชั้นล่าง ต้องล้มตอน COMMIT (deferred constraint)', async () => {
    const { owner, company } = await setup();
    const c = await pool.connect();
    try {
      await c.query('begin');
      const pid = (await c.query(
        `insert into acc.periods(company_id,start_date,end_date) values ($1,'2027-01-01','2027-01-31') returning id`, [company])).rows[0].id;
      const eid = randomUUID();
      await c.query(
        `insert into acc.journal_entries(company_id,id,period_id,doc_prefix,doc_no,entry_date,total_amount,posted_by)
         values ($1,$2,$3,'ZZ','ZZ-0001','2027-01-05',100,$4)`, [company, eid, pid, owner]);
      const acct = (await c.query(`select id from acc.chart_of_accounts where company_id=$1 and code='1110'`, [company])).rows[0].id;
      const acct2 = (await c.query(`select id from acc.chart_of_accounts where company_id=$1 and code='4110'`, [company])).rows[0].id;
      await c.query(`insert into acc.journal_lines(company_id,entry_id,line_no,account_id,debit) values ($1,$2,1,$3,100)`, [company, eid, acct]);
      await c.query(`insert into acc.journal_lines(company_id,entry_id,line_no,account_id,credit) values ($1,$2,2,$3,99.99)`, [company, eid, acct2]);
      await expectCode(c.query('commit'), 'ACC01');
    } finally {
      await c.query('rollback').catch(() => {});
      c.release();
    }
  });

  it('ปฏิเสธเงินทศนิยมเกิน 2 ตำแหน่ง ด้านทั้งสอง ศูนย์ และรหัสบัญชีที่ไม่มี', async () => {
    const { owner, company } = await setup();
    const run = (lines: any[]) => asUser(owner, (c) => post(c, company, '2026-10-01', lines));
    await expectCode(run([{ account_code: '1110', debit: '0.001' }, { account_code: '4110', credit: '0.001' }]), 'ACC05');
    await expectCode(run([{ account_code: '1110', debit: '5', credit: '5' }, { account_code: '4110', credit: '0' }]), 'ACC05');
    await expectCode(run([{ account_code: '1110', debit: '-5' }, { account_code: '4110', credit: '-5' }]), 'ACC05');
    await expectCode(run([{ account_code: '9999', debit: '5' }, { account_code: '4110', credit: '5' }]), 'ACC04');
    await expectCode(run([{ account_code: '1110', debit: '5' }]), 'ACC01');
  });

  it('ใช้ idempotency key เดิมซ้ำ ไม่เกิดรายการซ้ำ และคืนรายการเดิม', async () => {
    const { owner, company } = await setup();
    const lines = [{ account_code: '1110', debit: '100.00' }, { account_code: '4110', credit: '100.00' }];
    const key = randomUUID();
    const a = await asUser(owner, (c) => post(c, company, '2026-10-01', lines, key));
    const b = await asUser(owner, (c) => post(c, company, '2026-10-01', lines, key));
    expect(b.rows[0].id).toBe(a.rows[0].id);
    // ซ้ำพร้อมกัน 20 คำขอ
    const key2 = randomUUID();
    const ids = await Promise.all(Array.from({ length: 20 }, () => asUser(owner, (c) => post(c, company, '2026-10-01', lines, key2))));
    expect(new Set(ids.map((r) => r.rows[0].id)).size).toBe(1);
    const n = await pool.query('select count(*)::int n from acc.journal_entries where company_id=$1', [company]);
    expect(n.rows[0].n).toBe(2);
    // key เดิมแต่เนื้อหาต่าง
    await expectCode(
      asUser(owner, (c) => post(c, company, '2026-10-01', [{ account_code: '1110', debit: '1.00' }, { account_code: '4110', credit: '1.00' }], key)),
      'ACC03');
  });

  it('ลงพร้อมกัน เลขที่เอกสารไม่ซ้ำ ไม่ข้าม', async () => {
    const { owner, company } = await setup();
    const lines = [{ account_code: '1110', debit: '1.00' }, { account_code: '4110', credit: '1.00' }];
    await Promise.all(Array.from({ length: 200 }, () => asUser(owner, (c) => post(c, company, '2026-10-01', lines))));
    const r = await pool.query(`select doc_no from acc.journal_entries where company_id=$1 order by doc_no`, [company]);
    expect(r.rows.map((x) => x.doc_no)).toEqual(Array.from({ length: 200 }, (_, i) => `JV-${String(i + 1).padStart(4, '0')}`));
  });

  it('งวดที่ปิดแล้วลงไม่ได้ (ทั้งผ่านฟังก์ชันและเขียนตรง) เปิดงวดแล้วลงได้', async () => {
    const { owner, company } = await setup();
    const lines = [{ account_code: '1110', debit: '1.00' }, { account_code: '4110', credit: '1.00' }];
    await asUser(owner, (c) => post(c, company, '2026-09-15', lines));
    await asUser(owner, (c) => c.query(`select acc.close_period($1,'2026-09-01')`, [company]));
    await expectCode(asUser(owner, (c) => post(c, company, '2026-09-20', lines)), 'ACC02');
    await expect(
      pool.query(
        `insert into acc.journal_entries(company_id,period_id,doc_prefix,doc_no,entry_date,total_amount,posted_by)
         select $1,id,'ZZ','ZZ-1','2026-09-20',1,$2 from acc.periods where company_id=$1 and start_date='2026-09-01'`, [company, owner]),
    ).rejects.toSatisfy((e: any) => sqlstate(e) === 'ACC02');
    await asUser(owner, (c) => c.query(`select acc.reopen_period($1,'2026-09-01')`, [company]));
    await asUser(owner, (c) => post(c, company, '2026-09-20', lines));
  });

  it('สมุดรายวันแก้/ลบไม่ได้ แม้เป็นเจ้าของตาราง ใช้กลับรายการแทน (กลับได้ครั้งเดียว)', async () => {
    const { owner, company } = await setup();
    const lines = [{ account_code: '1110', debit: '250.00' }, { account_code: '4110', credit: '250.00' }];
    const eid = (await asUser(owner, (c) => post(c, company, '2026-10-02', lines))).rows[0].id;
    await expectCode(pool.query(`update acc.journal_lines set debit=1 where entry_id=$1`, [eid]), 'ACC06');
    await expectCode(pool.query(`delete from acc.journal_entries where id=$1`, [eid]), 'ACC06');
    await expectCode(pool.query(`truncate acc.journal_lines`), 'ACC06');
    await expect(asUser(owner, (c) => c.query(`delete from acc.journal_lines where entry_id=$1`, [eid]))).rejects.toThrow(/permission denied/);

    const rv = await asUser(owner, (c) => c.query(`select acc.reverse_journal($1,$2,'2026-10-03',$3) id`, [company, eid, randomUUID()]));
    const tb = await asUser(owner, (c) => c.query('select * from acc.trial_balance($1)', [company]));
    for (const r of tb.rows.filter((r) => ['1110', '4110'].includes(r.code))) {
      expect(Number(r.debit_total)).toBe(250);
      expect(Number(r.credit_total)).toBe(250);
    }
    expect(rv.rows[0].id).toBeTruthy();
    await expect(asUser(owner, (c) => c.query(`select acc.reverse_journal($1,$2,'2026-10-04',$3)`, [company, eid, randomUUID()]))).rejects.toThrow();
  });

  it('ล็อกเวอร์ชัน: แก้โดยไม่เพิ่ม version ถูกปฏิเสธ แก้พร้อมกันคนที่สองไม่โดน', async () => {
    const { owner, company } = await setup();
    await expectCode(asUser(owner, (c) => c.query(`update acc.chart_of_accounts set name='x' where company_id=$1 and code='1110'`, [company])), '40001');
    const upd = (v: number) => asUser(owner, (c) => c.query(
      `update acc.chart_of_accounts set name='เงินสดในมือ', version=version+1 where company_id=$1 and code='1110' and version=$2`, [company, v]));
    expect((await upd(1)).rowCount).toBe(1);
    expect((await upd(1)).rowCount).toBe(0);
  });
});
