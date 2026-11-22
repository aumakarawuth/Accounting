import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { querySequence, withUser } from '../db.js';
import type { AuthAdapter, AuthUser } from '../auth.js';
import { requireReadable, requireUser, requireWritable } from '../guard.js';
import {
  CompanyParams, EmployeeInput, EmployeeParams, IdempotencyKey, MonthQuery, PayrollInput, PayrollPreview, PayrollRemit, PayrollVoidParams, VoidDocument,
} from '../schemas.js';

// เฟส 7 โมดูล 3 (docs/phase7-spec.md ข้อ 3): เงินเดือนแบบง่าย — ชั้นบาง Zod → ฟังก์ชันใน DB
export type PayrollData = Awaited<ReturnType<typeof payrollData>>;
const lineJson = (l: { employee: string; salary: string; otherIncome: string; wht: string }) =>
  ({ employee: l.employee, salary: l.salary, other_income: l.otherIncome, wht: l.wht });

/** ข้อมูลหน้าเงินเดือน/รายงาน ของเดือน (ทะเบียน · เงินเดือนที่ลงแล้ว · นำส่ง · สรุปทั้งปีปฏิทินรายคน) */
export async function payrollData(c: pg.PoolClient, id: string, month: string) {
  const m = `${month}-01`;
  const [co, employees, runs, lines, remits, year, cash] = await querySequence([
    () => c.query(`select app.can_write_company(id) as "canWrite", app.company_locked(id) as locked, acc.sso_ceiling($2::date)::text as ceiling
                     from acc.companies where id = $1`, [id, m]),
    () => c.query(`select id, code, name, position, salary::text, sso, active, version from acc.employees where company_id = $1 order by code`, [id]),
    () => c.query(`select r.id, to_char(r.month, 'YYYY-MM') as month, to_char(r.pay_date, 'YYYY-MM-DD') as "payDate", r.wages::text, r.sso_employee::text as "ssoEmployee",
                          r.sso_employer::text as "ssoEmployer", r.wht::text, r.net::text, r.entry_id as "entryId", j.doc_no as "docNo", ca.code as "cashAccount",
                          r.voided_at is not null as voided, v.doc_no as "voidDocNo", r.void_reason as "voidReason"
                     from acc.payroll_runs r join acc.journal_entries j on j.company_id = r.company_id and j.id = r.entry_id
                     join acc.chart_of_accounts ca on ca.company_id = r.company_id and ca.id = r.cash_account_id
                     left join acc.journal_entries v on v.company_id = r.company_id and v.id = r.void_entry_id
                    where r.company_id = $1 and r.month = $2::date order by r.created_at desc`, [id, m]),
    () => c.query(`select l.run_id as "runId", e.code, e.name, e.position, l.salary::text, l.other_income::text as "otherIncome", l.wage_base::text as "wageBase",
                          l.sso_employee::text as "ssoEmployee", l.sso_employer::text as "ssoEmployer", l.wht::text, l.net::text
                     from acc.payroll_lines l join acc.payroll_runs r on r.company_id = l.company_id and r.id = l.run_id
                     join acc.employees e on e.company_id = l.company_id and e.id = l.employee_id
                    where l.company_id = $1 and r.month = $2::date order by e.code`, [id, m]),
    () => c.query(`select x.id, x.kind, to_char(x.remit_date, 'YYYY-MM-DD') as date, x.amount::text, x.entry_id as "entryId", j.doc_no as "docNo",
                          x.voided_at is not null as voided, v.doc_no as "voidDocNo"
                     from acc.payroll_remittances x join acc.journal_entries j on j.company_id = x.company_id and j.id = x.entry_id
                     left join acc.journal_entries v on v.company_id = x.company_id and v.id = x.void_entry_id
                    where x.company_id = $1 and x.month = $2::date order by x.created_at desc`, [id, m]),
    // สรุปทั้งปีปฏิทิน (ภ.ง.ด.1ก / 50 ทวิ) จากเงินเดือนที่ยังไม่ยกเลิก
    () => c.query(`select e.code, e.name, count(*)::int as months, sum(l.salary + l.other_income)::numeric(18,2)::text as income,
                          sum(l.sso_employee)::numeric(18,2)::text as sso, sum(l.wht)::numeric(18,2)::text as wht
                     from acc.payroll_lines l join acc.payroll_runs r on r.company_id = l.company_id and r.id = l.run_id and r.voided_at is null
                     join acc.employees e on e.company_id = l.company_id and e.id = l.employee_id
                    where l.company_id = $1 and r.month >= date_trunc('year', $2::date) and r.month < date_trunc('year', $2::date) + interval '1 year'
                    group by e.code, e.name order by e.code`, [id, m]),
    () => c.query(`select code, name from acc.chart_of_accounts where company_id = $1 and active and type = 'asset' and code like '11%' order by code`, [id]),
  ] as const);
  return { month, ...co.rows[0], employees: employees.rows, runs: runs.rows, lines: lines.rows, remittances: remits.rows, year: year.rows, cashAccounts: cash.rows } as {
    month: string; canWrite: boolean; locked: boolean; ceiling: string;
    employees: { id: string; code: string; name: string; position: string; salary: string; sso: boolean; active: boolean; version: number }[];
    runs: { id: string; month: string; payDate: string; wages: string; ssoEmployee: string; ssoEmployer: string; wht: string; net: string; entryId: string; docNo: string;
      cashAccount: string; voided: boolean; voidDocNo: string | null; voidReason: string | null }[];
    lines: { runId: string; code: string; name: string; position: string; salary: string; otherIncome: string; wageBase: string; ssoEmployee: string; ssoEmployer: string; wht: string; net: string }[];
    remittances: { id: string; kind: 'sso' | 'pnd1'; date: string; amount: string; entryId: string; docNo: string; voided: boolean; voidDocNo: string | null }[];
    year: { code: string; name: string; months: number; income: string; sso: string; wht: string }[];
    cashAccounts: { code: string; name: string }[];
  };
}

export function payrollRoutes(app: FastifyInstance, pool: pg.Pool, auth: AuthAdapter) {
  const user = (req: FastifyRequest): Promise<AuthUser> => requireUser(auth, req);
  const idemKey = (req: FastifyRequest) => IdempotencyKey.parse(req.headers['idempotency-key']);
  const thisMonth = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 7);

  app.get('/companies/:companyId/payroll', async (req) => {
    const { companyId: id } = CompanyParams.parse(req.params);
    const { month } = MonthQuery.parse(req.query);
    return withUser(pool, await user(req), async (c) => { await requireReadable(c, id); return payrollData(c, id, month ?? thisMonth()); });
  });
  app.post('/companies/:companyId/employees', async (req, reply) => {
    const { companyId: id } = CompanyParams.parse(req.params);
    const b = EmployeeInput.parse(req.body);
    const row = await withUser(pool, await user(req), async (c) => {
      await requireWritable(c, id);
      const x = (await c.query('select acc.save_employee($1, null, $2::jsonb, null) id', [id, JSON.stringify(b)])).rows[0].id;
      return (await c.query(`select id, code, name, version from acc.employees where company_id = $1 and id = $2`, [id, x])).rows[0];
    });
    return reply.code(201).send(row);
  });
  app.put('/companies/:companyId/employees/:id', async (req) => {
    const { companyId: co, id } = EmployeeParams.parse(req.params);
    const b = EmployeeInput.parse(req.body);
    return withUser(pool, await user(req), async (c) => {
      await requireWritable(c, co);
      await c.query('select acc.save_employee($1, $2, $3::jsonb, $4)', [co, id, JSON.stringify(b), b.version ?? 0]);
      return (await c.query(`select id, code, name, version from acc.employees where company_id = $1 and id = $2`, [co, id])).rows[0];
    });
  });
  app.post('/companies/:companyId/payroll/preview', async (req) => {
    const { companyId: id } = CompanyParams.parse(req.params);
    const b = PayrollPreview.parse(req.body);
    return withUser(pool, await user(req), async (c) => {
      await requireReadable(c, id);
      return (await c.query('select acc.payroll_compute($1, $2::date, $3::jsonb) r', [id, `${b.month}-01`, JSON.stringify(b.lines.map(lineJson))])).rows[0].r;
    });
  });
  app.post('/companies/:companyId/payroll', async (req, reply) => {
    const { companyId: id } = CompanyParams.parse(req.params);
    const b = PayrollInput.parse(req.body);
    const key = idemKey(req);
    const row = await withUser(pool, await user(req), async (c) => {
      await requireWritable(c, id);
      const x = (await c.query('select acc.post_payroll($1, $2::jsonb, $3) id', [id, JSON.stringify({
        month: `${b.month}-01`, pay_date: b.payDate, cash_account: b.cashAccount, lines: b.lines.map(lineJson) }), key])).rows[0].id;
      return (await c.query(`select r.id, j.doc_no as "docNo", r.entry_id as "entryId", r.wages::text, r.sso_employee::text as "ssoEmployee",
                                    r.sso_employer::text as "ssoEmployer", r.wht::text, r.net::text
                               from acc.payroll_runs r join acc.journal_entries j on j.company_id = r.company_id and j.id = r.entry_id
                              where r.company_id = $1 and r.id = $2`, [id, x])).rows[0];
    });
    return reply.code(201).send(row);
  });
  app.post('/companies/:companyId/payroll/remit', async (req, reply) => {
    const { companyId: id } = CompanyParams.parse(req.params);
    const b = PayrollRemit.parse(req.body);
    const key = idemKey(req);
    const row = await withUser(pool, await user(req), async (c) => {
      await requireWritable(c, id);
      const x = (await c.query('select acc.remit_payroll($1, $2::jsonb, $3) id', [id, JSON.stringify({ month: `${b.month}-01`, kind: b.kind, date: b.date, cash_account: b.cashAccount }), key])).rows[0].id;
      return (await c.query(`select x.id, x.amount::text, j.doc_no as "docNo", x.entry_id as "entryId" from acc.payroll_remittances x
                               join acc.journal_entries j on j.company_id = x.company_id and j.id = x.entry_id where x.company_id = $1 and x.id = $2`, [id, x])).rows[0];
    });
    return reply.code(201).send(row);
  });
  app.post('/companies/:companyId/payroll/:kind/:id/void', async (req) => {
    const { companyId: co, kind, id } = PayrollVoidParams.parse(req.params);
    const b = VoidDocument.parse(req.body);
    const key = idemKey(req);
    return withUser(pool, await user(req), async (c) => {
      await requireWritable(c, co);
      const rv = (await c.query('select acc.void_payroll($1, $2, $3, $4, $5, $6) id', [co, kind, id, b.date, b.reason, key])).rows[0].id;
      return { voidDocNo: (await c.query('select doc_no from acc.journal_entries where company_id = $1 and id = $2', [co, rv])).rows[0].doc_no };
    });
  });
}
