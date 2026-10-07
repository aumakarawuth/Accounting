// เปิดช่อง realtime ของนักเรียนค้างไว้ (k6 ไม่รองรับ SSE) เพื่อจำลองทุกคนเปิดหน้าเว็บอยู่ตลอดคาบ
// node tests/load/sse-holders.mjs <base> <จำนวน> <วินาที>
import { readFileSync } from 'node:fs';
const [base = 'http://127.0.0.1:4000', nArg = '500', secArg = '330'] = process.argv.slice(2);
const data = JSON.parse(readFileSync(new URL('./data/users.json', import.meta.url)));
const N = Math.min(Number(nArg), data.students.length);
const ORIGIN = 'http://localhost:3000';
const stats = { loginFail: 0, open: 0, openFail: 0, dropped: 0, events: 0, watch: 0 };
const ctrl = new AbortController();

function read(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const line of dec.decode(value).split('\n')) {
          if (line.startsWith('data: ')) { stats.events++; if (line.includes('"k":"watch"')) stats.watch++; }
        }
      }
    } catch { /* ยกเลิก */ }
    stats.open--;
    if (!ctrl.signal.aborted) stats.dropped++;
  })();
}

async function open1(s) {
  const r = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ kind: 'student', identifier: s.code, password: data.password }) });
  if (!r.ok) { stats.loginFail++; return; }
  const cookie = r.headers.get('set-cookie').split(';')[0];
  const me = await (await fetch(`${base}/auth/me`, { headers: { cookie } })).json();
  const res = await fetch(`${base}/realtime?channel=student:${me.id}`, { headers: { cookie }, signal: ctrl.signal });
  if (!res.ok) { stats.openFail++; return; }
  stats.open++;
  read(res);
}

const t0 = Date.now();
const queue = data.students.slice(0, N);
await Promise.all(Array.from({ length: 20 }, async () => {
  while (queue.length) await open1(queue.shift()).catch(() => stats.openFail++);
}));
console.log(`[sse] เปิดครบใน ${((Date.now() - t0) / 1000).toFixed(1)}s ${JSON.stringify(stats)}`);
const tick = setInterval(() => console.log(`[sse] ${JSON.stringify(stats)}`), 30_000);
setTimeout(() => { clearInterval(tick); ctrl.abort(); console.log(`[sse] จบ ${JSON.stringify(stats)}`); setTimeout(() => process.exit(0), 500); }, Number(secArg) * 1000);
