import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import type { AuthAdapter } from '../auth.js';
import { withUser } from '../db.js';
import { HttpError } from '../errors.js';
import { requireUser } from '../guard.js';
import type { RealtimeBus } from '../realtime.js';
import { ClassroomParams } from '../schemas-auth.js';
import { CompanyParams } from '../schemas.js';

const Presence = z.object({
  page: z.enum(['home', 'journal', 'ledger', 'trial-balance', 'statements', 'accounts', 'closing', 'menu', 'other']),
  draft: z.object({
    date: z.string().max(20).optional(),
    description: z.string().max(500).optional(),
    lines: z.array(z.object({
      account_code: z.string().max(20), debit: z.string().max(25), credit: z.string().max(25),
    }).strict()).max(200),
  }).strict().nullable().optional(),
}).strict();
const Channel = z.string().regex(/^(company|student):[0-9a-f-]{36}$/);
const SpectateParams = z.object({ spectateId: z.uuid() });
const MAX_STREAM_MS = 10 * 60_000; // ต่อใหม่ทุก 10 นาที เพื่อตรวจเซสชันซ้ำ

export function liveRoutes(app: FastifyInstance, deps: { pool: pg.Pool; auth: AuthAdapter; bus?: RealtimeBus }) {
  const { pool, auth, bus } = deps;

  // นักเรียนรายงานหน้าที่เปิดและร่าง (ทุกไม่กี่วินาทีระหว่างใช้งาน)
  app.post('/companies/:companyId/presence', async (req) => {
    const { companyId } = CompanyParams.parse(req.params);
    const body = Presence.parse(req.body);
    await withUser(pool, await requireUser(auth, req), (c) =>
      c.query('select app.presence_update($1, $2, $3::jsonb)', [companyId, body.page, body.draft ? JSON.stringify(body.draft) : null]));
    return { ok: true };
  });

  app.post('/companies/:companyId/presence/clear-draft', async (req) => {
    const { companyId } = CompanyParams.parse(req.params);
    await withUser(pool, await requireUser(auth, req), (c) => c.query('select app.presence_clear_draft($1)', [companyId]));
    return { ok: true };
  });

  // ข้อมูลดูสดของบริษัทเดียว (ครูดึงใหม่ทุกครั้งที่ได้ event; อ่านผ่าน RLS)
  app.get('/companies/:companyId/live', async (req) => {
    const { companyId } = CompanyParams.parse(req.params);
    return withUser(pool, await requireUser(auth, req), async (c) => {
      const co = (await c.query('select id, name, owner_id from acc.companies where id = $1', [companyId])).rows[0];
      if (!co) throw new HttpError(404, 'not_found', 'ไม่พบบริษัทนี้');
      const presence = (await c.query(
        `select page, draft, draft_debit::text as "draftDebit", draft_credit::text as "draftCredit",
                draft_lines as "draftLines", updated_at as "updatedAt"
           from acc.presence where company_id = $1`, [companyId])).rows[0] ?? null;
      const entries = (await c.query(
        `select e.id, e.doc_no as "docNo", e.entry_date::text as date, e.description, e.total_amount::text as total,
                e.reverses_entry_id is not null as reversal, e.posted_at as "postedAt"
           from acc.journal_entries e where e.company_id = $1 order by e.posted_at desc limit 10`, [companyId])).rows;
      return { company: { id: co.id, name: co.name }, presence, entries };
    });
  });

  app.get('/teacher/classrooms/:classroomId/live', async (req) => {
    const { classroomId } = ClassroomParams.parse(req.params);
    return withUser(pool, await requireUser(auth, req, ['teacher']), async (c) => (await c.query(
      `select student_id as "studentId", student_code as "studentCode", name, company_id as "companyId",
              company_name as "companyName", page, draft_debit::text as "draftDebit", draft_credit::text as "draftCredit",
              draft_lines as "draftLines", presence_at as "presenceAt", last_seen_at as "lastSeenAt",
              last_posted_at as "lastPostedAt", now() as "now"
         from acc.classroom_live($1)`, [classroomId])).rows);
  });

  app.post('/companies/:companyId/spectate', async (req, reply) => {
    const { companyId } = CompanyParams.parse(req.params);
    const id = await withUser(pool, await requireUser(auth, req, ['teacher']), async (c) =>
      (await c.query('select acc.spectate_start($1) id', [companyId])).rows[0].id);
    return reply.code(201).send({ id });
  });
  app.post('/spectate/:spectateId/ping', async (req) => {
    const { spectateId } = SpectateParams.parse(req.params);
    await withUser(pool, await requireUser(auth, req, ['teacher']), (c) => c.query('select acc.spectate_ping($1)', [spectateId]));
    return { ok: true };
  });
  app.post('/spectate/:spectateId/stop', async (req) => {
    const { spectateId } = SpectateParams.parse(req.params);
    await withUser(pool, await requireUser(auth, req, ['teacher']), (c) => c.query('select acc.spectate_stop($1)', [spectateId]));
    return { ok: true };
  });

  app.get('/me/watchers', async (req) =>
    withUser(pool, await requireUser(auth, req), async (c) =>
      (await c.query('select id, teacher_name as "teacherName", company_id as "companyId" from app.my_watchers()')).rows));

  // Server-Sent Events: ผู้ฟังได้แค่สัญญาณ ("มีอะไรเปลี่ยน") แล้วไปดึงข้อมูลจริงเองผ่าน RLS
  app.get('/realtime', async (req, reply) => {
    if (!bus) throw new HttpError(503, 'realtime_off', 'ยังไม่ได้เปิดระบบ realtime');
    const channel = Channel.parse((req.query as { channel?: string }).channel);
    const user = await requireUser(auth, req);
    const [kind, id] = channel.split(':') as ['company' | 'student', string];
    if (kind === 'student' && id !== user.id) throw new HttpError(403, 'forbidden', 'ฟังช่องของคนอื่นไม่ได้');
    if (kind === 'company') {
      const ok = await withUser(pool, user, async (c) => (await c.query('select app.can_read_company($1) ok', [id])).rows[0].ok);
      if (!ok) throw new HttpError(404, 'not_found', 'ไม่พบบริษัทนี้');
    }

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 3000\n: ok\n\n');
    const unsub = bus.subscribe(channel, (e) => res.write(`data: ${JSON.stringify(e)}\n\n`));
    const heartbeat = setInterval(() => res.write(': hb\n\n'), 25_000);
    const limit = setTimeout(() => res.end(), MAX_STREAM_MS);
    req.raw.on('close', () => { clearInterval(heartbeat); clearTimeout(limit); unsub(); });
  });
}
