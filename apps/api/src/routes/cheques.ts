import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { querySequence, withUser } from '../db.js';
import type { AuthAdapter, AuthUser } from '../auth.js';
import { requireReadable, requireUser, requireWritable } from '../guard.js';
import { HttpError } from '../errors.js';
import { ChequeAction, ChequeParams, CompanyParams, IdempotencyKey, NewCheque } from '../schemas.js';

// เฟส 3.3 เช็ครับ/เช็คจ่าย: ชั้นบาง Zod → acc.register_cheque / acc.cheque_action (กติกาบัญชีอยู่ใน DB)

const ROW = `id, direction, cheque_no as "chequeNo", bank_name as "bankName", bank_branch as "bankBranch",
  to_char(cheque_date, 'YYYY-MM-DD') as "chequeDate", to_char(issue_date, 'YYYY-MM-DD') as "issueDate", amount::text,
  party_name as "partyName", holding_code as "holdingCode", bank_code as "bankCode", counter_code as "counterCode", status,
  to_char(status_date, 'YYYY-MM-DD') as "statusDate", deposit_code as "depositCode",
  coalesce(document_id, purchase_document_id) as "documentId", doc_no as "documentNo", entry_id as "entryId",
  entry_doc_no as "entryDocNo", status_entry_id as "statusEntryId", status_doc_no as "statusDocNo", postdated, description`;

export function chequeRoutes(app: FastifyInstance, pool: pg.Pool, auth: AuthAdapter) {
  const user = (req: FastifyRequest): Promise<AuthUser> => requireUser(auth, req);
  const idemKey = (req: FastifyRequest) => IdempotencyKey.parse(req.headers['idempotency-key']);

  app.get('/companies/:companyId/cheques', async (req) => {
    const { companyId } = CompanyParams.parse(req.params);
    return withUser(pool, await user(req), async (c) => {
      await requireReadable(c, companyId);
      const [company, rows, accounts] = await querySequence([
        () => c.query(`select name, app.can_write_company(id) as "canWrite", app.company_locked(id) as locked from acc.companies where id = $1`, [companyId]),
        () => c.query(`select ${ROW} from acc.cheque_register($1)`, [companyId]),
        () => c.query(`select code, name, type from acc.chart_of_accounts where company_id = $1 and active order by code`, [companyId]),
      ] as const);
      const all = accounts.rows as { code: string; name: string; type: string }[];
      return {
        company: company.rows[0],
        cheques: rows.rows,
        // บัญชีเงินฝากธนาคาร (11xx ที่ไม่ใช่เงินสด/เงินสดย่อย) และบัญชีคู่ที่เลือกได้ (ทุกบัญชีที่ไม่ใช่บัญชีพักเช็ค)
        bankAccounts: all.filter((a) => a.type === 'asset' && a.code.startsWith('11') && a.code !== '1110' && a.code !== '1140').map(({ code, name }) => ({ code, name })),
        accounts: all.filter((a) => !['1220', '1221', '2120', '2121'].includes(a.code)).map(({ code, name }) => ({ code, name })),
      };
    });
  });

  app.post('/companies/:companyId/cheques', async (req, reply) => {
    const { companyId } = CompanyParams.parse(req.params);
    const b = NewCheque.parse(req.body);
    if ([b.counterAccount, b.receipt, b.payment].filter(Boolean).length !== 1) {
      throw new HttpError(400, 'invalid', 'ระบุบัญชีคู่ หรือเลือกใบที่รับ/จ่ายชำระ อย่างใดอย่างหนึ่ง');
    }
    if ((b.receipt && b.direction !== 'received') || (b.payment && b.direction !== 'paid')) {
      throw new HttpError(400, 'invalid', 'ใบเสร็จรับชำระใช้กับเช็ครับ การจ่ายชำระใช้กับเช็คจ่าย');
    }
    const key = idemKey(req);
    const payload = {
      direction: b.direction, cheque_no: b.chequeNo, bank_name: b.bankName, bank_branch: b.bankBranch, cheque_date: b.chequeDate,
      date: b.date, amount: b.amount, party_name: b.partyName, description: b.description, bank_account: b.bankAccount,
      counter_account: b.counterAccount,
      receipt: b.receipt && {
        party_code: b.receipt.partyCode, wht_amount: b.receipt.whtAmount,
        allocations: b.receipt.allocations.map((a) => ({ document_id: a.documentId, amount: a.amount })),
      },
      payment: b.payment && {
        party_code: b.payment.partyCode, wht_kind: b.payment.whtKind, wht_rate: b.payment.whtRate,
        allocations: b.payment.allocations.map((a) => ({ document_id: a.documentId, amount: a.amount })),
      },
    };
    const row = await withUser(pool, await user(req), async (c) => {
      await requireWritable(c, companyId);
      const id = (await c.query('select acc.register_cheque($1, $2::jsonb, $3) id', [companyId, JSON.stringify(payload), key])).rows[0].id as string;
      return (await c.query(`select ${ROW} from acc.cheque_register($1) where id = $2`, [companyId, id])).rows[0];
    });
    return reply.code(201).send(row);
  });

  app.post('/companies/:companyId/cheques/:chequeId/actions', async (req) => {
    const { companyId, chequeId } = ChequeParams.parse(req.params);
    const b = ChequeAction.parse(req.body);
    const key = idemKey(req);
    return withUser(pool, await user(req), async (c) => {
      await requireWritable(c, companyId);
      await c.query('select acc.cheque_action($1, $2, $3, $4, $5, $6, $7)', [companyId, chequeId, b.action, b.date, b.bankAccount ?? null, b.note ?? '', key]);
      return (await c.query(`select ${ROW} from acc.cheque_register($1) where id = $2`, [companyId, chequeId])).rows[0];
    });
  });
}
