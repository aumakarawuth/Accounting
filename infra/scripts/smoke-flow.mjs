#!/usr/bin/env node
// ส่วนของ infra/scripts/smoke.sh: ใช้ระบบจริงผ่าน Caddy (HTTPS) ด้วยบัญชีที่สร้างตอนทดสอบเท่านั้น
//   node smoke-flow.mjs <base> <ca.crt> <admin> <รหัสชั่วคราว> <state.json>   ผู้ดูแล → ครู → ห้อง → นักเรียน → บริษัท → ลงรายการ → PDF/Excel → SSE
//   node smoke-flow.mjs <base> <ca.crt> --after-backup <state.json>             ลงรายการเพิ่ม 1 รายการหลัง backup (ใช้ตรวจการเล่น WAL)
// fetch ของ Node อ่าน NODE_EXTRA_CA_CERTS ตอนเริ่มเท่านั้น: สคริปต์รันตัวเองใหม่พร้อม CA ของ Caddy
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const [base, ca, ...rest] = process.argv.slice(2);
if (process.env.NODE_EXTRA_CA_CERTS !== ca) {
  // รันตัวเองใหม่พร้อม CA ของ Caddy
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, NODE_EXTRA_CA_CERTS: ca } });
  process.exit(r.status ?? 1);
}
const origin = new URL(base).origin;
const fail = (msg) => { console.error(`ไม่ผ่าน: ${msg}`); process.exit(1); };

function session() {
  const jar = new Map();
  async function req(method, path, body, headers = {}) {
    const res = await fetch(`${origin}${path}`, {
      method, redirect: 'manual',
      headers: { origin, cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';'); const i = kv.indexOf('=');
      jar.set(kv.slice(0, i), kv.slice(i + 1));
    }
    return res;
  }
  const json = async (method, path, body, expect = [200, 201], headers) => {
    const r = await req(method, path, body, headers);
    const t = await r.text();
    if (!expect.includes(r.status)) fail(`${method} ${path} → ${r.status} ${t.slice(0, 200)}`);
    return t ? JSON.parse(t) : {};
  };
  return { req, json, jar };
}

async function loginFirst(kind, identifier, temp, next) {
  const s = session();
  await s.json('POST', '/api/auth/login', { kind, identifier, password: temp });
  if (![...s.jar.keys()].includes('__Host-sid')) fail('cookie ไม่ใช่ __Host-sid (COOKIE_SECURE)');
  await s.json('POST', '/api/auth/change-password', { newPassword: next });
  return s;
}

async function post(s, companyId, doc, amount) {
  return s.json('POST', `/api/companies/${companyId}/journal`, {
    date: '2026-10-05', description: doc,
    lines: [{ account_code: '1110', debit: amount }, { account_code: '3110', credit: amount }],
  }, [200, 201], { 'idempotency-key': randomUUID() });
}

if (rest[0] === '--after-backup') {
  const state = JSON.parse(readFileSync(rest[1], 'utf8'));
  const s = session();
  await s.json('POST', '/api/auth/login', { kind: 'student', identifier: state.studentCode, password: state.studentPassword });
  const e = await post(s, state.companyId, 'หลัง backup', '777.00');
  state.afterBackupDocNo = e.docNo ?? e.doc_no;
  if (!state.afterBackupDocNo) fail(`ไม่ได้เลขที่เอกสาร ${JSON.stringify(e)}`);
  writeFileSync(rest[1], JSON.stringify(state));
  console.log(`ลงรายการหลัง backup: ${state.afterBackupDocNo}`);
  process.exit(0);
}

const [adminUser, adminTemp, statePath] = rest;
const tag = randomUUID().slice(0, 6);
const admin = await loginFirst('staff', adminUser, adminTemp, `ผู้ดูแลทดสอบ-${randomUUID()}`);
const staff = await admin.json('POST', '/api/admin/staff', { email: `smoke-${tag}`, name: `ครูทดสอบ ${tag}`, role: 'teacher' });
const room = await admin.json('POST', '/api/admin/classrooms', { name: `ห้องทดสอบ ${tag}`, teacherId: staff.id });
const teacher = await loginFirst('staff', `smoke-${tag}`, staff.tempPassword, `ครูทดสอบ-${randomUUID()}`);
const studentCode = `S${tag}`;
const temp = `ชั่วคราว-${randomUUID().slice(0, 8)}`;
await teacher.json('POST', `/api/classrooms/${room.id}/import`, { rows: [{ studentCode, name: `นักเรียนทดสอบ ${tag}`, password: temp }] });
await teacher.json('POST', `/api/classrooms/${room.id}/companies`, { name: `ร้านทดสอบ ${tag}`, mode: 'practice' });
const studentPassword = `นักเรียนทดสอบ-${randomUUID().slice(0, 8)}`;
const student = await loginFirst('student', studentCode, temp, studentPassword);
const companies = await student.json('GET', '/api/me/companies');
const companyId = companies[0]?.id;
if (!companyId) fail('นักเรียนไม่มีบริษัท');
console.log(`ครู/ห้อง/นักเรียน/บริษัท พร้อม (${studentCode})`);

// ดูสด: เปิด SSE ผ่าน Caddy แล้วลงรายการ ต้องได้ event ภายใน 10 วินาที (LISTEN ต่อตรง db ทำงาน)
const live = await student.req('GET', `/api/realtime?channel=company:${companyId}`, undefined, { accept: 'text/event-stream' });
if (live.status !== 200 || !live.headers.get('content-type')?.startsWith('text/event-stream')) fail(`SSE ${live.status}`);
const reader = live.body.getReader();
const gotEvent = (async () => {
  const dec = new TextDecoder(); let buf = '';
  const until = Date.now() + 10_000;
  while (Date.now() < until) {
    const { value, done } = await Promise.race([reader.read(), new Promise((r) => setTimeout(() => r({ value: undefined, done: false }), 500))]);
    if (done) break;
    if (value) buf += dec.decode(value);
    if (/\ndata: /.test(`\n${buf}`)) return true;
  }
  return false;
})();
const entry = await post(student, companyId, 'ลงทุนเริ่มกิจการ', '50000.00');
if (!(await gotEvent)) fail('SSE ไม่ได้ event หลังลงรายการ (ดู REALTIME_DATABASE_URL)');
await reader.cancel();
console.log(`ลงรายการ ${entry.docNo ?? entry.doc_no} + ได้ event ดูสดผ่าน Caddy`);

const tb = await student.json('GET', `/api/companies/${companyId}/trial-balance?month=2026-10`);
console.log(`งบทดลอง: ${JSON.stringify(tb).length} ไบต์`);
for (const f of ['trial-balance.pdf', 'trial-balance.xlsx', 'ledger.pdf']) {
  const r = await student.req('GET', `/export/company/${companyId}/${f}?month=2026-10`);
  const b = Buffer.from(await r.arrayBuffer());
  const magic = f.endsWith('.pdf') ? '%PDF' : 'PK';
  if (r.status !== 200 || b.subarray(0, magic.length).toString() !== magic) fail(`ส่งออก ${f} → ${r.status} ${b.subarray(0, 120).toString()}`);
  if (f.endsWith('.pdf') && !b.includes('FontFile2')) fail(`${f} ไม่ได้ฝังฟอนต์`);
  console.log(`ส่งออก ${f}: ${b.length} ไบต์`);
}
// ไม่ล็อกอิน = ส่งออกไม่ได้
const anon = await session().req('GET', `/export/company/${companyId}/trial-balance.pdf?month=2026-10`);
if (anon.status === 200) fail('ส่งออกได้โดยไม่ล็อกอิน');

writeFileSync(statePath, JSON.stringify({ companyId, studentCode, studentPassword }));
console.log('ผ่าน');
