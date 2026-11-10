// วัดหน้าเว็บ (docs/performance.md): node scripts/perf/measure.cjs out.json result.json (ต้องมี playwright) · TTFB ของเอกสาร, load, จำนวน/ขนาด JS (ไม่ใช้ cache), API ที่หน้าเรียกจากเบราว์เซอร์
/* eslint-disable @typescript-eslint/no-require-imports -- สคริปต์ CommonJS ใช้ playwright ที่ติดตั้งในเครื่อง */
const { chromium } = require('playwright');
const fs = require('fs');
const st = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const base = process.env.BASE || 'http://localhost:3000';
const month = '2026-06';
(async () => {
  const b = await chromium.launch();
  const out = [];
  async function measure(ctx, label, path, runs = 3) {
    const times = [];
    let js = 0, jsN = 0, api = 0, bytes = 0;
    for (let r = 0; r < runs; r++) {
      const p = await ctx.newPage();
      const cdp = await ctx.newCDPSession(p);
      await cdp.send('Network.setCacheDisabled', { cacheDisabled: r === 0 });
      let jsB = 0, jsC = 0, apiC = 0;
      p.on('response', async (res) => {
        const req = res.request();
        if (req.resourceType() === 'script') { jsC++; jsB += (await res.body().catch(() => Buffer.alloc(0))).length; }
        if (res.url().includes('/api/') && req.resourceType() !== 'eventsource') apiC++;
      });
      const t0 = Date.now();
      await p.goto(base + path, { waitUntil: 'load' });
      const nav = await p.evaluate(() => { const n = performance.getEntriesByType('navigation')[0]; return { ttfb: n.responseStart - n.requestStart, load: n.loadEventEnd - n.startTime, size: n.transferSize }; });
      await p.waitForLoadState('networkidle').catch(() => {});
      times.push({ ...nav, wall: Date.now() - t0 });
      if (r === 0) { js = jsB; jsN = jsC; api = apiC; bytes = nav.size; }
      await p.close();
    }
    const med = (k) => times.map((t) => t[k]).sort((a, b) => a - b)[Math.floor(times.length / 2)];
    const row = { label, ttfb: Math.round(med('ttfb')), load: Math.round(med('load')), coldTtfb: Math.round(times[0].ttfb), jsKB: Math.round(js / 1024), jsFiles: jsN, apiCalls: api, htmlKB: Math.round(bytes / 1024) };
    out.push(row); console.log(JSON.stringify(row));
  }
  async function login(kind, id, pw) {
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
    const r = await ctx.request.post(base + '/api/auth/login', { data: { kind, identifier: id, password: pw }, headers: { origin: base } });
    if (r.status() !== 200) throw new Error('login ' + r.status());
    return ctx;
  }
  const anon = await b.newContext();
  await measure(anon, 'login', '/login');
  const s = await login('student', st.studentCode, st.studentPassword);
  const c = `/c/${st.company}`;
  for (const [l, p] of [['บริษัท(หน้าแรก)', c], ['สมุดรายวัน', `${c}/journal?month=${month}`], ['แยกประเภท', `${c}/ledger?month=${month}`], ['งบทดลอง', `${c}/trial-balance?month=${month}`], ['งบการเงิน', `${c}/statements?month=${month}`], ['กระดาษทำการ', `${c}/worksheet?month=${month}`], ['ลงรายการใหม่', `${c}/journal/new`]]) await measure(s, l, p);
  const t = await login('staff', st.teacher, st.teacherPassword);
  for (const [l, p] of [['ครู: หน้าแรก', '/teacher'], ['ครู: ดูสด', '/teacher/live'], ['ครู: ตรวจงาน', `/teacher/review/${st.company}`]]) await measure(t, l, p);
  fs.writeFileSync(process.argv[3], JSON.stringify(out, null, 1));
  await b.close();
})();
