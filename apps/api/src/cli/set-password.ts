// ตั้งรหัสผ่านให้ผู้ใช้ (บูตครู/ผู้ดูแลคนแรก หรือข้อมูลตัวอย่าง) ต้องรันด้วยบทบาท migrator/superuser
// pnpm --filter @accounting/api set-password <user-id|student-code|email> [รหัสผ่าน]
// ไม่ใส่รหัส = สุ่มรหัสชั่วคราวและบังคับเปลี่ยนตอนเข้าครั้งแรก
import pg from 'pg';
import { hashPassword, temporaryPassword } from '../passwords.js';

const [who, given] = process.argv.slice(2);
if (!who || !process.env.ADMIN_DATABASE_URL) {
  console.error('ใช้: ADMIN_DATABASE_URL=... set-password <user-id|student-code|email> [รหัสผ่าน]');
  process.exit(1);
}
const client = new pg.Client({ connectionString: process.env.ADMIN_DATABASE_URL });
await client.connect();
const u = (await client.query(
  `select id, display_name from acc.users where id::text = $1 or student_code = $1 or lower(email) = lower($1)`, [who],
)).rows;
if (u.length !== 1) { console.error(`พบผู้ใช้ ${u.length} คน ต้องระบุให้ตรงคนเดียว`); process.exit(1); }
const pw = given ?? temporaryPassword();
await client.query(
  `insert into acc.credentials (user_id, password_hash, must_change) values ($1, $2, $3)
   on conflict (user_id) do update set password_hash = excluded.password_hash, must_change = excluded.must_change, password_changed_at = now()`,
  [u[0].id, await hashPassword(pw), given === undefined],
);
await client.end();
console.log(`${u[0].display_name}: ${given ? 'ตั้งรหัสแล้ว' : `รหัสชั่วคราว ${pw} (ต้องเปลี่ยนเมื่อเข้าครั้งแรก)`}`);
