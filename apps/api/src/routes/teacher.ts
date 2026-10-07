import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { AuthAdapter } from '../auth.js';
import { withUser } from '../db.js';
import { requireUser } from '../guard.js';
import { hashPassword, temporaryPassword } from '../passwords.js';
import { ClassroomParams, ImportStudents, StudentParams } from '../schemas-auth.js';

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

  // นำเข้ารายชื่อ: ออกรหัสชั่วคราวเฉพาะนักเรียนใหม่ (แฮชนอกทรานแซกชัน ไม่ถือ connection ระหว่าง Argon2)
  app.post('/classrooms/:classroomId/import', async (req) => {
    const { classroomId } = ClassroomParams.parse(req.params);
    const { rows } = ImportStudents.parse(req.body);
    const user = await requireUser(auth, req, ['teacher', 'admin']);
    const codes = rows.map((r) => r.studentCode);
    const existing = new Set(await withUser(pool, user, async (c) =>
      (await c.query('select acc.existing_student_codes($1, $2) code', [classroomId, codes])).rows.map((r) => r.code as string)));

    const temps = new Map<string, string>();
    const payload = await Promise.all(rows.map(async (r) => {
      if (existing.has(r.studentCode)) return { code: r.studentCode, name: r.name, hash: null };
      const temp = temporaryPassword();
      temps.set(r.studentCode, temp);
      return { code: r.studentCode, name: r.name, hash: await hashPassword(temp) };
    }));

    const out = await withUser(pool, user, async (c) =>
      (await c.query('select code, status from acc.import_students($1, $2::jsonb)', [classroomId, JSON.stringify(payload)])).rows);
    const names = new Map(rows.map((r) => [r.studentCode, r.name]));
    return {
      results: out.map((r: { code: string; status: string }) => ({
        studentCode: r.code,
        name: names.get(r.code),
        status: r.status,
        // แสดงครั้งเดียวเพื่อพิมพ์ใบรหัสผ่าน ไม่เก็บไว้ที่ไหน
        ...(r.status === 'created' ? { tempPassword: temps.get(r.code) } : {}),
      })),
    };
  });

  app.post('/teacher/students/:studentId/revoke-sessions', async (req) => {
    const { studentId } = StudentParams.parse(req.params);
    const n = await withUser(pool, await teacher(req), async (c) =>
      (await c.query('select acc.revoke_student_sessions($1) n', [studentId])).rows[0].n as number);
    return { revoked: n };
  });
}
