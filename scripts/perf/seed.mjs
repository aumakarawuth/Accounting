// สร้างครู/ห้อง/นักเรียน + บริษัทที่มี N รายการ (ค่าเริ่มต้น 3000) สำหรับวัดความเร็ว: เครื่องนักพัฒนาเท่านั้น (docs/performance.md)
// BASE=http://localhost:3000 ADMIN_USER=... ADMIN_PASSWORD=... ADMIN_DATABASE_URL=postgres://... node scripts/perf/seed.mjs out.json
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import pg from 'pg';
const base = process.env.BASE ?? 'http://localhost:3000';
const origin = base;
function session() {
  const jar = new Map();
  return async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { origin, 'content-type': 'application/json', cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') }, body: body ? JSON.stringify(body) : undefined });
    for (const c of r.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar.set(kv.slice(0, i), kv.slice(i + 1)); }
    const t = await r.text(); if (r.status >= 300) throw new Error(`${method} ${path} ${r.status} ${t}`);
    return t ? JSON.parse(t) : {};
  };
}
const tag = randomUUID().slice(0, 6);
const admin = session();
await admin('POST', '/api/auth/login', { kind: 'staff', identifier: process.env.ADMIN_USER, password: process.env.ADMIN_PASSWORD });
const st = await admin('POST', '/api/admin/staff', { email: `perf-${tag}`, name: `ครูวัดความเร็ว ${tag}`, role: 'teacher' });
const room = await admin('POST', '/api/admin/classrooms', { name: `ห้องวัดความเร็ว ${tag}`, teacherId: st.id });
const t = session();
await t('POST', '/api/auth/login', { kind: 'staff', identifier: `perf-${tag}`, password: st.tempPassword });
const tpw = `ครูวัด-${randomUUID()}`;
await t('POST', '/api/auth/change-password', { newPassword: tpw });
const temp = `ชั่วคราว-${randomUUID().slice(0, 8)}`;
const rows = Array.from({ length: 40 }, (_, i) => ({ studentCode: `P${tag}${String(i).padStart(2, '0')}`, name: `นักเรียนวัด ${i}`, password: temp }));
await t('POST', `/api/classrooms/${room.id}/import`, { rows });
await t('POST', `/api/classrooms/${room.id}/companies`, { name: 'ร้านวัดความเร็ว', mode: 'practice' });
const s = session();
await s('POST', '/api/auth/login', { kind: 'student', identifier: rows[0].studentCode, password: temp });
const spw = `นักเรียนวัด-${randomUUID().slice(0, 8)}`;
await s('POST', '/api/auth/change-password', { newPassword: spw });
const [co] = await s('GET', '/api/me/companies');
const uid = (await s('GET', '/api/auth/me')).id;

const c = new pg.Client({ connectionString: process.env.ADMIN_DATABASE_URL });
await c.connect();
const accts = (await c.query("select code from acc.chart_of_accounts where company_id=$1 and code ~ '^(11|12|41|52|53)' order by code", [co.id])).rows.map((r) => r.code);
await c.query('begin');
await c.query('set local role app_rw');
await c.query("select set_config('app.user_id', $1, true)", [uid]);
const N = Number(process.env.N ?? 3000);
for (let i = 0; i < N; i++) {
  const d = new Date(Date.UTC(2026, Math.floor(i / (N / 12)), 1 + (i % 28)));
  const amt = (100 + (i * 37) % 9000).toFixed(2);
  const dr = accts[i % accts.length], cr = accts[(i * 7 + 3) % accts.length];
  const lines = [{ account_code: dr, debit: amt }, { account_code: cr === dr ? accts[(i + 1) % accts.length] : cr, credit: amt }];
  await c.query('select acc.post_journal($1,$2,$3,$4::jsonb,$5)', [co.id, d.toISOString().slice(0, 10), `รายการ ${i}`, JSON.stringify(lines), `perf-${tag}-${i}`]);
}
await c.query('commit');
await c.end();
writeFileSync(process.argv[2], JSON.stringify({ company: co.id, studentCode: rows[0].studentCode, studentPassword: spw, teacher: `perf-${tag}`, teacherPassword: tpw, room: room.id }));
console.log('ok', co.id, N);
