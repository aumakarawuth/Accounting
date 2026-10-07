// ตัวรันมิเกรชัน: อ่านไฟล์รูปแบบ dbmate (-- migrate:up / -- migrate:down)
// ใช้ตาราง schema_migrations เดียวกับ dbmate เพื่อสลับเครื่องมือได้
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function migrate(connectionString, { seed = false } = {}) {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query(
      'create table if not exists schema_migrations (version varchar primary key)',
    );
    const done = new Set(
      (await client.query('select version from schema_migrations')).rows.map((r) => r.version),
    );
    const dir = path.join(root, 'db/migrations');
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    for (const f of files) {
      const version = f.split('_')[0];
      if (done.has(version)) continue;
      const sql = await readFile(path.join(dir, f), 'utf8');
      const up = sql.split('-- migrate:down')[0].replace('-- migrate:up', '');
      await client.query('begin');
      try {
        await client.query(up);
        await client.query('insert into schema_migrations(version) values ($1)', [version]);
        await client.query('commit');
      } catch (e) {
        await client.query('rollback');
        throw new Error(`migration ${f}: ${e.message}`);
      }
    }
    if (seed) {
      const dirS = path.join(root, 'db/seed');
      for (const f of (await readdir(dirS)).filter((f) => f.endsWith('.sql')).sort()) {
        await client.query(await readFile(path.join(dirS, f), 'utf8'));
      }
    }
  } finally {
    await client.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('ต้องตั้ง DATABASE_URL (ใช้บทบาท migrator)');
  await migrate(url, { seed: process.argv.includes('--seed') });
  console.log('migrate เสร็จ');
}
