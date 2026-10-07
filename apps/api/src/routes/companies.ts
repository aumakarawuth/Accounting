import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { withUser } from '../db.js';
import type { AuthAdapter, AuthUser } from '../auth.js';
import { requireUser } from '../guard.js';
import { HttpError } from '../errors.js';
import { CompanyParams, EntryParams, IdempotencyKey, LedgerQuery, MonthQuery, PostJournal, Reverse, TrialBalanceQuery } from '../schemas.js';

// ชั้นบาง: ตรวจรูปแบบด้วย Zod แล้วเรียกฟังก์ชันใน Postgres; สิทธิ์ตัดสินที่ RLS/ฟังก์ชัน
export function companyRoutes(app: FastifyInstance, pool: pg.Pool, auth: AuthAdapter) {
  const user = (req: FastifyRequest): Promise<AuthUser> => requireUser(auth, req);

  // กัน IDOR: บริษัทที่อ่านไม่ได้ตอบ 404 เหมือนไม่มีอยู่
  async function requireReadable(c: pg.PoolClient, companyId: string) {
    const r = await c.query('select app.can_read_company($1) ok', [companyId]);
    if (!r.rows[0]?.ok) throw new HttpError(404, 'not_found', 'ไม่พบบริษัทนี้');
  }

  async function docNo(c: pg.PoolClient, companyId: string, id: string) {
    const r = await c.query('select id, doc_no from acc.journal_entries where company_id = $1 and id = $2', [companyId, id]);
    return r.rows[0] as { id: string; doc_no: string };
  }

  function idemKey(req: FastifyRequest) {
    return IdempotencyKey.parse(req.headers['idempotency-key']);
  }

  // บริษัทที่ตัวเองเป็นเจ้าของ (หน้าแรกหลังล็อกอิน)
  app.get('/me/companies', async (req) => {
    const u = await user(req);
    return withUser(pool, u, async (c) =>
      (await c.query(
        `select c.id, c.name, r.name as classroom from acc.companies c
           left join acc.classrooms r on r.id = c.classroom_id
          where c.owner_id = $1 order by c.created_at desc`, [u.id])).rows);
  });

  app.get('/companies/:companyId', async (req) => {
    const { companyId } = CompanyParams.parse(req.params);
    return withUser(pool, await user(req), async (c) => {
      await requireReadable(c, companyId);
      const r = await c.query(
        `select id, name, version, app.can_write_company(id) as can_write from acc.companies where id = $1`,
        [companyId],
      );
      return r.rows[0];
    });
  });

  app.get('/companies/:companyId/accounts', async (req) => {
    const { companyId } = CompanyParams.parse(req.params);
    return withUser(pool, await user(req), async (c) => {
      await requireReadable(c, companyId);
      const r = await c.query(
        `select code, name, type, normal_side from acc.chart_of_accounts
          where company_id = $1 and active order by code`,
        [companyId],
      );
      return r.rows;
    });
  });

  app.get('/companies/:companyId/journal', async (req) => {
    const { companyId } = CompanyParams.parse(req.params);
    const { month } = MonthQuery.parse(req.query);
    return withUser(pool, await user(req), async (c) => {
      await requireReadable(c, companyId);
      const r = await c.query(
        `select e.id, e.doc_no, e.entry_date::text as date, e.description, e.total_amount::text as total,
                r.doc_no as reverses_doc_no
           from acc.journal_entries e
           left join acc.journal_entries r on r.company_id = e.company_id and r.id = e.reverses_entry_id
          where e.company_id = $1
            and ($2::text is null or to_char(e.entry_date, 'YYYY-MM') = $2)
          order by e.entry_date desc, e.doc_no desc
          limit 200`,
        [companyId, month ?? null],
      );
      return r.rows;
    });
  });

  // งบทดลอง: ยอดสะสมตั้งแต่เริ่มบริษัทถึงสิ้นเดือนที่เลือก (จาก account_balances)
  // ยอดสุทธิของแต่ละบัญชีลงช่องเดบิตหรือเครดิตช่องเดียว; ยอดรวมคำนวณใน SQL (ไม่บวกเงินใน JS)
  app.get('/companies/:companyId/trial-balance', async (req) => {
    const { companyId } = CompanyParams.parse(req.params);
    const { month, all } = TrialBalanceQuery.parse(req.query);
    return withUser(pool, await user(req), async (c) => {
      await requireReadable(c, companyId);
      const r = await c.query(
        `with net as (
           select a.code, a.name, a.type, a.normal_side,
                  coalesce(sum(b.debit_total - b.credit_total) filter (where p.start_date <= $2::date), 0) as net,
                  count(b.*) filter (where p.start_date <= $2::date) as touched
             from acc.chart_of_accounts a
             left join acc.account_balances b on b.company_id = a.company_id and b.account_id = a.id
             left join acc.periods p on p.company_id = b.company_id and p.id = b.period_id
            where a.company_id = $1
            group by a.code, a.name, a.type, a.normal_side
         )
         select code, name, type, normal_side as "normalSide",
                greatest(net, 0)::numeric(18,2)::text as debit,
                greatest(-net, 0)::numeric(18,2)::text as credit,
                sum(greatest(net, 0)) over ()::numeric(18,2)::text as "totalDebit",
                sum(greatest(-net, 0)) over ()::numeric(18,2)::text as "totalCredit"
           from net
          where $3 or net <> 0
          order by code`,
        [companyId, `${month}-01`, all === '1'],
      );
      const first = r.rows[0];
      return {
        month,
        rows: r.rows.map(({ totalDebit: _d, totalCredit: _c, ...row }) => row),
        totalDebit: first?.totalDebit ?? '0.00',
        totalCredit: first?.totalCredit ?? '0.00',
      };
    });
  });

  // บัญชีที่มีความเคลื่อนไหวหรือมียอดในเดือนนี้ (หน้าเลือกบัญชีของแยกประเภท)
  // ยอดหันตามด้านปกติของบัญชี: บวก = ด้านปกติ, ติดลบ = กลับด้าน
  app.get('/companies/:companyId/ledger-accounts', async (req) => {
    const { companyId } = CompanyParams.parse(req.params);
    const { month } = MonthQuery.parse(req.query);
    if (!month) throw new HttpError(400, 'invalid', 'ต้องระบุเดือน');
    return withUser(pool, await user(req), async (c) => {
      await requireReadable(c, companyId);
      const r = await c.query(
        `with s as (
           select a.code, a.name, a.normal_side,
                  case a.normal_side when 'debit' then 1 else -1 end as sign,
                  coalesce(sum(b.debit_total - b.credit_total) filter (where p.start_date < $2::date), 0) as open_net,
                  coalesce(sum(b.debit_total) filter (where p.start_date = $2::date), 0) as dr,
                  coalesce(sum(b.credit_total) filter (where p.start_date = $2::date), 0) as cr
             from acc.chart_of_accounts a
             join acc.account_balances b on b.company_id = a.company_id and b.account_id = a.id
             join acc.periods p on p.company_id = b.company_id and p.id = b.period_id
            where a.company_id = $1 and p.start_date <= $2::date
            group by a.code, a.name, a.normal_side
         )
         select code, name, normal_side as "normalSide",
                (open_net * sign)::numeric(18,2)::text as opening,
                dr::numeric(18,2)::text as debit, cr::numeric(18,2)::text as credit,
                ((open_net + dr - cr) * sign)::numeric(18,2)::text as closing
           from s where open_net <> 0 or dr <> 0 or cr <> 0
          order by code`,
        [companyId, `${month}-01`],
      );
      return r.rows;
    });
  });

  // แยกประเภทบัญชีเดียว ในเดือนที่เลือก: ยอดยกมา → รายการ (ยอดคงเหลือต่อเนื่อง) → ยอดยกไป
  app.get('/companies/:companyId/ledger', async (req) => {
    const { companyId } = CompanyParams.parse(req.params);
    const { month, account } = LedgerQuery.parse(req.query);
    return withUser(pool, await user(req), async (c) => {
      await requireReadable(c, companyId);
      const a = (await c.query(
        `select id, code, name, type, normal_side from acc.chart_of_accounts where company_id = $1 and code = $2`,
        [companyId, account])).rows[0];
      if (!a) throw new HttpError(404, 'not_found', `ไม่พบรหัสบัญชี ${account}`);
      const from = `${month}-01`;
      const r = await c.query(
        `with sign as (select case $3::text when 'debit' then 1 else -1 end as s),
         opening as (
           select coalesce(sum(l.debit - l.credit), 0) as net
             from acc.journal_lines l join acc.journal_entries e on e.company_id = l.company_id and e.id = l.entry_id
            where l.company_id = $1 and l.account_id = $2 and e.entry_date < $4::date
         ), lines as (
           select e.entry_date, e.posted_at, l.line_no, e.doc_no, e.description, l.memo, l.debit, l.credit,
                  e.reverses_entry_id is not null as reversal
             from acc.journal_lines l join acc.journal_entries e on e.company_id = l.company_id and e.id = l.entry_id
            where l.company_id = $1 and l.account_id = $2
              and e.entry_date >= $4::date and e.entry_date < ($4::date + interval '1 month')
         )
         select (select (net * s)::numeric(18,2)::text from opening, sign) as opening,
                coalesce(json_agg(json_build_object(
                  'date', entry_date::text, 'docNo', doc_no, 'description', description, 'memo', memo,
                  'debit', debit::text, 'credit', credit::text, 'reversal', reversal,
                  'balance', (((select net from opening) + running) * (select s from sign))::numeric(18,2)::text)
                  order by entry_date, posted_at, line_no), '[]') as lines,
                (select coalesce(sum(debit), 0)::numeric(18,2)::text from lines) as "totalDebit",
                (select coalesce(sum(credit), 0)::numeric(18,2)::text from lines) as "totalCredit",
                (((select net from opening) + coalesce((select sum(debit - credit) from lines), 0)) * (select s from sign))::numeric(18,2)::text as closing
           from (select *, sum(debit - credit) over (order by entry_date, posted_at, line_no) as running from lines) x`,
        [companyId, a.id, a.normal_side, from],
      );
      return {
        month,
        account: { code: a.code, name: a.name, type: a.type, normalSide: a.normal_side },
        ...r.rows[0],
      };
    });
  });

  app.post('/companies/:companyId/journal', async (req, reply) => {
    const { companyId } = CompanyParams.parse(req.params);
    const body = PostJournal.parse(req.body);
    const key = idemKey(req);
    const out = await withUser(pool, await user(req), async (c) => {
      // เรียกฟังก์ชันลงบัญชีเป็นคำสั่งเดี่ยว (ห้ามวางใน WHERE: อาจถูกเรียกซ้ำต่อแถว)
      const posted = await c.query('select acc.post_journal($1, $2, $3, $4::jsonb, $5) as id', [
        companyId, body.date, body.description, JSON.stringify(body.lines), key,
      ]);
      return docNo(c, companyId, posted.rows[0].id);
    });
    return reply.code(201).send({ id: out.id, docNo: out.doc_no });
  });

  app.post('/companies/:companyId/journal/:entryId/reverse', async (req, reply) => {
    const { companyId, entryId } = EntryParams.parse(req.params);
    const body = Reverse.parse(req.body);
    const key = idemKey(req);
    const out = await withUser(pool, await user(req), async (c) => {
      const posted = await c.query('select acc.reverse_journal($1, $2, $3, $4, $5) as id', [
        companyId, entryId, body.date, key, body.description ?? null,
      ]);
      return docNo(c, companyId, posted.rows[0].id);
    });
    return reply.code(201).send({ id: out.id, docNo: out.doc_no });
  });
}
