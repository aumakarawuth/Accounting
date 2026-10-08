// k6: จำลองคาบเรียน 500 คนพร้อมกัน (PLAN.md ข้อ 12 เฟส 1)
// รันสองกระบวนการพร้อมกัน (k6 แจกหมายเลข VU ร่วมกันทุก scenario ถ้ารวมกัน นักเรียนบางคนจะไม่ถูกใช้):
//   k6 run -e ROLE=students tests/load/classroom.js & k6 run -e ROLE=teachers tests/load/classroom.js
// SHORT=1 = รอบสั้นสำหรับลองสคริปต์
//
// นักเรียน: ล็อกอินพร้อมกันตอนเริ่มคาบ → วนทำงาน: พิมพ์ร่าง (presence) → ผ่านรายการ → เปิดรายงาน
//   - 10% กดซ้ำ: ส่งรายการเดียวกันสองครั้งพร้อมกันด้วย idempotency key เดิม ต้องได้รายการเดียว
//   - 10% เน็ตหลุด: คำขอแรกหมดเวลาฝั่ง client แล้วส่งใหม่ด้วย key เดิม ต้องไม่เกิดรายการซ้ำ
//   - 30% เป็นผู้ใช้มือถือช้า: คิดนานกว่า (k6 จำลองแบนด์วิดท์ช้าไม่ได้ ดู docs/load-test.md)
// ครู: แดชบอร์ดห้องทุก 5 วินาที + สุ่มดูสดนักเรียน (เริ่ม/ดึง/ping/หยุด)
import http from 'k6/http';
import exec from 'k6/execution';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';

const BASE = __ENV.BASE || 'http://127.0.0.1:4000';
const ORIGIN = __ENV.ORIGIN || 'http://localhost:3000';
const data = JSON.parse(open('./data/users.json'));
const SHORT = __ENV.SHORT === '1';
const STUDENTS = Math.min(Number(__ENV.STUDENTS || data.students.length), data.students.length);

const ROLE = __ENV.ROLE || 'students';
const scenarios = {
    students: {
      executor: 'ramping-vus', exec: 'student', startVUs: 0,
      stages: SHORT
        ? [{ duration: '20s', target: STUDENTS }, { duration: '40s', target: STUDENTS }, { duration: '5s', target: 0 }]
        : [{ duration: '30s', target: STUDENTS }, { duration: '4m', target: STUDENTS }, { duration: '15s', target: 0 }],
      gracefulRampDown: '45s', // ให้รอบที่กำลังทำจบก่อน (นับรายการได้ครบ)
    },
    teachers: {
      executor: 'constant-vus', exec: 'teacher', vus: data.teachers.length,
      duration: SHORT ? '65s' : '4m45s', startTime: '5s',
    },
};

export const options = {
  scenarios: { [ROLE]: scenarios[ROLE] },
  thresholds: {
    checks: ['rate>0.99'],
    'http_req_duration{name:login}': ['p(95)<3000'],
    'http_req_duration{name:post_journal}': ['p(95)<800'],
    'http_req_duration{name:presence}': ['p(95)<300'],
    'http_req_duration{name:report}': ['p(95)<500'],
    'http_req_duration{name:dashboard}': ['p(95)<500'],
    duplicate_entries: ['count==0'],
  },
  summaryTrendStats: ['avg', 'p(50)', 'p(95)', 'p(99)', 'max'],
  noCookiesReset: true, // เซสชันอยู่ตลอดคาบเหมือนเบราว์เซอร์ (ค่าเริ่มต้นของ k6 ล้าง cookie ทุกรอบ)
};

const postedOk = new Counter('entries_confirmed');
const postedUnknown = new Counter('entries_unknown');
const duplicates = new Counter('duplicate_entries');
const doubleClicks = new Counter('double_clicks');
const reconnects = new Counter('reconnect_retries');
const rateLimited = new Counter('rate_limited_429');
const loginTime = new Trend('login_time', true);

const json = (name, extra = {}) => ({ headers: { 'content-type': 'application/json', origin: ORIGIN, ...extra }, tags: { name } });
const get = (url, name) => http.get(`${BASE}${url}`, { headers: { origin: ORIGIN }, tags: { name } });
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (xs) => xs[Math.floor(Math.random() * xs.length)];
const note429 = (r) => { if (r.status === 429) rateLimited.add(1); return r; };

const CODES_DR = ['1110', '1210', '5210', '5220', '5230'];
const CODES_CR = ['4110', '4120', '3110', '2110'];
const month = '2026-10';

function login(kind, identifier, password) {
  const t0 = Date.now();
  const r = note429(http.post(`${BASE}/auth/login`, JSON.stringify({ kind, identifier, password }), json('login')));
  loginTime.add(Date.now() - t0);
  return check(r, { 'login 200': (x) => x.status === 200 });
}

let me = null; // สถานะต่อ VU (k6 แยก VU กัน)

export function student() {
  if (!me) {
    const s = data.students[(exec.vu.idInTest - 1) % STUDENTS];
    if (!login('student', s.code, data.password)) { sleep(5); return; }
    const cos = get('/me/companies', 'report');
    const company = cos.status === 200 ? cos.json()[0]?.id : null;
    if (!company) { sleep(5); return; }
    me = { company, slow: Math.random() < 0.3, n: 0 };
  }
  const c = me.company;
  const think = (fast, slow) => sleep(me.slow ? rand(...slow) : rand(...fast));
  const presence = (body) => note429(http.post(`${BASE}/companies/${c}/presence`, JSON.stringify(body), json('presence')));

  // พิมพ์ร่าง: ส่งสถานะทีละจังหวะเหมือนหน่วง 1.5 วินาทีในเบราว์เซอร์
  const amount = String(Math.floor(rand(1, 50000)));
  const dr = pick(CODES_DR), cr = pick(CODES_CR);
  const steps = [
    [{ account_code: dr, debit: amount, credit: '' }, { account_code: '', debit: '', credit: '' }],
    [{ account_code: dr, debit: amount, credit: '' }, { account_code: cr, debit: '', credit: amount.slice(0, -1) || '1' }],
    [{ account_code: dr, debit: amount, credit: '' }, { account_code: cr, debit: '', credit: amount }],
  ];
  for (const lines of steps) {
    check(presence({ page: 'journal', draft: { date: '07/10/2569', description: 'ทดสอบโหลด', lines } }), { 'presence 200': (r) => r.status === 200 });
    think([1, 3], [3, 6]);
  }

  // ผ่านรายการ (ทศนิยมเป็นสตริงเสมอ)
  const key = `${exec.vu.idInTest}-${me.n++}-${Date.now()}`;
  const body = JSON.stringify({ date: `${month}-07`, description: 'ทดสอบโหลด',
    lines: [{ account_code: dr, debit: amount }, { account_code: cr, credit: amount }] });
  const params = json('post_journal', { 'idempotency-key': key });
  const roll = Math.random();
  if (roll < 0.1) {
    // กดซ้ำ: สองคำขอพร้อมกัน key เดียวกัน → ต้องได้ id เดียวกัน
    doubleClicks.add(1);
    const [a, b] = http.batch([['POST', `${BASE}/companies/${c}/journal`, body, params], ['POST', `${BASE}/companies/${c}/journal`, body, params]]);
    const ok = check([a, b], { 'double click → same entry': ([x, y]) => x.status === 201 && y.status === 201 && x.json('id') === y.json('id') });
    if (ok) postedOk.add(1); else postedUnknown.add(1);
    if (a.status === 201 && b.status === 201 && a.json('id') !== b.json('id')) duplicates.add(1);
  } else if (roll < 0.2) {
    // เน็ตหลุด: คำขอแรกหมดเวลา (เซิร์ฟเวอร์อาจทำไปแล้ว) → ส่งใหม่ key เดิม
    reconnects.add(1);
    http.post(`${BASE}/companies/${c}/journal`, body, { ...params, timeout: '5ms', tags: { name: 'post_journal_dropped' } });
    sleep(rand(0.5, 2));
    const r = note429(http.post(`${BASE}/companies/${c}/journal`, body, params));
    if (check(r, { 'retry after drop → 201': (x) => x.status === 201 })) postedOk.add(1); else postedUnknown.add(1);
  } else {
    const r = note429(http.post(`${BASE}/companies/${c}/journal`, body, params));
    if (check(r, { 'post 201': (x) => x.status === 201 })) postedOk.add(1); else postedUnknown.add(1);
  }
  // เหมือนเบราว์เซอร์: POST ไม่มี body ไม่ส่ง content-type
  check(http.post(`${BASE}/companies/${c}/presence/clear-draft`, null, { headers: { origin: ORIGIN }, tags: { name: 'presence' } }), { 'clear draft 200': (r) => r.status === 200 });

  // เปิดรายงานบางรอบ
  if (me.n % 3 === 0) check(get(`/companies/${c}/trial-balance?month=${month}`, 'report'), { 'trial balance 200': (r) => r.status === 200 });
  if (me.n % 4 === 0) check(get(`/companies/${c}/ledger?month=${month}&account=${dr}`, 'report'), { 'ledger 200': (r) => r.status === 200 });
  if (me.n % 5 === 0) check(get(`/companies/${c}/statements?month=${month}`, 'report'), { 'statements 200': (r) => r.status === 200 });
  check(presence({ page: 'home' }), { 'presence 200': (r) => r.status === 200 });
  think([5, 10], [10, 20]);
}

let tState = null;
export function teacher() {
  if (!tState) {
    const t = data.teachers[(exec.vu.idInTest - 1) % data.teachers.length];
    if (!login('staff', t.email, data.password)) { sleep(5); return; }
    tState = { room: t.classroomId, n: 0 };
  }
  const r = note429(get(`/teacher/classrooms/${tState.room}/live`, 'dashboard'));
  check(r, { 'dashboard 200': (x) => x.status === 200 });
  if (++tState.n % 6 === 0 && r.status === 200) {
    const row = pick(r.json().filter((x) => x.companyId));
    if (row) {
      const bare = { headers: { origin: ORIGIN }, tags: { name: 'spectate' } }; // POST ไม่มี body แบบเบราว์เซอร์
      const s = http.post(`${BASE}/companies/${row.companyId}/spectate`, null, bare);
      if (check(s, { 'spectate 201': (x) => x.status === 201 })) {
        for (let i = 0; i < 3; i++) { check(get(`/companies/${row.companyId}/live`, 'report'), { 'live 200': (x) => x.status === 200 }); sleep(2); }
        check(http.post(`${BASE}/spectate/${s.json('id')}/ping`, null, bare), { 'ping 200': (x) => x.status === 200 });
        check(http.post(`${BASE}/spectate/${s.json('id')}/stop`, null, bare), { 'stop 200': (x) => x.status === 200 });
      }
    }
  }
  sleep(5);
}
