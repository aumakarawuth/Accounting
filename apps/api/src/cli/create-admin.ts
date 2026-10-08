// สร้างผู้ดูแลระบบคนแรกของโรงเรียน (ครั้งเดียวตอนติดตั้ง) ต้องรันด้วยบทบาท migrator/superuser
// ADMIN_DATABASE_URL=... pnpm --filter @accounting/api create-admin <อีเมล> <ชื่อ> [ชื่อโรงเรียน]
import pg from 'pg';
import { hashPassword, temporaryPassword } from '../passwords.js';

const [email, name, school = 'โรงเรียน'] = process.argv.slice(2);
if (!email || !name || !process.env.ADMIN_DATABASE_URL) {
  console.error('ใช้: ADMIN_DATABASE_URL=... create-admin <อีเมล> <ชื่อ> [ชื่อโรงเรียน]');
  process.exit(1);
}
const c = new pg.Client({ connectionString: process.env.ADMIN_DATABASE_URL });
await c.connect();
await c.query('begin');
const s = (await c.query('select id from acc.schools order by name limit 1')).rows[0]
  ?? (await c.query('insert into acc.schools (name) values ($1) returning id', [school])).rows[0];
const temp = temporaryPassword();
const u = (await c.query(
  `insert into acc.users (school_id, role, email, display_name) values ($1, 'admin', lower($2), $3) returning id`,
  [s.id, email, name])).rows[0];
await c.query('insert into acc.credentials (user_id, password_hash, must_change) values ($1, $2, true)', [u.id, await hashPassword(temp)]);
await c.query('commit');
await c.end();
console.log(`ผู้ดูแล ${name} <${email}> รหัสชั่วคราว ${temp} (ต้องเปลี่ยนเมื่อเข้าครั้งแรก)`);
