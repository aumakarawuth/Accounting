import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { testUrl } from './global-setup';

export const pool = new pg.Pool({ connectionString: testUrl(), max: 16 });
export const admin = pool; // superuser: ใช้เตรียมข้อมูลและพยายามโจมตีจากชั้นล่าง

/** รันเป็นผู้ใช้ผ่านบทบาท app_rw แบบเดียวกับที่ API ทำ (ตั้ง app.user_id ต่อทรานแซกชัน) */
export async function asUser<T>(userId: string | null, fn: (c: pg.PoolClient) => Promise<T>, role = 'app_rw'): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query(`set local role ${role}`);
    await c.query(`select set_config('app.user_id', $1, true)`, [userId ?? '']);
    const r = await fn(c);
    await c.query('commit');
    return r;
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

export async function newSchool() {
  const id = randomUUID();
  await pool.query('insert into acc.schools(id,name) values ($1,$2)', [id, 'โรงเรียนทดสอบ']);
  return id;
}

export async function newUser(school: string, role: 'student' | 'teacher' | 'admin') {
  const id = randomUUID();
  const tag = id.slice(0, 8);
  await pool.query(
    'insert into acc.users(id,school_id,role,student_code,email,display_name) values ($1,$2,$3,$4,$5,$6)',
    [id, school, role, role === 'student' ? `S${tag}` : null, role === 'student' ? null : `${tag}@t.test`, `${role} ${tag}`],
  );
  return id;
}

export async function newClassroom(school: string, teacher: string, students: string[]) {
  const id = randomUUID();
  await pool.query('insert into acc.classrooms(id,school_id,teacher_id,name) values ($1,$2,$3,$4)', [id, school, teacher, 'ห้อง ๑']);
  for (const s of students) await pool.query('insert into acc.enrollments values ($1,$2)', [id, s]);
  return id;
}

export async function newCompany(owner: string, classroom: string | null = null) {
  return asUser(owner, async (c) => (await c.query('select acc.create_company($1,$2) as id', ['บริษัท ก. จำกัด', classroom])).rows[0].id as string);
}

export type Line = { account_code: string; debit?: string; credit?: string; memo?: string };

export function post(c: pg.PoolClient, company: string, date: string, lines: Line[], key = randomUUID(), prefix = 'JV') {
  return c.query('select acc.post_journal($1,$2,$3,$4::jsonb,$5,$6) as id', [company, date, 'ทดสอบ', JSON.stringify(lines), key, prefix]);
}

export const money = (cents: number) => (cents / 100).toFixed(2);
export const sqlstate = (e: any) => e?.code as string | undefined;

/** หลักตรวจสอบเลขผู้เสียภาษี 13 หลัก คิดแยกจาก SQL เพื่อเทียบกัน */
function taxCheckDigit(first12: string) {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(first12[i]) * (13 - i);
  return (11 - (sum % 11)) % 10;
}
export function taxId(seed: number) {
  const first12 = String(1_000_000_000_00 + (seed % 900_000_000_00)).padStart(12, '0');
  return first12 + taxCheckDigit(first12);
}
