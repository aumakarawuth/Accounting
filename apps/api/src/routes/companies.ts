import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { withUser } from '../db.js';
import type { AuthAdapter, AuthUser } from '../auth.js';
import { requireUser } from '../guard.js';
import { HttpError } from '../errors.js';
import {
  AccountParams, CompanyParams, EditAccount, EntryParams, IdempotencyKey, LedgerQuery, MonthQuery, NewAccount, PeriodParams,
  PostJournal, Reverse, StatementsQuery, SubmissionAction, TrialBalanceQuery,
} from '../schemas.js';

// ชั้นบาง: ตรวจรูปแบบด้วย Zod แล้วเรียกฟังก์ชันใน Postgres; สิทธิ์ตัดสินที่ RLS/ฟังก์ชัน
export function companyRoutes(app: FastifyInstance, pool: pg.Pool, auth: AuthAdapter) {
  const user = (req: FastifyRequest): Promise<AuthUser> => requireUser(auth, req);

  // กัน IDOR: บริษัทที่อ่านไม่ได้ตอบ 404 เหมือนไม่มีอยู่
  async function requireReadable(c: pg.PoolClient, companyId: string) {
    const r = await c.query('select app.can_read_company($1) ok', [companyId]);
    if (!r.rows[0]?.ok) throw new HttpError(404, 'not_found', 'ไม่พบบริษัทนี้');
  }

  // อ่านได้แต่เขียนไม่ได้ (ครู/ผู้ช่วยสอน) = 403 บอกตรง ๆ
  async function requireWritable(c: pg.PoolClient, companyId: string) {
    await requireReadable(c, companyId);
    const r = await c.query('select app.can_write_company($1) ok', [companyId]);
    if (!r.rows[0]?.ok) throw new HttpError(403, '42501', 'บัญชีนี้ไม่มีสิทธิ์ทำรายการในบริษัทนี้');
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
        `select c.id, c.name, c.version, c.mode, app.can_write_company(c.id) as can_write,
                coalesce(s.status, case c.mode when 'submit' then 'draft' end) as status,
                app.company_locked(c.id) as locked
           from acc.companies c left join acc.submissions s on s.company_id = c.id where c.id = $1`,
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

  // งบการเงิน: กำไรขาดทุน (เดือนนี้หรือต้นปีถึงเดือนนี้) + ฐานะการเงิน ณ สิ้นเดือน
  // ยอดหันตามด้านปกติ (บัญชีปรับลด เช่น ค่าเสื่อมราคาสะสม/ถอนใช้ส่วนตัว/ส่วนลด จึงติดลบ = หักออก)
  // ยังไม่มีปิดบัญชีสิ้นปี: กำไรสะสมตั้งแต่เริ่มบริษัทแสดงเป็น "ยังไม่ได้ปิดบัญชี" ในส่วนทุน
  app.get('/companies/:companyId/statements', async (req) => {
    const { companyId } = CompanyParams.parse(req.params);
    const { month, scope } = StatementsQuery.parse(req.query);
    const to = `${month}-01`;
    const from = scope === 'month' ? to : `${month.slice(0, 4)}-01-01`;
    return withUser(pool, await user(req), async (c) => {
      await requireReadable(c, companyId);
      const r = await c.query(
        `with b as (
           select a.code, a.name, a.type, case a.normal_side when 'debit' then 1 else -1 end as s,
                  coalesce(sum(x.debit_total - x.credit_total) filter (where p.start_date between $2::date and $3::date), 0) as period_net,
                  coalesce(sum(x.debit_total - x.credit_total) filter (where p.start_date <= $3::date), 0) as cum_net
             from acc.chart_of_accounts a
             left join acc.account_balances x on x.company_id = a.company_id and x.account_id = a.id
             left join acc.periods p on p.company_id = x.company_id and p.id = x.period_id
            where a.company_id = $1
            group by a.code, a.name, a.type, a.normal_side
         ), lines as (
           select type, code, name, (period_net * s) as period_amt, (cum_net * s) as balance from b
         ), t as (
           select coalesce(sum(period_amt) filter (where type = 'revenue'), 0) as rev,
                  coalesce(sum(period_amt) filter (where type = 'expense'), 0) as exp,
                  coalesce(sum(balance) filter (where type = 'revenue'), 0) - coalesce(sum(balance) filter (where type = 'expense'), 0) as unclosed,
                  coalesce(sum(balance) filter (where type = 'asset'), 0) as assets,
                  coalesce(sum(balance) filter (where type = 'liability'), 0) as liabilities,
                  coalesce(sum(balance) filter (where type = 'equity'), 0) as equity
             from lines
         )
         select json_build_object(
           'revenue', (select coalesce(json_agg(json_build_object('code', code, 'name', name, 'amount', period_amt::numeric(18,2)::text) order by code), '[]') from lines where type = 'revenue' and period_amt <> 0),
           'expense', (select coalesce(json_agg(json_build_object('code', code, 'name', name, 'amount', period_amt::numeric(18,2)::text) order by code), '[]') from lines where type = 'expense' and period_amt <> 0),
           'assets', (select coalesce(json_agg(json_build_object('code', code, 'name', name, 'amount', balance::numeric(18,2)::text) order by code), '[]') from lines where type = 'asset' and balance <> 0),
           'liabilities', (select coalesce(json_agg(json_build_object('code', code, 'name', name, 'amount', balance::numeric(18,2)::text) order by code), '[]') from lines where type = 'liability' and balance <> 0),
           'equity', (select coalesce(json_agg(json_build_object('code', code, 'name', name, 'amount', balance::numeric(18,2)::text) order by code), '[]') from lines where type = 'equity' and balance <> 0),
           'totalRevenue', rev::numeric(18,2)::text,
           'totalExpense', exp::numeric(18,2)::text,
           'netIncome', (rev - exp)::numeric(18,2)::text,
           'unclosedProfit', unclosed::numeric(18,2)::text,
           'totalAssets', assets::numeric(18,2)::text,
           'totalLiabilities', liabilities::numeric(18,2)::text,
           'totalEquity', (equity + unclosed)::numeric(18,2)::text,
           'totalLiabilitiesEquity', (liabilities + equity + unclosed)::numeric(18,2)::text,
           'balanced', assets = liabilities + equity + unclosed
         ) as st from t`,
        [companyId, from, to],
      );
      return { month, scope, from: from.slice(0, 7), ...r.rows[0].st };
    });
  });

  // สถานะงานและประวัติ (เจ้าของและครูประจำห้อง); ครูเปิดดูถูกบันทึกทุกครั้ง
  app.get('/companies/:companyId/submission', async (req) => {
    const { companyId } = CompanyParams.parse(req.params);
    return withUser(pool, await user(req), async (c) => {
      await requireReadable(c, companyId);
      await c.query('select app.log_company_view($1)', [companyId]);
      const co = (await c.query('select mode from acc.companies where id = $1', [companyId])).rows[0];
      const s = (await c.query(
        `select status, round, score::text, max_score::text as "maxScore" from acc.submissions where company_id = $1`, [companyId])).rows[0];
      const events = (await c.query(
        `select e.id, e.at, e.action, e.from_status as "from", e.to_status as "to", e.round, e.note, e.score::text,
                u.display_name as "actorName", e.actor = c.owner_id as "byOwner"
           from acc.submission_events e
           join acc.companies c on c.id = e.company_id
           left join acc.users u on u.id = e.actor   -- RLS: นักเรียนไม่เห็นชื่อครู (ได้ null) หน้าจอแสดงบทบาทแทน
          where e.company_id = $1 order by e.id`, [companyId])).rows;
      return { mode: co.mode, status: s?.status ?? (co.mode === 'submit' ? 'draft' : null), round: s?.round ?? 0,
               score: s?.score ?? null, maxScore: s?.maxScore ?? '10.00', events };
    });
  });

  app.post('/companies/:companyId/submission', async (req) => {
    const { companyId } = CompanyParams.parse(req.params);
    const body = SubmissionAction.parse(req.body);
    const status = await withUser(pool, await user(req), async (c) =>
      (await c.query('select acc.submission_action($1, $2, $3, $4, $5::numeric) s',
        [companyId, body.action, body.expected, body.note ?? null, body.score ?? null])).rows[0].s);
    return { status };
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
  // รายการเดียว: หัว + บรรทัด + ความเชื่อมโยงกับการกลับรายการ (ใช้หน้าดูรายการ/ปุ่มกลับรายการ)
  app.get('/companies/:companyId/journal/:entryId', async (req) => {
    const { companyId, entryId } = EntryParams.parse(req.params);
    return withUser(pool, await user(req), async (c) => {
      await requireReadable(c, companyId);
      const e = (await c.query(
        `select e.id, e.doc_no as "docNo", e.entry_date::text as date, e.description, e.total_amount::text as total,
                e.posted_at as "postedAt", p.closed as "periodClosed",
                case when r.id is null then null else json_build_object('id', r.id, 'docNo', r.doc_no) end as reverses,
                (select json_build_object('id', x.id, 'docNo', x.doc_no) from acc.journal_entries x
                  where x.company_id = e.company_id and x.reverses_entry_id = e.id) as "reversedBy",
                (select coalesce(json_agg(json_build_object(
                          'lineNo', l.line_no, 'code', a.code, 'name', a.name,
                          'debit', l.debit::text, 'credit', l.credit::text, 'memo', l.memo) order by l.line_no), '[]')
                   from acc.journal_lines l join acc.chart_of_accounts a on a.company_id = l.company_id and a.id = l.account_id
                  where l.company_id = e.company_id and l.entry_id = e.id) as lines
           from acc.journal_entries e
           join acc.periods p on p.company_id = e.company_id and p.id = e.period_id
           left join acc.journal_entries r on r.company_id = e.company_id and r.id = e.reverses_entry_id
          where e.company_id = $1 and e.id = $2`,
        [companyId, entryId])).rows[0];
      if (!e) throw new HttpError(404, 'not_found', 'ไม่พบรายการนี้');
      return e;
    });
  });

  // ผังบัญชีเต็ม (รวมบัญชีที่ปิดใช้) พร้อมบอกว่ามีรายการแล้วหรือยัง: ใช้หน้าจัดการผังบัญชี
  app.get('/companies/:companyId/chart', async (req) => {
    const { companyId } = CompanyParams.parse(req.params);
    return withUser(pool, await user(req), async (c) => {
      await requireReadable(c, companyId);
      const r = await c.query(
        `select a.code, a.name, a.type, a.normal_side as "normalSide", a.active, a.version,
                exists (select 1 from acc.journal_lines l where l.company_id = a.company_id and l.account_id = a.id) as used
           from acc.chart_of_accounts a where a.company_id = $1 order by a.code`,
        [companyId],
      );
      return r.rows;
    });
  });

  app.post('/companies/:companyId/accounts', async (req, reply) => {
    const { companyId } = CompanyParams.parse(req.params);
    const body = NewAccount.parse(req.body);
    const row = await withUser(pool, await user(req), async (c) => {
      await requireWritable(c, companyId);
      try {
        return (await c.query(
          `insert into acc.chart_of_accounts (company_id, code, name, type) values ($1, $2, $3, $4)
           returning code, name, type, normal_side as "normalSide", active, version`,
          [companyId, body.code, body.name, body.type])).rows[0];
      } catch (e) {
        if ((e as { code?: string }).code === '23505') throw new HttpError(409, 'duplicate', `มีรหัสบัญชี ${body.code} อยู่แล้ว`);
        throw e;
      }
    });
    return reply.code(201).send({ ...row, used: false });
  });

  // แก้ชื่อ/ปิดใช้/เปิดใช้: ต้องส่ง version ที่อ่านมา (แก้ทับกันจากสองหน้าจอได้ 409)
  app.patch('/companies/:companyId/accounts/:code', async (req) => {
    const { companyId, code } = AccountParams.parse(req.params);
    const body = EditAccount.parse(req.body);
    return withUser(pool, await user(req), async (c) => {
      await requireWritable(c, companyId);
      const r = await c.query(
        `update acc.chart_of_accounts a set name = coalesce($4, a.name), active = coalesce($5, a.active), version = a.version + 1
          where a.company_id = $1 and a.code = $2 and a.version = $3
          returning a.code, a.name, a.type, a.normal_side as "normalSide", a.active, a.version,
                    exists (select 1 from acc.journal_lines l where l.company_id = a.company_id and l.account_id = a.id) as used`,
        [companyId, code, body.version, body.name ?? null, body.active ?? null],
      );
      if (r.rows[0]) return r.rows[0];
      const exists = (await c.query('select 1 from acc.chart_of_accounts where company_id = $1 and code = $2', [companyId, code])).rowCount;
      if (!exists) throw new HttpError(404, 'not_found', `ไม่พบรหัสบัญชี ${code}`);
      throw new HttpError(409, '40001', 'มีคนแก้บัญชีนี้ไปก่อนแล้ว โหลดใหม่เพื่อดูค่าล่าสุดก่อนแก้');
    });
  });

  // งวดบัญชีรายเดือน (มีงวดเมื่อมีรายการในเดือนนั้น) + บอกว่าผู้เรียกปิด/เปิดงวดไหนได้
  app.get('/companies/:companyId/periods', async (req) => {
    const { companyId } = CompanyParams.parse(req.params);
    return withUser(pool, await user(req), async (c) => {
      await requireReadable(c, companyId);
      const r = await c.query(
        `select to_char(p.start_date, 'YYYY-MM') as month, p.closed, p.closed_at as "closedAt",
                (select count(*)::int from acc.journal_entries e where e.company_id = p.company_id and e.period_id = p.id) as entries
           from acc.periods p where p.company_id = $1 order by p.start_date`,
        [companyId],
      );
      const who = (await c.query(
        `select app.can_write_company($1) as "canClose",
                (select owner_id <> app.current_user_id() from acc.companies where id = $1) as "canReopen",
                app.company_locked($1) as locked`, [companyId])).rows[0];
      return { ...who, periods: r.rows };
    });
  });

  app.post('/companies/:companyId/periods/:month/close', async (req) => {
    const { companyId, month } = PeriodParams.parse(req.params);
    await withUser(pool, await user(req), (c) => c.query('select acc.close_period($1, $2::date)', [companyId, `${month}-01`]));
    return { month, closed: true };
  });

  app.post('/companies/:companyId/periods/:month/reopen', async (req) => {
    const { companyId, month } = PeriodParams.parse(req.params);
    await withUser(pool, await user(req), (c) => c.query('select acc.reopen_period($1, $2::date)', [companyId, `${month}-01`]));
    return { month, closed: false };
  });
}
