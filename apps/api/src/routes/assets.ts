import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { querySequence, withUser } from '../db.js';
import type { AuthAdapter, AuthUser } from '../auth.js';
import { requireReadable, requireUser, requireWritable } from '../guard.js';
import {
  CompanyParams, DepreciationRun, DepreciationRunParams, DisposalParams, DisposeAsset, FixedAssetParams, IdempotencyKey, MonthQuery,
  NewFixedAsset, VoidRun, VoidWithReason,
} from '../schemas.js';

// เฟส 3.4 สินทรัพย์ถาวร: ชั้นบาง Zod → ฟังก์ชันใน DB (register/post_depreciation/dispose และการกลับรายการ)

const ROW = `id, code, name, to_char(acquired_date, 'YYYY-MM-DD') as "acquiredDate", to_char(dep_start, 'YYYY-MM') as "depStart",
  cost::text, salvage::text, life_months as "lifeMonths", monthly::text, asset_code as "assetCode", accum_code as "accumCode",
  expense_code as "expenseCode", months_posted as "monthsPosted", accumulated::text, dep_this_month::text as "depThisMonth",
  book_value::text as "bookValue", status, disposal_id as "disposalId", to_char(disposal_date, 'YYYY-MM-DD') as "disposalDate",
  proceeds::text, gain_loss::text as "gainLoss", entry_id as "entryId", disposal_entry_id as "disposalEntryId",
  to_char(next_month, 'YYYY-MM') as "nextMonth", dep_method as "depMethod", total_months as "totalMonths",
  disposal_vat::text as "disposalVat"`;

const thaiNow = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit' }).format(new Date()).slice(0, 7);

export function assetRoutes(app: FastifyInstance, pool: pg.Pool, auth: AuthAdapter) {
  const user = (req: FastifyRequest): Promise<AuthUser> => requireUser(auth, req);
  const idemKey = (req: FastifyRequest) => IdempotencyKey.parse(req.headers['idempotency-key']);

  // ทะเบียนสินทรัพย์ ณ สิ้นเดือน + รอบค่าเสื่อม + บัญชีที่ฟอร์มใช้
  app.get('/companies/:companyId/fixed-assets', async (req) => {
    const { companyId } = CompanyParams.parse(req.params);
    const month = MonthQuery.parse(req.query).month ?? thaiNow();
    return withUser(pool, await user(req), async (c) => {
      await requireReadable(c, companyId);
      const [company, assets, runs, accounts, customers] = await querySequence([
        () => c.query(`select name, app.can_write_company(id) as "canWrite", app.company_locked(id) as locked, vat_registered as "vatRegistered",
                         vat_rate::text as "vatRate" from acc.companies where id = $1`, [companyId]),
        () => c.query(`select ${ROW} from acc.fixed_asset_register($1, $2) where not voided`, [companyId, `${month}-01`]),
        () => c.query(
          `select r.id, to_char(r.month, 'YYYY-MM') as month, e.id as "entryId", e.doc_no as "docNo", to_char(e.entry_date, 'YYYY-MM-DD') as date,
                  coalesce((select sum(l.amount) from acc.depreciation_lines l where l.company_id = r.company_id and l.run_id = r.id), 0)::text as amount,
                  (select count(*)::int from acc.depreciation_lines l where l.company_id = r.company_id and l.run_id = r.id) as lines,
                  r.voided_at is not null as voided, ve.doc_no as "voidDocNo"
             from acc.depreciation_runs r
             left join acc.journal_entries e on e.company_id = r.company_id and e.id = r.entry_id
             left join acc.journal_entries ve on ve.company_id = r.company_id and ve.id = r.void_entry_id
            where r.company_id = $1 order by r.created_at desc limit 60`, [companyId]),
        () => c.query(`select code, name, type from acc.chart_of_accounts where company_id = $1 and active order by code`, [companyId]),
        () => c.query(`select code, name from acc.parties where company_id = $1 and active and is_customer order by code`, [companyId]),
      ] as const);
      const all = accounts.rows as { code: string; name: string; type: string }[];
      const pick = (f: (a: { code: string; type: string }) => boolean) => all.filter(f).map(({ code, name }) => ({ code, name }));
      return {
        company: company.rows[0], month, assets: assets.rows, runs: runs.rows,
        assetAccounts: pick((a) => a.type === 'asset' && a.code.startsWith('16')),
        expenseAccounts: pick((a) => a.type === 'expense'),
        accounts: pick((a) => a.code !== '2210'),
        customers: customers.rows,
      };
    });
  });

  app.post('/companies/:companyId/fixed-assets', async (req, reply) => {
    const { companyId } = CompanyParams.parse(req.params);
    const b = NewFixedAsset.parse(req.body);
    const key = idemKey(req);
    const payload = {
      code: b.code, name: b.name, acquired_date: b.acquiredDate, dep_start: b.depStart ? `${b.depStart}-01` : null, cost: b.cost,
      salvage: b.salvage, life_months: b.lifeMonths, dep_method: b.depMethod, asset_account: b.assetAccount, accum_account: b.accumAccount,
      expense_account: b.expenseAccount, counter_account: b.counterAccount, description: b.description,
    };
    const row = await withUser(pool, await user(req), async (c) => {
      await requireWritable(c, companyId);
      const id = (await c.query('select acc.register_fixed_asset($1, $2::jsonb, $3) id', [companyId, JSON.stringify(payload), key])).rows[0].id;
      return { id };
    });
    return reply.code(201).send(row);
  });

  app.post('/companies/:companyId/fixed-assets/:assetId/void', async (req) => {
    const { companyId, assetId } = FixedAssetParams.parse(req.params);
    const b = VoidWithReason.parse(req.body);
    const key = idemKey(req);
    return withUser(pool, await user(req), async (c) => {
      await requireWritable(c, companyId);
      await c.query('select acc.void_fixed_asset($1, $2, $3, $4, $5)', [companyId, assetId, b.date ?? null, b.reason, key]);
      return { ok: true };
    });
  });

  app.post('/companies/:companyId/fixed-assets/:assetId/dispose', async (req, reply) => {
    const { companyId, assetId } = FixedAssetParams.parse(req.params);
    const b = DisposeAsset.parse(req.body);
    const key = idemKey(req);
    const payload = {
      date: b.date, proceeds: b.proceeds, proceeds_account: b.proceedsAccount, party_code: b.partyCode, buyer_name: b.buyerName,
      buyer_tax_id: b.buyerTaxId, buyer_branch_no: b.buyerBranchNo, buyer_address: b.buyerAddress, description: b.description,
    };
    const row = await withUser(pool, await user(req), async (c) => {
      await requireWritable(c, companyId);
      const id = (await c.query('select acc.dispose_fixed_asset($1, $2, $3::jsonb, $4) id', [companyId, assetId, JSON.stringify(payload), key])).rows[0].id;
      const e = await c.query(`select d.entry_id as "entryId", e.doc_no as "docNo", d.gain_loss::text as "gainLoss",
                                        d.vat::text, d.final_depreciation::text as "finalDepreciation" from acc.asset_disposals d
                                 join acc.journal_entries e on e.company_id = d.company_id and e.id = d.entry_id where d.company_id = $1 and d.id = $2`, [companyId, id]);
      return { id, ...e.rows[0] };
    });
    return reply.code(201).send(row);
  });

  app.post('/companies/:companyId/asset-disposals/:disposalId/void', async (req) => {
    const { companyId, disposalId } = DisposalParams.parse(req.params);
    const b = VoidWithReason.parse(req.body);
    const key = idemKey(req);
    return withUser(pool, await user(req), async (c) => {
      await requireWritable(c, companyId);
      const id = (await c.query('select acc.void_asset_disposal($1, $2, $3, $4, $5) id', [companyId, disposalId, b.date ?? null, b.reason, key])).rows[0].id;
      return { entryId: id };
    });
  });

  // ลงค่าเสื่อมราคาประจำเดือน (AJ วันสิ้นเดือน)
  app.post('/companies/:companyId/depreciation', async (req, reply) => {
    const { companyId } = CompanyParams.parse(req.params);
    const b = DepreciationRun.parse(req.body);
    const key = idemKey(req);
    const row = await withUser(pool, await user(req), async (c) => {
      await requireWritable(c, companyId);
      const id = (await c.query('select acc.post_depreciation($1, $2, $3) id', [companyId, `${b.month}-01`, key])).rows[0].id;
      const e = await c.query(`select r.entry_id as "entryId", e.doc_no as "docNo" from acc.depreciation_runs r
                                 left join acc.journal_entries e on e.company_id = r.company_id and e.id = r.entry_id where r.company_id = $1 and r.id = $2`, [companyId, id]);
      return { id, ...e.rows[0] };
    });
    return reply.code(201).send(row);
  });

  app.post('/companies/:companyId/depreciation/:runId/void', async (req) => {
    const { companyId, runId } = DepreciationRunParams.parse(req.params);
    const b = VoidRun.parse(req.body ?? {});
    const key = idemKey(req);
    return withUser(pool, await user(req), async (c) => {
      await requireWritable(c, companyId);
      const id = (await c.query('select acc.void_depreciation_run($1, $2, $3, $4) id', [companyId, runId, b.date ?? null, key])).rows[0].id;
      return { entryId: id };
    });
  });

  // ตารางค่าเสื่อมรายเดือนของสินทรัพย์หนึ่งตัว (ที่ลงแล้ว)
  app.get('/companies/:companyId/fixed-assets/:assetId/lines', async (req) => {
    const { companyId, assetId } = FixedAssetParams.parse(req.params);
    return withUser(pool, await user(req), async (c) => {
      await requireReadable(c, companyId);
      return (await c.query(
        `select to_char(l.dep_month, 'YYYY-MM') as month, l.seq, l.amount::text, e.doc_no as "docNo", e.id as "entryId"
           from acc.depreciation_lines l join acc.depreciation_runs r on r.company_id = l.company_id and r.id = l.run_id
           left join acc.journal_entries e on e.company_id = r.company_id and e.id = r.entry_id
          where l.company_id = $1 and l.asset_id = $2 and r.voided_at is null order by l.seq`, [companyId, assetId])).rows;
    });
  });
}
