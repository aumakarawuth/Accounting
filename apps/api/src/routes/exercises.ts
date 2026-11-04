import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { querySequence, withUser } from '../db.js';
import type { AuthAdapter, AuthUser } from '../auth.js';
import { requireReadable, requireUser } from '../guard.js';
import { HttpError } from '../errors.js';
import {
  AssignBody, AssignmentActionBody, AssignmentOptionsBody, AssignmentParams, CompanyParams, DemoBody, ExerciseSetBody, SetParams,
} from '../schemas.js';

// เฟส 4: ชุดโจทย์ มอบหมาย สอบ สาธิต — ชั้นบาง Zod → ฟังก์ชันใน DB (สิทธิ์และการซ่อนเฉลยตัดสินใน DB)
export function exerciseRoutes(app: FastifyInstance, pool: pg.Pool, auth: AuthAdapter) {
  const teacher = (req: FastifyRequest): Promise<AuthUser> => requireUser(auth, req, ['teacher']);
  const user = (req: FastifyRequest): Promise<AuthUser> => requireUser(auth, req);

  const payload = (b: ReturnType<typeof ExerciseSetBody.parse>) => ({
    title: b.title, company_name: b.companyName, description: b.description,
    items: b.items.map((i) => ({ date: i.date, narrative: i.narrative, points: i.points, lines: i.lines })),
  });

  app.get('/teacher/exercises', async (req) =>
    withUser(pool, await teacher(req), async (c) => {
      const [sets, assignments] = await querySequence([
        () => c.query(
          `select s.id, s.title, s.company_name as "companyName", s.version, s.updated_at as "updatedAt",
                  (select count(*)::int from acc.exercise_items i where i.set_id = s.id) as items,
                  (select coalesce(sum(points), 0)::text from acc.exercise_items i where i.set_id = s.id) as points,
                  (select count(*)::int from acc.assignments a where a.set_id = s.id) as assignments
             from acc.exercise_sets s order by s.updated_at desc`),
        () => c.query(
          `select a.id, a.mode, a.title, a.company_name as "companyName", r.name as classroom, a.created_at as "createdAt",
                  a.released_at as "releasedAt", a.closed_at as "closedAt", a.duration_minutes as "durationMinutes",
                  (select count(*)::int from acc.companies c where c.assignment_id = a.id) as companies,
                  (select c.id from acc.companies c where c.assignment_id = a.id and a.mode = 'demo' limit 1) as "demoCompanyId"
             from acc.assignments a left join acc.classrooms r on r.id = a.classroom_id
            order by a.created_at desc limit 200`),
      ] as const);
      return { sets: sets.rows, assignments: assignments.rows };
    }));

  // ผังบัญชีตั้งต้น: รหัสที่ใช้ในเฉลยได้ (บริษัทของนักเรียนเริ่มจากผังนี้)
  app.get('/teacher/coa-template', async (req) =>
    withUser(pool, await teacher(req), async (c) =>
      (await c.query(`select code, name, type, case when type in ('asset', 'expense') then 'debit' else 'credit' end as normal_side
                        from acc.coa_template order by code`)).rows));

  app.post('/teacher/exercises', async (req, reply) => {
    const b = ExerciseSetBody.parse(req.body);
    const out = await withUser(pool, await teacher(req), async (c) => {
      const id = (await c.query('select acc.save_exercise_set(null, null, $1::jsonb) id', [JSON.stringify(payload(b))])).rows[0].id;
      return { id, version: 1 };
    });
    return reply.code(201).send(out);
  });

  app.get('/teacher/exercises/:setId', async (req) => {
    const { setId } = SetParams.parse(req.params);
    return withUser(pool, await teacher(req), async (c) => {
      const s = (await c.query(
        `select id, title, company_name as "companyName", description, version, updated_at as "updatedAt"
           from acc.exercise_sets where id = $1`, [setId])).rows[0];
      if (!s) throw new HttpError(404, 'not_found', 'ไม่พบชุดโจทย์นี้');
      const [items, assignments, rooms] = await querySequence([
        () => c.query(
          `select i.item_no as no, i.entry_date::text as date, i.narrative, i.points::text as points,
                  (select json_agg(json_build_object('account_code', l.account_code,
                            'debit', case when l.debit > 0 then l.debit::text end,
                            'credit', case when l.credit > 0 then l.credit::text end) order by l.line_no)
                     from acc.exercise_answer_lines l where l.set_id = i.set_id and l.item_no = i.item_no) as lines
             from acc.exercise_items i where i.set_id = $1 order by i.item_no`, [setId]),
        () => c.query(
          `select a.id, a.mode, r.name as classroom, a.company_name as "companyName", a.created_at as "createdAt", a.closed_at as "closedAt",
                  (select c.id from acc.companies c where c.assignment_id = a.id and a.mode = 'demo' limit 1) as "demoCompanyId"
             from acc.assignments a left join acc.classrooms r on r.id = a.classroom_id where a.set_id = $1 order by a.created_at desc`, [setId]),
        () => c.query(`select id, name from acc.classrooms where teacher_id = app.current_user_id() order by name`),
      ] as const);
      return { ...s, items: items.rows, assignments: assignments.rows, classrooms: rooms.rows };
    });
  });

  app.put('/teacher/exercises/:setId', async (req) => {
    const { setId } = SetParams.parse(req.params);
    const b = ExerciseSetBody.parse(req.body);
    const version = b.version;
    if (!version) throw new HttpError(400, 'invalid', 'version: ต้องระบุ version ที่แก้');
    return withUser(pool, await teacher(req), async (c) => {
      await c.query('select acc.save_exercise_set($1, $2, $3::jsonb)', [setId, version, JSON.stringify(payload(b))]);
      return { id: setId, version: version + 1 };
    });
  });

  app.post('/teacher/exercises/:setId/delete', async (req) => {
    const { setId } = SetParams.parse(req.params);
    await withUser(pool, await teacher(req), (c) => c.query('select acc.delete_exercise_set($1)', [setId]));
    return { ok: true };
  });

  // มอบหมายให้ห้อง (หรือสร้างบริษัทสาธิตของครู) แล้วเปิดบริษัทให้ทันที
  app.post('/teacher/exercises/:setId/assign', async (req, reply) => {
    const { setId } = SetParams.parse(req.params);
    const b = AssignBody.parse(req.body);
    const out = await withUser(pool, await teacher(req), async (c) => {
      const id = (await c.query('select acc.create_assignment($1, $2, $3::jsonb) id', [setId, b.mode === 'demo' ? null : b.classroomId, JSON.stringify({
        mode: b.mode, company_name: b.companyName, feedback: b.feedback, reveal: b.reveal, check_date: b.checkDate,
        opens_at: b.opensAt ?? null, closes_at: b.closesAt ?? null, duration_minutes: b.durationMinutes ?? null,
      })])).rows[0].id as string;
      return assignmentCreated(c, id);
    });
    return reply.code(201).send(out);
  });

  // บริษัทสาธิตเปล่า (ไม่มีโจทย์)
  app.post('/teacher/demo', async (req, reply) => {
    const b = DemoBody.parse(req.body);
    const out = await withUser(pool, await teacher(req), async (c) => {
      const id = (await c.query(`select acc.create_assignment(null, null, $1::jsonb) id`, [JSON.stringify({ mode: 'demo', company_name: b.companyName })])).rows[0].id as string;
      return assignmentCreated(c, id);
    });
    return reply.code(201).send(out);
  });

  /** กัน IDOR: งานของครูคนอื่น = 404 เหมือนไม่มีอยู่ */
  async function requireAssignment(c: pg.PoolClient, id: string) {
    const r = await c.query('select app.can_manage_assignment($1) ok', [id]);
    if (!r.rows[0]?.ok) throw new HttpError(404, 'not_found', 'ไม่พบงานนี้');
  }

  async function assignmentCreated(c: pg.PoolClient, id: string) {
    const r = await c.query(
      `select count(*)::int as companies, (array_agg(id))[1] as "companyId" from acc.companies where assignment_id = $1`, [id]);
    return { assignmentId: id, companies: r.rows[0].companies as number, companyId: r.rows[0].companyId as string | null };
  }

  app.get('/teacher/assignments/:assignmentId', async (req) => {
    const { assignmentId } = AssignmentParams.parse(req.params);
    return withUser(pool, await teacher(req), async (c) => {
      await requireAssignment(c, assignmentId);
      return (await c.query('select acc.assignment_overview($1) v', [assignmentId])).rows[0].v;
    });
  });

  app.post('/teacher/assignments/:assignmentId/options', async (req) => {
    const { assignmentId } = AssignmentParams.parse(req.params);
    const b = AssignmentOptionsBody.parse(req.body);
    await withUser(pool, await teacher(req), async (c) => {
      await requireAssignment(c, assignmentId);
      await c.query('select acc.set_assignment_options($1, $2::jsonb)', [assignmentId,
        JSON.stringify({ feedback: b.feedback, reveal: b.reveal, check_date: b.checkDate })]);
    });
    return { ok: true };
  });

  app.post('/teacher/assignments/:assignmentId/actions', async (req) => {
    const { assignmentId } = AssignmentParams.parse(req.params);
    const b = AssignmentActionBody.parse(req.body);
    return withUser(pool, await teacher(req), async (c) => {
      await requireAssignment(c, assignmentId);
      if (b.action === 'open-companies') {
        const r = (await c.query('select created, existing from acc.open_assignment_companies($1)', [assignmentId])).rows[0];
        return { created: r.created as number, existing: r.existing as number };
      }
      if (b.action === 'extend') {
        if (!b.minutes) throw new HttpError(400, 'invalid', 'minutes: ต้องระบุจำนวนนาที');
        const n = (await c.query('select acc.extend_exam($1, $2, $3) n', [assignmentId, b.companyId ?? null, b.minutes])).rows[0].n as number;
        return { extended: n };
      }
      await c.query('select acc.assignment_action($1, $2)', [assignmentId, b.action]);
      return { ok: true };
    });
  });

  // โจทย์และผลตรวจของบริษัท (นักเรียนเจ้าของ / ครู) ตัดตามเวลาและการตั้งค่าใน DB
  app.get('/companies/:companyId/assignment', async (req) => {
    const { companyId } = CompanyParams.parse(req.params);
    return withUser(pool, await user(req), async (c) => {
      await requireReadable(c, companyId);
      await c.query('select app.log_company_view($1)', [companyId]);
      const v = (await c.query('select acc.assignment_view($1) v', [companyId])).rows[0].v;
      if (!v) throw new HttpError(404, 'not_found', 'บริษัทนี้ไม่ได้ผูกกับโจทย์');
      return v;
    });
  });

  app.post('/companies/:companyId/assignment/start', async (req) => {
    const { companyId } = CompanyParams.parse(req.params);
    const u = await user(req);
    return withUser(pool, u, async (c) => {
      await requireReadable(c, companyId);
      const deadline = (await c.query('select acc.start_exam($1, $2) d', [companyId, u.tokenHash ?? null])).rows[0].d;
      return { deadline };
    });
  });
}
