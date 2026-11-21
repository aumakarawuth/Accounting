// ขั้นที่ 2 ของการทดสอบห้องเรียน 50 คน (docs/load-test-class50.md): กรณีรุนแรงระดับ API ที่จับจังหวะจากเบราว์เซอร์ไม่ได้
// ใช้ห้อง/ครู/นักเรียนจากขั้นที่ 1 (setup.json + รหัสผ่านที่ตั้งใหม่) แล้วทดสอบ:
//  A) ล็อกอินพร้อมกันทั้งห้องในเสี้ยววินาทีเดียว
//  B) ส่งตรวจพร้อมกันทั้งห้อง คนละ 2 คำขอพร้อมกัน (กดซ้ำ) → ต้องได้ "ส่ง" ครั้งเดียวต่อคน
//  C) ครูส่งกลับพร้อมกับที่นักเรียนกดส่ง/ลงรายการ (ชนกัน) → สถานะสุดท้ายต้องสอดคล้อง ไม่มีรายการหลุดเข้าไปตอนล็อก
//  D) สอบจับเวลา 1 นาที: เริ่มพร้อมกัน ลงรายการรัว ๆ จนหมดเวลา → หลังหมดเวลาต้องลงไม่ได้ (ล็อกที่ DB)
//  E) API ดับกลางคาบ (เหมือน deploy/ล่ม) แล้วกลับมา: ส่งคำขอเดิมซ้ำด้วยคีย์เดิม → ไม่หาย ไม่ซ้ำ
// node tests/load/class50-stress.mjs <base> <โฟลเดอร์ผลขั้นที่ 1> <คำสั่งรีสตาร์ต API (shell)>
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const [base, dir, restartCmd] = process.argv.slice(2);
const setup = JSON.parse(readFileSync(`${dir}/setup.json`, 'utf8'));
const creds = JSON.parse(readFileSync(`${dir}/stress-creds.json`, 'utf8')); // { teacher: {user, password}, students: {code: password} }
const out = { checks: [] };
const check = (name, ok, detail = '') => { out.checks.push({ name, ok, detail }); console.log(`${ok ? 'ผ่าน' : 'ไม่ผ่าน'}  ${name}${detail ? ` — ${detail}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Client {
  constructor() { this.cookie = ''; }
  async req(method, path, body, key = randomUUID(), timeoutMs = 30_000) {
    const r = await fetch(`${base}/api${path}`, { method, signal: AbortSignal.timeout(timeoutMs),
      headers: { origin: base, cookie: this.cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }), 'idempotency-key': key },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.getSetCookie?.() ?? [];
    for (const c of sc) { const kv = c.split(';')[0]; if (kv.includes('sid=')) this.cookie = kv; }
    let json = null; try { json = await r.json(); } catch { /* 204 */ }
    return { status: r.status, json };
  }
}
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return Math.round(s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]); };

const students = setup.students.map((s) => ({ ...s, password: creds.students[s.code], c: new Client() }));
const teacher = new Client();

// ---- A) ล็อกอินพร้อมกัน ----
{
  const t = await Promise.all(students.map(async (s) => {
    const st = performance.now();
    const r = await s.c.req('POST', '/auth/login', { kind: 'student', identifier: s.code, password: s.password });
    return { ms: performance.now() - st, status: r.status };
  }));
  const ok = t.filter((x) => x.status === 200).length;
  check('A ล็อกอินพร้อมกัน 50 คนในจังหวะเดียว', ok === students.length, `${ok}/${students.length} สำเร็จ p95 ${pct(t.map((x) => x.ms), 0.95)} ms สูงสุด ${pct(t.map((x) => x.ms), 1)} ms`);
  out.loginBurst = { p50: pct(t.map((x) => x.ms), 0.5), p95: pct(t.map((x) => x.ms), 0.95), max: pct(t.map((x) => x.ms), 1) };
}
const tl = await teacher.req('POST', '/auth/login', { kind: 'staff', identifier: creds.teacher.user, password: creds.teacher.password });
if (tl.status !== 200) throw new Error(`ครูเข้าไม่ได้ ${tl.status}`);

// งานใหม่สำหรับขั้นนี้ (ส่งงาน) จากชุดโจทย์เดิม
const asg = await teacher.req('POST', `/teacher/exercises/${setup.setId}/assign`, { classroomId: setup.classroomId, mode: 'submit', companyName: `งานชน ${randomUUID().slice(0, 4)}`, feedback: 'score', reveal: 'after_submit' });
if (asg.status !== 201) throw new Error(`มอบหมายไม่ได้ ${asg.status} ${JSON.stringify(asg.json)}`);
for (const s of students) {
  const list = (await s.c.req('GET', '/me/companies')).json;
  s.co = list.find((x) => x.assignmentId === asg.json.assignmentId || x.name?.startsWith('งานชน'))?.id;
}
check('เปิดบริษัทงานใหม่ให้ครบ', students.every((s) => s.co), `${students.filter((s) => s.co).length}/${students.length}`);
const entry = (n) => ({ date: '2026-10-01', description: `ลงรัว ${n}`, lines: [{ account_code: '1110', debit: String(100 + n) }, { account_code: '3110', credit: String(100 + n) }] });

// ---- B) ส่งตรวจพร้อมกันทั้งห้อง คนละ 2 คำขอ ----
{
  await Promise.all(students.map((s) => s.c.req('POST', `/companies/${s.co}/journal`, entry(1))));
  const t0 = performance.now();
  const rs = await Promise.all(students.flatMap((s) => [0, 1].map(() => s.c.req('POST', `/companies/${s.co}/submission`, { action: 'submit', expected: 'draft' }))));
  const ms = performance.now() - t0;
  const codes = rs.reduce((m, r) => ({ ...m, [r.status]: (m[r.status] ?? 0) + 1 }), {});
  const subs = await Promise.all(students.map((s) => s.c.req('GET', `/companies/${s.co}/submission`)));
  const once = subs.every((r) => r.json.status === 'submitted' && r.json.events.filter((e) => e.action === 'submit').length === 1);
  check('B ส่งตรวจพร้อมกัน 100 คำขอ (คนละ 2): ส่งสำเร็จคนละครั้งเดียว', once && rs.every((r) => r.status < 500), `รหัสตอบ ${JSON.stringify(codes)} ใช้เวลา ${Math.round(ms)} ms`);
}

// ---- C) ครูส่งกลับ ชนกับนักเรียนลงรายการ/ส่งซ้ำ ----
{
  const rs = await Promise.all(students.map(async (s, i) => {
    await teacher.req('POST', `/companies/${s.co}/submission`, { action: 'review', expected: 'submitted' });
    const [ret, post, resub] = await Promise.all([
      teacher.req('POST', `/companies/${s.co}/submission`, { action: 'return', expected: 'reviewing', note: 'แก้ข้อ 1' }),
      s.c.req('POST', `/companies/${s.co}/journal`, entry(2 + i)),
      s.c.req('POST', `/companies/${s.co}/submission`, { action: 'submit', expected: 'returned' }),
    ]);
    const sub = (await s.c.req('GET', `/companies/${s.co}/submission`)).json;
    const je = (await s.c.req('GET', `/companies/${s.co}/journal`)).json;
    return { ret: ret.status, post: post.status, resub: resub.status, final: sub.status, entries: je.length, posted: post.status === 201 };
  }));
  // สอดคล้อง = รายการที่ลงสำเร็จต้องลงตอนสถานะแก้ได้ (หลังส่งกลับ) · ถ้าส่งใหม่สำเร็จ สถานะต้องเป็น submitted · ไม่มี 5xx
  const bad = rs.filter((r) => [r.ret, r.post, r.resub].some((x) => x >= 500) || r.entries !== (r.posted ? 2 : 1) || (r.resub === 200 && r.final !== 'submitted'));
  const dist = rs.reduce((m, r) => { const k = `ส่งกลับ ${r.ret} ลง ${r.post} ส่งใหม่ ${r.resub} → ${r.final}`; m[k] = (m[k] ?? 0) + 1; return m; }, {});
  check('C ครูส่งกลับชนกับนักเรียนลงรายการ/ส่งใหม่: ไม่มี 5xx สถานะกับรายการสอดคล้องกันทุกคน', bad.length === 0, JSON.stringify(dist));
}

// ---- D) สอบจับเวลา 1 นาที ----
{
  const ex = await teacher.req('POST', `/teacher/exercises/${setup.setId}/assign`, { classroomId: setup.classroomId, mode: 'exam', companyName: `สอบโหลด ${randomUUID().slice(0, 4)}`, durationMinutes: 1, feedback: 'score' });
  if (ex.status !== 201) throw new Error(`สร้างสอบไม่ได้ ${ex.status} ${JSON.stringify(ex.json)}`);
  for (const s of students) s.exam = (await s.c.req('GET', '/me/companies')).json.find((x) => x.name?.startsWith('สอบโหลด'))?.id;
  const st = await Promise.all(students.map((s) => s.c.req('POST', `/companies/${s.exam}/assignment/start`)));
  check('D เริ่มสอบพร้อมกัน 50 คน', st.every((r) => r.status < 300), JSON.stringify(st.reduce((m, r) => ({ ...m, [r.status]: (m[r.status] ?? 0) + 1 }), {})));
  // ลงรายการรัวทุก ~1 วินาทีจนครบ 75 วินาที (เกินเวลาสอบ 15 วินาที)
  const startAt = Date.now();
  const tally = { okBefore: 0, okAfter: 0, rejAfter: 0, rejBefore: 0, err5xx: 0 };
  const deadline = new Map();
  for (const s of students) {
    const v = (await s.c.req('GET', `/companies/${s.exam}/assignment`)).json;
    deadline.set(s.code, Date.parse(v.attempt?.deadline ?? 0));
  }
  await Promise.all(students.map(async (s, i) => {
    let n = 0;
    while (Date.now() - startAt < 75_000) {
      const sent = Date.now();
      const r = await s.c.req('POST', `/companies/${s.exam}/journal`, entry(500 + i * 100 + n++));
      const after = sent > deadline.get(s.code) + 1000; // เผื่อนาฬิกา 1 วินาที
      const before = Date.now() < deadline.get(s.code) - 1000;
      if (r.status >= 500) tally.err5xx++;
      else if (r.status === 201) { if (after) tally.okAfter++; else tally.okBefore++; }
      else if (before) tally.rejBefore++; else tally.rejAfter++;
      await sleep(700 + Math.random() * 600);
    }
  }));
  check('D หมดเวลาสอบแล้วลงรายการไม่ได้ (ล็อกที่ DB) ก่อนหมดเวลาลงได้ทุกครั้ง', tally.okAfter === 0 && tally.rejBefore === 0 && tally.err5xx === 0 && tally.okBefore > 0,
    JSON.stringify(tally));
}

// ---- E) API ดับกลางคาบแล้วกลับมา ----
if (restartCmd) {
  // งานฝึกหัดใหม่ (บริษัทที่ยังลงรายการได้ บริษัทจาก B/C ส่งตรวจไปแล้ว = ล็อก)
  const pr = await teacher.req('POST', `/teacher/exercises/${setup.setId}/assign`, { classroomId: setup.classroomId, mode: 'practice', companyName: `ฝึกดับ ${randomUUID().slice(0, 4)}` });
  if (pr.status !== 201) throw new Error(`มอบหมายฝึกหัดไม่ได้ ${pr.status}`);
  for (const s of students) s.co = (await s.c.req('GET', '/me/companies')).json.find((x) => x.name?.startsWith('ฝึกดับ'))?.id;
  const keys = students.map(() => randomUUID());
  const sent = students.map((s, i) => s.c.req('POST', `/companies/${s.co}/journal`, entry(9000 + i), keys[i], 15_000).catch((e) => ({ status: 0, err: String(e) })));
  await sleep(150);
  execSync(restartCmd, { stdio: 'ignore' }); // ฆ่าแล้วเริ่ม API ใหม่
  const first = await Promise.all(sent);
  // เน็ตหลุด/เซิร์ฟเวอร์ดับ: ไคลเอนต์ส่งซ้ำด้วยคีย์เดิมจนสำเร็จ (เหมือนฟอร์มที่กดใหม่)
  for (let tries = 0; tries < 30; tries++) {
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* ยังไม่ขึ้น */ }
    await sleep(500);
  }
  const retry = await Promise.all(students.map((s, i) => s.c.req('POST', `/companies/${s.co}/journal`, entry(9000 + i), keys[i])));
  const counts = await Promise.all(students.map(async (s, i) => (await s.c.req('GET', `/companies/${s.co}/journal`)).json.filter((e) => e.description === `ลงรัว ${9000 + i}`).length));
  const lost = counts.filter((n) => n === 0).length, dup = counts.filter((n) => n > 1).length;
  check('E API ดับระหว่างลงรายการแล้วกลับมา: ส่งซ้ำด้วยคีย์เดิม ไม่หาย ไม่ซ้ำ', lost === 0 && dup === 0 && retry.every((r) => r.status === 201),
    `รอบแรก ${JSON.stringify(first.reduce((m, r) => ({ ...m, [r.status]: (m[r.status] ?? 0) + 1 }), {}))} · ส่งซ้ำ ${JSON.stringify(retry.reduce((m, r) => ({ ...m, [r.status]: (m[r.status] ?? 0) + 1 }), {}))} · หาย ${lost} ซ้ำ ${dup}`);
}

writeFileSync(`${dir}/stress.json`, JSON.stringify(out, null, 1));
process.exit(out.checks.every((c) => c.ok) ? 0 : 1);
