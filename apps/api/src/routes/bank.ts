import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { withUser } from '../db.js';
import type { AuthAdapter, AuthUser } from '../auth.js';
import { requireReadable, requireUser, requireWritable } from '../guard.js';
import { HttpError } from '../errors.js';
import { IsoDate, SignedMoney } from '../schemas.js';

const cents = (s: string) => { const neg = s.startsWith('-'); const [i, f = ''] = s.replace('-', '').split('.'); const v = BigInt(i!) * 100n + BigInt((f + '00').slice(0, 2)); return neg ? -v : v; };

const Id = z.uuid();
const Params = z.object({ companyId: Id });
// ข้อความผิดเป็นภาษาไทยทุกช่อง (นักเรียนพิมพ์ statement เองเป็นบรรทัด) · ยอดเงินมีเครื่องหมาย: เงินเข้า + เงินออก −
const StatementLine = z.object({
  date: IsoDate, description: z.string().trim().min(1, 'ต้องมีรายละเอียด').max(300, 'รายละเอียดยาวเกิน 300 ตัว'),
  reference: z.string().trim().max(100, 'เลขอ้างอิงยาวเกิน 100 ตัว').optional(), amount: SignedMoney, balance: SignedMoney.optional(),
});
const Statement = z.object({
  accountCode: z.string().regex(/^11\d+$/, 'บัญชีธนาคารต้องเป็นรหัส 11xx เช่น 1120'), periodStart: IsoDate, periodEnd: IsoDate,
  openingBalance: SignedMoney, closingBalance: SignedMoney,
  lines: z.array(StatementLine).min(1, 'ต้องมีรายการอย่างน้อย 1 บรรทัด').max(500),
});
const Match = z.object({ statementLineId: Id, entryId: Id, amount: SignedMoney });

export function bankRoutes(app: FastifyInstance, pool: pg.Pool, auth: AuthAdapter) {
  const user = (req: FastifyRequest): Promise<AuthUser> => requireUser(auth, req);
  app.get('/companies/:companyId/bank-reconciliation', async (req) => {
    const { companyId } = Params.parse(req.params); const statementId = z.object({ statementId: Id.optional() }).parse(req.query).statementId;
    return withUser(pool, await user(req), async (c) => { await requireReadable(c, companyId);
      const statements = (await c.query(`select s.id,a.code as "accountCode",a.name as "accountName",to_char(s.period_start,'YYYY-MM-DD') as "periodStart",to_char(s.period_end,'YYYY-MM-DD') as "periodEnd",s.opening_balance::text as "openingBalance",s.closing_balance::text as "closingBalance" from acc.bank_statements s join acc.chart_of_accounts a on a.company_id=s.company_id and a.id=s.bank_account_id where s.company_id=$1 order by s.period_end desc`, [companyId])).rows;
      const id = statementId ?? statements[0]?.id; if (!id) return { statements, statement: null, lines: [], summary: null };
      const lines = await c.query(`select l.id,to_char(l.line_date,'YYYY-MM-DD') as date,l.description,l.reference,l.amount::text,l.balance::text,coalesce(sum(m.amount),0)::text as matched from acc.bank_statement_lines l left join acc.bank_reconciliation_matches m on m.company_id=l.company_id and m.statement_line_id=l.id where l.company_id=$1 and l.statement_id=$2 group by l.company_id,l.id order by l.line_date,l.id`, [companyId,id]);
      const summary = await c.query('select * from acc.bank_reconciliation($1,$2)', [companyId,id]);
      const entries = await c.query(`select e.id,e.doc_no as "docNo",to_char(e.entry_date,'YYYY-MM-DD') as date,e.description,(l.debit-l.credit)::text as amount from acc.journal_entries e join acc.journal_lines l on l.company_id=e.company_id and l.entry_id=e.id join acc.bank_statements s on s.company_id=e.company_id and s.id=$2 and l.account_id=s.bank_account_id where e.company_id=$1 and e.entry_date between s.period_start and s.period_end order by e.entry_date,e.doc_no`, [companyId,id]);
      return { statements, statement: statements.find((s) => s.id === id) ?? null, lines: lines.rows, entries: entries.rows, summary: summary.rows[0] ?? null };
    });
  });
  app.post('/companies/:companyId/bank-reconciliation/statements', async (req, reply) => {
    const { companyId } = Params.parse(req.params); const b = Statement.parse(req.body);
    if (b.periodEnd < b.periodStart) throw new HttpError(400, 'invalid', 'วันสิ้นงวดต้องไม่ก่อนวันเริ่มงวด');
    const outside = b.lines.findIndex((l) => l.date < b.periodStart || l.date > b.periodEnd);
    if (outside >= 0) throw new HttpError(422, 'invalid', `บรรทัดที่ ${outside + 1}: วันที่อยู่นอกงวดของ statement`);
    const zero = b.lines.findIndex((l) => cents(l.amount) === 0n);
    if (zero >= 0) throw new HttpError(422, 'invalid', `บรรทัดที่ ${zero + 1}: จำนวนเงินต้องไม่เป็นศูนย์`);
    // ยอดต้นงวด + รายการ = ยอดปลายงวด (statement พิมพ์ผิด ผลกระทบยอดจะผิดทั้งหน้า)
    const sum = b.lines.reduce((t, l) => t + cents(l.amount), cents(b.openingBalance));
    if (sum !== cents(b.closingBalance)) {
      const m = (n: bigint) => `${n < 0n ? '-' : ''}${(n < 0n ? -n : n) / 100n}.${((n < 0n ? -n : n) % 100n).toString().padStart(2, '0')}`;
      throw new HttpError(422, 'invalid', `ยอดต้นงวด + รายการ = ${m(sum)} ไม่เท่ากับยอดปลายงวด ${m(cents(b.closingBalance))}`);
    }
    const row = await withUser(pool, await user(req), async (c) => { await requireWritable(c, companyId);
      const acct = await c.query(`select 1 from acc.chart_of_accounts where company_id=$1 and code=$2`, [companyId, b.accountCode]);
      if (!acct.rowCount) throw new HttpError(422, 'ACC04', `ไม่มีบัญชีรหัส ${b.accountCode} ในผังบัญชี`);
      const s = (await c.query(`insert into acc.bank_statements(company_id,bank_account_id,period_start,period_end,opening_balance,closing_balance,imported_by) select $1,id,$2,$3,$4,$5,$6 from acc.chart_of_accounts where company_id=$1 and code=$7 returning id`, [companyId,b.periodStart,b.periodEnd,b.openingBalance,b.closingBalance,(await user(req)).id,b.accountCode])).rows[0];
      for (const l of b.lines) await c.query(`insert into acc.bank_statement_lines(company_id,statement_id,line_date,description,reference,amount,balance) values($1,$2,$3,$4,$5,$6,$7)`, [companyId,s.id,l.date,l.description,l.reference ?? '',l.amount,l.balance ?? null]); return s;
    }); return reply.code(201).send(row);
  });
  app.post('/companies/:companyId/bank-reconciliation/matches', async (req, reply) => {
    const { companyId } = Params.parse(req.params); const b = Match.parse(req.body);
    await withUser(pool, await user(req), async (c) => { await requireWritable(c, companyId); await c.query(`insert into acc.bank_reconciliation_matches(company_id,statement_line_id,entry_id,amount,created_by) values($1,$2,$3,$4,$5) on conflict(company_id,statement_line_id,entry_id) do nothing`, [companyId,b.statementLineId,b.entryId,b.amount,(await user(req)).id]); }); return reply.code(204).send();
  });
}
