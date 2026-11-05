// ตั้งค่าฐานข้อมูลทุกครั้งที่ deploy (service migrate ใน infra/docker-compose.yml) ทำซ้ำได้ไม่มีผลข้างเคียง
// 1) migration ที่ยังไม่ได้รัน + ผังบัญชีตั้งต้น  2) login role ของแอป (app_web ∈ app_rw) ตั้งรหัสจาก APP_DB_PASSWORD
// 3) monitoring (ชั้น infra ไม่ใช่ schema ของแอป): pg_stat_statements ใน schema monitoring + role monitor ∈ pg_monitor (ถ้าตั้ง MONITOR_DB_PASSWORD)
// ต้องรันด้วย superuser (ADMIN_DATABASE_URL) รหัสไม่ถูกพิมพ์ออก log
import pg from 'pg';
import { migrate } from './migrate.mjs';

const admin = process.env.ADMIN_DATABASE_URL;
const password = process.env.APP_DB_PASSWORD;
const monitorPassword = process.env.MONITOR_DB_PASSWORD;
if (!admin) throw new Error('ต้องตั้ง ADMIN_DATABASE_URL');
// PgBouncer อ่านรหัสจาก userlist แบบ "ชื่อ" "รหัส": ห้ามมี " และต้องยาวพอ (openssl rand -hex 32)
if (!password || password.length < 24 || /["\\\s]/.test(password)) throw new Error('APP_DB_PASSWORD ต้องยาว ≥ 24 ตัว ไม่มีช่องว่าง/อัญประกาศ');

await migrate(admin, { seed: true });

const c = new pg.Client({ connectionString: admin });
await c.connect();
try {
  await c.query(`do $$ begin
    if not exists (select from pg_roles where rolname = 'app_web') then create role app_web login in role app_rw; end if;
  end $$`);
  // ALTER ROLE รับพารามิเตอร์ไม่ได้: ประกอบด้วย format(%L) ใน DB (กัน injection) Postgres เก็บเป็น SCRAM
  const { rows } = await c.query(`select format('alter role app_web with login password %L', $1::text) as sql`, [password]);
  await c.query(rows[0].sql);
  // monitoring: อ่านได้แค่สถิติ (pg_monitor) ไม่เห็นข้อมูลบัญชี (ไม่มีสิทธิ์ schema acc/app)
  await c.query(`create schema if not exists monitoring;
    create extension if not exists pg_stat_statements schema monitoring;
    grant usage on schema monitoring to pg_monitor`);
  if (monitorPassword) {
    if (monitorPassword.length < 24 || /["\\\s]/.test(monitorPassword)) throw new Error('MONITOR_DB_PASSWORD ต้องยาว ≥ 24 ตัว ไม่มีช่องว่าง/อัญประกาศ');
    await c.query(`do $$ begin
      if not exists (select from pg_roles where rolname = 'monitor') then create role monitor login in role pg_monitor; end if;
    end $$`);
    const m = await c.query(`select format('alter role monitor with login password %L', $1::text) as sql`, [monitorPassword]);
    await c.query(m.rows[0].sql);
    await c.query(`alter role monitor set search_path = monitoring, pg_catalog`);
  }
  const v = await c.query('select max(version) as v, count(*)::int as n from schema_migrations');
  console.log(`ฐานข้อมูลพร้อม: migration ${v.rows[0].n} ไฟล์ ล่าสุด ${v.rows[0].v}`);
} finally {
  await c.end();
}
