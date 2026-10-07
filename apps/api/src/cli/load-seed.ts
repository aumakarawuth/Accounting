// เตรียมข้อมูลทดสอบโหลด: โรงเรียนเดียว ครู 13 คน นักเรียน 500 คน (ห้องละ ~38) ทุกคนมีบริษัทจำลอง
// ADMIN_DATABASE_URL=... tsx src/cli/load-seed.ts <จำนวนนักเรียน> <ไฟล์ผลลัพธ์.json>
// ใช้กับฐานทดสอบเท่านั้น (รหัสผ่านเหมือนกันทุกคน)
import { writeFileSync } from 'node:fs';
import pg from 'pg';
import { hashPassword } from '../passwords.js';

const [nArg = '500', out = 'load-users.json'] = process.argv.slice(2);
const N = Number(nArg);
const PER_ROOM = 38;
const PASSWORD = 'ทดสอบโหลดห้องเรียน';
const c = new pg.Client({ connectionString: process.env.ADMIN_DATABASE_URL });
await c.connect();
const hash = await hashPassword(PASSWORD); // แฮชครั้งเดียวใช้ทุกคน (เร็ว; ฐานทดสอบเท่านั้น)

await c.query('begin');
const school = (await c.query(`insert into acc.schools (name) values ('โรงเรียนทดสอบโหลด') returning id`)).rows[0].id;
const rooms: { id: string; teacher: string; email: string }[] = [];
const students: { code: string; room: number }[] = [];
for (let r = 0; r * PER_ROOM < N; r++) {
  const email = `load-t${r + 1}@load.test`;
  const t = (await c.query(
    `insert into acc.users (school_id, role, email, display_name) values ($1, 'teacher', $2, $3) returning id`,
    [school, email, `ครูทดสอบ ${r + 1}`])).rows[0].id;
  await c.query('insert into acc.credentials (user_id, password_hash, must_change) values ($1, $2, false)', [t, hash]);
  const room = (await c.query(
    `insert into acc.classrooms (school_id, teacher_id, name) values ($1, $2, $3) returning id`,
    [school, t, `ห้องทดสอบ ${r + 1}`])).rows[0].id;
  rooms.push({ id: room, teacher: t, email });
}
for (let i = 0; i < N; i++) {
  const code = `L${String(i + 1).padStart(4, '0')}`;
  const room = Math.floor(i / PER_ROOM);
  const u = (await c.query(
    `insert into acc.users (school_id, role, student_code, display_name) values ($1, 'student', $2, $3) returning id`,
    [school, code, `นักเรียน ${code}`])).rows[0].id;
  await c.query('insert into acc.credentials (user_id, password_hash, must_change) values ($1, $2, false)', [u, hash]);
  await c.query('insert into acc.enrollments values ($1, $2)', [rooms[room]!.id, u]);
  students.push({ code, room });
}
// เปิดบริษัทผ่านฟังก์ชันเดียวกับที่ครูกด (ในนามครูแต่ละห้อง)
for (const r of rooms) {
  await c.query(`select set_config('app.user_id', $1, true)`, [r.teacher]);
  await c.query(`select * from acc.open_classroom_companies($1, 'บริษัททดสอบโหลด จำกัด', 'practice')`, [r.id]);
}
await c.query('commit');
await c.end();
writeFileSync(out, JSON.stringify({ password: PASSWORD, students, teachers: rooms.map((r) => ({ email: r.email, classroomId: r.id })) }));
console.log(`นักเรียน ${N} คน · ครู ${rooms.length} คน → ${out}`);
