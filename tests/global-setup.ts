import pg from 'pg';
import { migrate } from '../scripts/migrate.mjs';

export const ADMIN_URL = process.env.TEST_ADMIN_URL ?? 'postgres://postgres@localhost/postgres?host=/tmp';
export const TEST_DB = 'accounting_test';

export default async function setup() {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`drop database if exists ${TEST_DB} with (force)`);
  await admin.query(`create database ${TEST_DB}`);
  await migrateAndRoles(admin);
  await admin.end();
}

// บทบาท login ที่ API ใช้ (สมาชิกของ app_rw) เหมือนตอนใช้งานจริง ห้ามใช้ superuser
async function migrateAndRoles(admin: pg.Client) {
  await migrate(testUrl(), { seed: true });
  await admin.query(`do $$ begin
    if not exists (select from pg_roles where rolname = 'api_test') then
      create role api_test login password 'api_test' in role app_rw;
    end if; end $$`);
}

export function apiUrl() {
  const u = new URL(testUrl());
  u.username = 'api_test';
  u.password = 'api_test';
  return u.toString();
}

export function testUrl() {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${TEST_DB}`;
  return u.toString();
}
