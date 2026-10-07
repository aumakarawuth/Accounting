import pg from 'pg';
import { migrate } from '../scripts/migrate.mjs';

export const ADMIN_URL = process.env.TEST_ADMIN_URL ?? 'postgres://postgres@localhost/postgres?host=/tmp';
export const TEST_DB = 'accounting_test';

export default async function setup() {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`drop database if exists ${TEST_DB} with (force)`);
  await admin.query(`create database ${TEST_DB}`);
  await admin.end();
  await migrate(testUrl(), { seed: true });
}

export function testUrl() {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${TEST_DB}`;
  return u.toString();
}
