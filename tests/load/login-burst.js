// k6: นักเรียนทั้งหมดกดเข้าพร้อมกันเป๊ะ (ครูสั่ง "เข้าระบบ") — วัดคอขวด Argon2
// k6 run -e STUDENTS=500 tests/load/login-burst.js
import http from 'k6/http';
import exec from 'k6/execution';
import { check } from 'k6';

const BASE = __ENV.BASE || 'http://127.0.0.1:4000';
const data = JSON.parse(open('./data/users.json'));
const N = Math.min(Number(__ENV.STUDENTS || data.students.length), data.students.length);

export const options = {
  scenarios: { burst: { executor: 'per-vu-iterations', vus: N, iterations: 1, maxDuration: '2m' } },
  thresholds: { checks: ['rate==1'], 'http_req_duration{name:login}': ['p(95)<5000'] },
  summaryTrendStats: ['avg', 'p(50)', 'p(95)', 'p(99)', 'max'],
};

export default function () {
  const s = data.students[exec.vu.idInTest - 1];
  const r = http.post(`${BASE}/auth/login`, JSON.stringify({ kind: 'student', identifier: s.code, password: data.password }),
    { headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' }, tags: { name: 'login' } });
  check(r, { 'login 200': (x) => x.status === 200 });
}
