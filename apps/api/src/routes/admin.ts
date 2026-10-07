import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { AuthAdapter } from '../auth.js';
import { withUser } from '../db.js';
import { requireUser } from '../guard.js';
import { hashPassword, temporaryPassword } from '../passwords.js';
import { AssignTeacher, AuditQuery, ClassroomParams, CreateClassroom, CreateStaff, SetActive, UserParams } from '../schemas-auth.js';

// ผู้ดูแลระบบ: ครู/ห้อง และ audit log ของโรงเรียนตัวเอง (DB ตรวจบทบาทและโรงเรียนซ้ำ)
export function adminRoutes(app: FastifyInstance, deps: { pool: pg.Pool; auth: AuthAdapter }) {
  const { pool, auth } = deps;
  const admin = (req: Parameters<typeof requireUser>[1]) => requireUser(auth, req, ['admin']);

  app.get('/admin/staff', async (req) =>
    withUser(pool, await admin(req), async (c) => (await c.query(
      `select u.id, u.email, u.display_name as name, u.role, u.active,
              (select count(*)::int from acc.classrooms r where r.teacher_id = u.id) as classrooms
         from acc.users u
        where u.role <> 'student' and u.school_id = app.current_school_id()
        order by u.active desc, u.role, u.display_name`)).rows));

  app.post('/admin/staff', async (req, reply) => {
    const body = CreateStaff.parse(req.body);
    const temp = temporaryPassword();
    const h = await hashPassword(temp);
    const id = await withUser(pool, await admin(req), async (c) =>
      (await c.query('select acc.admin_create_staff($1, $2, $3, $4) id', [body.email, body.name, body.role, h])).rows[0].id);
    return reply.code(201).send({ id, tempPassword: temp });
  });

  app.post('/admin/users/:userId/reset-password', async (req) => {
    const { userId } = UserParams.parse(req.params);
    const temp = temporaryPassword();
    const h = await hashPassword(temp);
    await withUser(pool, await admin(req), (c) => c.query('select acc.admin_reset_password($1, $2)', [userId, h]));
    return { tempPassword: temp };
  });

  app.post('/admin/users/:userId/active', async (req) => {
    const { userId } = UserParams.parse(req.params);
    const { active } = SetActive.parse(req.body);
    await withUser(pool, await admin(req), (c) => c.query('select acc.admin_set_active($1, $2)', [userId, active]));
    return { ok: true };
  });

  app.get('/admin/classrooms', async (req) =>
    withUser(pool, await admin(req), async (c) => (await c.query(
      `select r.id, r.name, r.teacher_id as "teacherId", t.display_name as "teacherName",
              (select count(*)::int from acc.enrollments e where e.classroom_id = r.id) as students
         from acc.classrooms r join acc.users t on t.id = r.teacher_id
        order by r.name`)).rows));

  app.post('/admin/classrooms', async (req, reply) => {
    const body = CreateClassroom.parse(req.body);
    const id = await withUser(pool, await admin(req), async (c) =>
      (await c.query('select acc.admin_create_classroom($1, $2) id', [body.name, body.teacherId])).rows[0].id);
    return reply.code(201).send({ id });
  });

  app.post('/admin/classrooms/:classroomId/teacher', async (req) => {
    const { classroomId } = ClassroomParams.parse(req.params);
    const { teacherId } = AssignTeacher.parse(req.body);
    await withUser(pool, await admin(req), (c) => c.query('select acc.admin_assign_teacher($1, $2)', [classroomId, teacherId]));
    return { ok: true };
  });

  // audit log ทีละ 50 แถว ย้อนหลังด้วย ?before=<id>; บอกเฉพาะชื่อฟิลด์ที่เปลี่ยน ไม่ส่งค่าทั้งแถว
  app.get('/admin/audit', async (req) => {
    const { before } = AuditQuery.parse(req.query);
    return withUser(pool, await admin(req), async (c) => (await c.query(
      `select a.id, a.at, a.table_name as "table", a.op, a.row_pk as "rowPk", a.client,
              u.display_name as "userName", u.student_code as "userCode",
              case when a.op = 'UPDATE' then
                (select coalesce(array_agg(k order by k), '{}') from jsonb_object_keys(a.new_row) k
                  where k not in ('version') and a.new_row->k is distinct from a.old_row->k)
              end as changed,
              case when a.op not in ('INSERT','UPDATE','DELETE') then a.new_row end as detail,
              -- ทำกับใคร/อะไร (อ่านผ่าน RLS ของผู้ดูแล: เห็นเฉพาะในโรงเรียนตัวเอง)
              case
                when a.op = 'IMPORT_STUDENTS' or a.table_name = 'classrooms' then
                  (select r.name from acc.classrooms r where r.id::text = a.row_pk)
                when a.table_name in ('users', 'credentials') then
                  (select concat_ws(' ', t.student_code, t.display_name) from acc.users t where t.id::text = a.row_pk)
              end as target
         from acc.audit_log a left join acc.users u on u.id = a.user_id
        where ($1::bigint is null or a.id < $1)
        order by a.id desc limit 50`, [before ?? null])).rows);
  });
}
