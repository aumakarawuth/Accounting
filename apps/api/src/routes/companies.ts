import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { withUser } from '../db.js';
import type { AuthAdapter, AuthUser } from '../auth.js';
import { requireReadable, requireUser, requireWritable } from '../guard.js';
import { HttpError } from '../errors.js';
import { ledger, ledgerAccounts, statements, trialBalance } from '../reports.js';
import {
  AccountParams, CommentParams, CompanyParams, EditAccount, EntryParams, IdempotencyKey, LedgerQuery, MonthQuery, NewAccount, NewComment, PeriodParams,
  PostJournal, Reverse, StatementsQuery, SubmissionAction, TrialBalanceQuery,
} from '../schemas.js';

// ชั้นบาง: ตรวจรูปแบบด้วย Zod แล้วเรียกฟังก์ชันใน Postgres; สิทธิ์ตัดสินที่ RLS/ฟังก์ชัน
export function companyRoutes(app: FastifyInstance, pool: pg.Pool, auth: AuthAdapter) {
  const user = (req: FastifyRequest): Promise<AuthUser> => requireUser(auth, req);

  async function docNo(c: pg.PoolClient, companyId: string, id: string) {
    const r = await c.query('select id, doc_no from acc.journal_entries where company_id = $1 and id = $2', [companyId, id]);
    return r.rows[0] as { id: string; doc_no: string };
  }

  // รายการที่ลงจากสมุดรายวันเอง (JV/AJ) เท่านั้นที่แก้/กลับรายการจากสมุดได้
  // รายการจากเอกสาร/ทะเบียน (IV RE CN PI PV CQ FA FD VC WT IA IM CG และ AJ ของค่าเสื่อม) ต้องยกเลิกที่ตัวเอกสาร
  // ไม่อย่างนั้นยอดคุม (ลูกหนี้ เจ้าหนี้ เช็ค ค่าเสื่อมสะสม ภาษี สต็อก) ไม่ตรงทะเบียน (docs/full-system-test.md)
  async function assertManual(c: pg.PoolClient, companyId: string, entryId: string) {
    const e = (await c.query(
      `select e.doc_prefix, e.doc_no, exists (select 1 from acc.depreciation_runs r where r.company_id = e.company_id and r.entry_id = e.id) as dep
         from acc.journal_entries e where e.company_id = $1 and e.id = $2`, [companyId, entryId])).rows[0];
    if (!e) throw new HttpError(404, 'not_found', 'ไม่พบรายการนี้');
    if (e.doc_prefix === 'RV') return e; // กลับรายการของการกลับรายการ: ให้ DB ตอบ ACC12
    if ((e.doc_prefix !== 'JV' && e.doc_prefix !== 'AJ') || e.dep) {
      throw new HttpError(422, 'ACC15', `รายการ ${e.doc_no} มาจากเอกสารหรือทะเบียน แก้หรือกลับรายการจากสมุดรายวันไม่ได้ ให้ยกเลิกที่ตัวเอกสาร`);
    }
    return e as { doc_prefix: string; doc_no: string };
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
                app.company_locked(c.id) as locked, app.company_assignment(c.id) as assignment
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
                r.doc_no as reverses_doc_no,
                (select count(*)::int from acc.comments m where m.company_id = e.company_id and m.entry_id = e.id) as comments
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

  // งบทดลอง แยกประเภท งบการเงิน: SQL อยู่ที่ reports.ts (ใช้ร่วมกับไฟล์ส่งออก PDF/Excel)
  app.get('/companies/:companyId/trial-balance', async (req) => {
    const { companyId } = CompanyParams.parse(req.params);
    const { month, all } = TrialBalanceQuery.parse(req.query);
    return withUser(pool, await user(req), async (c) => {
      await requireReadable(c, companyId);
      return trialBalance(c, companyId, month, all === '1');
    });
  });

  app.get('/companies/:companyId/ledger-accounts', async (req) => {
    const { companyId } = CompanyParams.parse(req.params);
    const { month } = MonthQuery.parse(req.query);
    if (!month) throw new HttpError(400, 'invalid', 'ต้องระบุเดือน');
    return withUser(pool, await user(req), async (c) => {
      await requireReadable(c, companyId);
      return ledgerAccounts(c, companyId, month);
    });
  });

  app.get('/companies/:companyId/ledger', async (req) => {
    const { companyId } = CompanyParams.parse(req.params);
    const { month, account } = LedgerQuery.parse(req.query);
    return withUser(pool, await user(req), async (c) => {
      await requireReadable(c, companyId);
      return ledger(c, companyId, month, account);
    });
  });

  app.get('/companies/:companyId/statements', async (req) => {
    const { companyId } = CompanyParams.parse(req.params);
    const { month, scope } = StatementsQuery.parse(req.query);
    return withUser(pool, await user(req), async (c) => {
      await requireReadable(c, companyId);
      return statements(c, companyId, month, scope);
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
      const posted = await c.query('select acc.post_journal($1, $2, $3, $4::jsonb, $5, $6) as id', [
        companyId, body.date, body.description, JSON.stringify(body.lines), key, body.adjusting ? 'AJ' : 'JV',
      ]);
      return docNo(c, companyId, posted.rows[0].id);
    });
    return reply.code(201).send({ id: out.id, docNo: out.doc_no });
  });

  // แก้ไขรายการ = กลับรายการเดิม + ผ่านรายการใหม่ ในธุรกรรมเดียว (ร่องรอยครบ เลขที่ไม่ข้าม)
  // เฉพาะสมุดรายวันทั่วไป/รายการปรับปรุง เอกสารขาย/ซื้อ/ภาษีต้องยกเลิกที่ตัวเอกสาร
  app.post('/companies/:companyId/journal/:entryId/replace', async (req, reply) => {
    const { companyId, entryId } = EntryParams.parse(req.params);
    const body = PostJournal.parse(req.body);
    const key = idemKey(req);
    const out = await withUser(pool, await user(req), async (c) => {
      const old = await assertManual(c, companyId, entryId);
      if (old.doc_prefix === 'RV') throw new HttpError(409, 'ACC12', `รายการ ${old.doc_no} เป็นรายการกลับรายการ แก้ไขไม่ได้`);
      await c.query('select acc.reverse_journal($1, $2, $3, $4, $5)', [companyId, entryId, body.date, `${key}:rv`, `แก้ไข ${old.doc_no}`]);
      const posted = await c.query('select acc.post_journal($1, $2, $3, $4::jsonb, $5, $6) as id', [
        companyId, body.date, body.description, JSON.stringify(body.lines), key, old.doc_prefix,
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
      await assertManual(c, companyId, entryId); // JV/AJ ที่กลับแล้วส่งซ้ำ (เน็ตหลุด) ยังผ่านด่านนี้ ได้ผลเดิมจาก DB
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
                (e.doc_prefix in ('JV', 'AJ') and not exists (select 1 from acc.depreciation_runs r where r.company_id = e.company_id and r.entry_id = e.id)) as manual,
                case when r.id is null then null else json_build_object('id', r.id, 'docNo', r.doc_no) end as reverses,
                (select json_build_object('id', x.id, 'docNo', x.doc_no) from acc.journal_entries x
                  where x.company_id = e.company_id and x.reverses_entry_id = e.id) as "reversedBy",
                (select coalesce(json_agg(json_build_object(
                          'lineNo', l.line_no, 'code', a.code, 'name', a.name,
                          'debit', l.debit::text, 'credit', l.credit::text, 'memo', l.memo) order by l.line_no), '[]')
                   from acc.journal_lines l join acc.chart_of_accounts a on a.company_id = l.company_id and a.id = l.account_id
                  where l.company_id = e.company_id and l.entry_id = e.id) as lines,
                -- ชื่อผู้เขียน: RLS ของ users ไม่ให้นักเรียนเห็นชื่อครู (ได้ null) หน้าจอแสดงคำว่า "ครู" แทน
                (select coalesce(json_agg(json_build_object(
                          'id', m.id, 'lineNo', m.line_no, 'body', m.body, 'at', m.created_at,
                          'authorName', u.display_name, 'mine', m.author_id = app.current_user_id()) order by m.created_at), '[]')
                   from acc.comments m left join acc.users u on u.id = m.author_id
                  where m.company_id = e.company_id and m.entry_id = e.id) as comments
           from acc.journal_entries e
           join acc.periods p on p.company_id = e.company_id and p.id = e.period_id
           left join acc.journal_entries r on r.company_id = e.company_id and r.id = e.reverses_entry_id
          where e.company_id = $1 and e.id = $2`,
        [companyId, entryId])).rows[0];
      if (!e) throw new HttpError(404, 'not_found', 'ไม่พบรายการนี้');
      await c.query('select app.log_company_view($1)', [companyId]); // ครูเปิดดู = บันทึก
      return e;
    });
  });

  // คอมเมนต์ปากกาแดง: ครูประจำห้องเขียนที่รายการหรือบรรทัด (สิทธิ์ตรวจในฟังก์ชัน DB) เขียนได้แม้งานถูกล็อกระหว่างตรวจ
  app.post('/companies/:companyId/journal/:entryId/comments', async (req, reply) => {
    const { companyId, entryId } = EntryParams.parse(req.params);
    const body = NewComment.parse(req.body);
    const id = await withUser(pool, await user(req), async (c) => {
      await requireReadable(c, companyId);
      return (await c.query('select acc.add_comment($1, $2, $3, $4) id', [companyId, entryId, body.lineNo, body.body])).rows[0].id as string;
    });
    return reply.code(201).send({ id });
  });

  app.delete('/companies/:companyId/comments/:commentId', async (req) => {
    const { companyId, commentId } = CommentParams.parse(req.params);
    await withUser(pool, await user(req), async (c) => {
      await requireReadable(c, companyId);
      await c.query('select acc.delete_comment($1)', [commentId]);
    });
    return { deleted: true };
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
