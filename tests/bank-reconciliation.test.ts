import { afterAll, describe, expect, it } from 'vitest';
import { asUser, newCompany, newSchool, newUser, pool, post } from './helpers';

afterAll(() => pool.end());

describe('กระทบยอดธนาคาร', () => {
  it('จับคู่ statement กับสมุดรายวัน และแสดงยอดคงเหลือที่ยังไม่จับคู่', async () => {
    const school = await newSchool();
    const owner = await newUser(school, 'student');
    const company = await newCompany(owner);
    const entry = (await asUser(owner, (c) => post(c, company, '2026-10-10', [
      { account_code: '1120', debit: '1000.00' }, { account_code: '4110', credit: '1000.00' },
    ]))).rows[0].id as string;
    const statement = await asUser(owner, (c) => c.query(
      `insert into acc.bank_statements(company_id,bank_account_id,period_start,period_end,opening_balance,closing_balance,imported_by)
       select $1,id,'2026-10-01','2026-10-31',0,1000,$2 from acc.chart_of_accounts where company_id=$1 and code='1120' returning id`, [company, owner]));
    const sid = statement.rows[0].id as string;
    const line = await asUser(owner, (c) => c.query(
      `insert into acc.bank_statement_lines(company_id,statement_id,line_date,description,reference,amount,balance)
       values($1,$2,'2026-10-10','รับชำระลูกค้า','TRX-1',1000,1000) returning id`, [company, sid]));
    const lid = line.rows[0].id as string;
    await asUser(owner, (c) => c.query(
      `insert into acc.bank_reconciliation_matches(company_id,statement_line_id,entry_id,amount,created_by) values($1,$2,$3,1000,$4)`, [company,lid,entry,owner]));
    const summary = await asUser(owner, (c) => c.query(`select * from acc.bank_reconciliation($1,$2)`, [company,sid]));
    expect(summary.rows[0]).toEqual({ opening_balance:'0.00', closing_balance:'1000.00', statement_total:'1000.00', book_balance:'1000.00', unmatched_bank:'0.00', unmatched_book:'0.00' });
  });
});
