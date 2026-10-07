import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { AuthAdapter } from '../auth.js';
import { withUser } from '../db.js';
import { requireUser } from '../guard.js';
import { hashPassword, temporaryPassword } from '../passwords.js';
import { StudentParams } from '../schemas-auth.js';

// ครู: ห้องเรียน, รีเซ็ตรหัส, เตะอุปกรณ์, การแจ้งเตือนบัญชีถูกล็อก (สิทธิ์ตรวจใน DB อีกชั้น)
export function teacherRoutes(app: FastifyInstance, deps: { pool: pg.Pool; auth: AuthAdapter }) {
  const { pool, auth } = deps;
  const teacher = (req: Parameters<typeof requireUser>[1]) => requireUser(auth, req, ['teacher']);

  app.get('/teacher/classrooms', async (req) =>
    withUser(pool, await teacher(req), async (c) => {
      const r = await c.query(
        `select r.id, r.name,
                coalesce(json_agg(json_build_object('id', u.id, 'studentCode', u.student_code, 'name', u.display_name)
                         order by u.student_code) filter (where u.id is not null), '[]') as students
           from acc.classrooms r
           left join acc.enrollments e on e.classroom_id = r.id
           left join acc.users u on u.id = e.user_id
          where r.teacher_id = app.current_user_id()
          group by r.id, r.name order by r.name`,
      );
      return r.rows;
    }));

  app.get('/teacher/alerts', async (req) =>
    withUser(pool, await teacher(req), async (c) => {
      const r = await c.query(
        `select a.id, a.kind, a.at, u.student_code as "studentCode", u.display_name as name
           from acc.teacher_alerts a join acc.users u on u.id = a.student_id
          where a.at > now() - interval '1 day'
          order by a.at desc limit 50`,
      );
      return r.rows;
    }));

  app.post('/teacher/students/:studentId/reset-password', async (req) => {
    const { studentId } = StudentParams.parse(req.params);
    const temp = temporaryPassword();
    const h = await hashPassword(temp);
    await withUser(pool, await teacher(req), (c) => c.query('select acc.reset_student_password($1, $2)', [studentId, h]));
    // แสดงครั้งเดียว ไม่เก็บรหัสชั่วคราวไว้ที่ไหน
    return { tempPassword: temp };
  });

  app.post('/teacher/students/:studentId/revoke-sessions', async (req) => {
    const { studentId } = StudentParams.parse(req.params);
    const n = await withUser(pool, await teacher(req), async (c) =>
      (await c.query('select acc.revoke_student_sessions($1) n', [studentId])).rows[0].n as number);
    return { revoked: n };
  });
}
