// ทดสอบห้องเรียนจริง 50 คนด้วยเบราว์เซอร์จริง (docs/load-test-class50.md)
// ผู้ดูแลสร้างครู/ห้อง → ครูนำเข้า 50 คน สร้างโจทย์ มอบหมายแบบส่งงาน → นักเรียน 50 คนเข้าพร้อมกัน ลงรายการผ่านฟอร์มจริง
// (มีคนตั้งใจทำผิด + กดซ้ำ + เน็ตหลุดหลังเซิร์ฟเวอร์บันทึกแล้ว + รีโหลดกลางฟอร์ม + สองแท็บ) → ส่งตรวจพร้อมกัน
// → ครูตรวจทุกคนผ่านหน้าจอ (คะแนนอัตโนมัติต้องตรงเฉลยที่คาดไว้) ส่งกลับคนที่ผิด → นักเรียนแก้ ส่งใหม่ → ครูให้ผ่าน
// node tests/load/class50.mjs <base> <อีเมลผู้ดูแล> <รหัสผู้ดูแล(ชั่วคราว)> <โฟลเดอร์ผล> [จำนวนคน=50]
// ผลดิบ (เวลา ข้อผิดพลาด) เขียนเป็น JSON ในโฟลเดอร์ผล ตรวจฐานข้อมูลต่อด้วย tests/load/class50-verify.mjs
import { chromium } from 'playwright';
import { randomUUID } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';

const [base, adminEmail, adminPw, out, nArg] = process.argv.slice(2);
const N = Number(nArg ?? 50);
mkdirSync(out, { recursive: true });
const RUN = randomUUID().slice(0, 6);
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (a, b) => sleep(a + Math.random() * (b - a));

// ---- เก็บผล ----
const timings = {}; // ชื่อขั้น → [ms]
const time = async (name, fn) => {
  const s = performance.now();
  try { return await fn(); } finally { (timings[name] ??= []).push(performance.now() - s); }
};
const problems = []; // ข้อผิดพลาดที่ไม่ควรเกิด
const fail = (who, what) => { problems.push({ who, what: String(what).slice(0, 500), at: ((Date.now() - t0) / 1000).toFixed(1) }); log(`!! ${who}: ${String(what).slice(0, 200)}`); };

// ---- โจทย์ (7 คะแนน) ----
const ITEMS = [
  { no: 1, date: '2026-10-01', text: 'นำเงินสดมาลงทุน 50,000 บาท', points: '1', lines: [['1110', '50000', 'D'], ['3110', '50000', 'C']] },
  { no: 2, date: '2026-10-03', text: 'นำเงินสดฝากธนาคาร 30,000 บาท', points: '1', lines: [['1120', '30000', 'D'], ['1110', '30000', 'C']] },
  { no: 3, date: '2026-10-05', text: 'ซื้อสินค้าเป็นเงินสด 8,000 บาท', points: '1', lines: [['5110', '8000', 'D'], ['1110', '8000', 'C']] },
  { no: 4, date: '2026-10-10', text: 'ขายสินค้าเป็นเงินเชื่อ 12,000 บาท', points: '1', lines: [['1210', '12000', 'D'], ['4110', '12000', 'C']] },
  { no: 5, date: '2026-10-15', text: 'จ่ายค่าเช่าร้านด้วยเช็ค 4,500 บาท', points: '1', lines: [['5220', '4500', 'D'], ['1120', '4500', 'C']] },
  { no: 6, date: '2026-10-20', text: 'ลูกหนี้ชำระหนี้ 7,000 บาท เป็นเงินสด 4,000 บาท ที่เหลือโอนเข้าบัญชี', points: '2',
    lines: [['1110', '4000', 'D'], ['1120', '3000', 'D'], ['1210', '7000', 'C']] },
];
const MAX = 7;

// ---- บุคลิกนักเรียน: ผิดตรงไหน ใช้อุปกรณ์อะไร เจอเหตุการณ์อะไร ----
const DEVICES = [
  { name: 'phone', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
  { name: 'ipad', viewport: { width: 1180, height: 820 }, hasTouch: true },
  { name: 'pc', viewport: { width: 1440, height: 900 } },
];
function persona(i) {
  const wrong = { 3: i % 5 === 1 ? 'account' : null, 5: i % 7 === 2 ? 'amount' : null, 2: i % 11 === 3 ? 'date' : null };
  const lost = Object.entries(wrong).filter(([, w]) => w).reduce((s, [no]) => s + Number(ITEMS[no - 1].points), 0);
  return {
    i, code: `L${RUN}${String(i + 1).padStart(3, '0')}`.slice(0, 20), name: `นักเรียนโหลด ${i + 1}`, password: `ผ่านเข้า-${randomUUID().slice(0, 10)}`,
    device: DEVICES[i % 3], wrong, expected: MAX - lost,
    dblPost: i % 10 === 0, lostResponse: i % 8 === 4, reloadMid: i % 9 === 6, twoTabs: i % 13 === 7, dblSubmit: i % 6 === 3,
  };
}
const students = Array.from({ length: N }, (_, i) => persona(i));
const thaiDate = (iso) => { const [y, m, d] = iso.split('-'); return `${d}/${m}/${Number(y) + 543}`; };

// ---- ตั้งค่าห้อง (ผู้ดูแล + ครู) ผ่าน API ด้วย session จริง ----
const browsers = [];
async function browser() {
  const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args: ['--disable-dev-shm-usage'] });
  browsers.push(b);
  return b;
}
async function api(ctx, method, path, data) {
  const r = await ctx.request.fetch(`${base}/api${path}`, { method, data, headers: { origin: base, 'idempotency-key': randomUUID() } });
  if (r.status() >= 300) throw new Error(`${method} ${path} → ${r.status()} ${await r.text()}`);
  return r.status() === 204 ? null : r.json();
}

const setupBrowser = await browser();
const actx = await setupBrowser.newContext();
await api(actx, 'POST', '/auth/login', { kind: 'staff', identifier: adminEmail, password: adminPw });
const me = await api(actx, 'GET', '/auth/me');
let adminPassword = adminPw;
if (me.mustChange) {
  adminPassword = `ผู้ดูแลทดสอบ-${randomUUID().slice(0, 8)}`;
  await api(actx, 'POST', '/auth/change-password', { newPassword: adminPassword });
  writeFileSync(`${out}/.admin-password`, adminPassword, { mode: 0o600 }); // รอบต่อไปใช้รหัสนี้
}
const teacherUser = `load-${RUN}`;
const staff = await api(actx, 'POST', '/admin/staff', { email: teacherUser, name: `ครูทดสอบโหลด ${RUN}`, role: 'teacher' });
const room = await api(actx, 'POST', '/admin/classrooms', { name: `ห้องทดสอบโหลด ${RUN}`, teacherId: staff.id });
await actx.close();

const teacherBrowser = await browser();
const tctx = await teacherBrowser.newContext({ viewport: { width: 1440, height: 900 } });
await api(tctx, 'POST', '/auth/login', { kind: 'staff', identifier: teacherUser, password: staff.tempPassword });
const teacherPw = `ครูทดสอบโหลด-${randomUUID().slice(0, 8)}`;
await api(tctx, 'POST', '/auth/change-password', { newPassword: teacherPw });
// รหัสผ่านที่สร้างในรอบนี้ (เก็บในโฟลเดอร์ผลเท่านั้น ไม่อยู่ใน repo) ให้ class50-stress.mjs ใช้ต่อ
writeFileSync(`${out}/stress-creds.json`, JSON.stringify({ teacher: { user: teacherUser, password: teacherPw },
  students: Object.fromEntries(students.map((s) => [s.code, s.password])) }), { mode: 0o600 });
await time('setup.import50', () => api(tctx, 'POST', `/classrooms/${room.id}/import`,
  { rows: students.map((s) => ({ studentCode: s.code, name: s.name, password: s.password })) }));
const set = await api(tctx, 'POST', '/teacher/exercises', {
  title: `แบบฝึกหัดทดสอบโหลด ${RUN}`, companyName: 'ร้านทดสอบโหลด',
  items: ITEMS.map((it) => ({ date: it.date, narrative: it.text, points: it.points,
    lines: it.lines.map(([account_code, amt, side]) => ({ account_code, [side === 'D' ? 'debit' : 'credit']: amt })) })),
});
const assignment = await time('setup.assign', () => api(tctx, 'POST', `/teacher/exercises/${set.id}/assign`, {
  classroomId: room.id, mode: 'submit', companyName: `งานโหลด ${RUN}`, feedback: 'items', reveal: 'after_submit' }));
log(`ห้อง ${room.id} งาน ${assignment.id ?? JSON.stringify(assignment)} นักเรียน ${N} คน`);
writeFileSync(`${out}/setup.json`, JSON.stringify({ run: RUN, classroomId: room.id, assignment, setId: set.id, teacher: teacherUser,
  students: students.map(({ password: _p, ...s }) => s) }, null, 1));

// ---- เบราว์เซอร์นักเรียน: 5 โปรเซส × 10 บริบท (แยกคุกกี้/ที่เก็บข้อมูล) ----
const pool = [];
for (let k = 0; k < Math.ceil(N / 10); k++) pool.push(await browser());

function watch(page, who) {
  page.on('pageerror', (e) => fail(who, `pageerror ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::ERR_FAILED/.test(m.text())) fail(who, `console ${m.text()}`); });
  page.on('response', (r) => { if (r.status() >= 500) fail(who, `HTTP ${r.status()} ${r.request().method()} ${r.url()}`); });
}

async function login(page, kind, id, pw) {
  await page.goto(`${base}${kind === 'staff' ? '/login/staff' : '/login'}`);
  await page.getByLabel(kind === 'staff' ? 'ชื่อผู้ใช้' : 'รหัสนักเรียน').fill(id);
  await page.getByLabel('รหัสผ่าน', { exact: true }).fill(pw);
  await page.getByRole('button', { name: 'เข้าใช้งาน' }).click();
}

/** กรอกฟอร์มสมุดรายวันหนึ่งรายการ (ยังไม่กดผ่านรายการ) */
async function fillEntry(page, s, it) {
  const wrong = s.wrong[it.no];
  const date = wrong === 'date' ? '2026-10-04' : it.date;
  await page.getByLabel('วันที่', { exact: true }).fill(thaiDate(date));
  await page.getByLabel('คำอธิบายรายการ').fill(`ข้อ ${it.no} ${it.text}`);
  const lines = it.lines.map(([c, a, side]) => [wrong === 'account' && c === '5110' ? '5260' : c, wrong === 'amount' ? (a === '4500' ? '4050' : a) : a, side]);
  for (let k = 2; k < lines.length; k++) await page.getByRole('button', { name: 'เพิ่มบรรทัด' }).click();
  const money = page.locator('input[inputmode=decimal]');
  for (const [k, [code, amt, side]] of lines.entries()) {
    const box = page.getByRole('combobox', { name: `รหัสบัญชี ${k + 1}` });
    await box.fill(code);
    await page.getByRole('option', { name: new RegExp(`^${code}`) }).first().click();
    await money.nth(k * 2 + (side === 'D' ? 0 : 1)).fill(amt);
    await jitter(50, 250); // คนพิมพ์จริง
  }
}

async function post(page, s, it, home) {
  const btn = page.getByRole('button', { name: /ผ่านรายการ/ });
  const posted = page.getByText(/ผ่านรายการเลขที่ JV-\d{4}/);
  if (s.lostResponse && it.no === 2) {
    // เน็ตหลุดหลังเซิร์ฟเวอร์บันทึกแล้ว: คำขอถึงเซิร์ฟเวอร์ แต่คำตอบไม่ถึงเบราว์เซอร์ → กดใหม่ต้องได้รายการเดิม ไม่ซ้ำ
    let once = false;
    await page.route('**/api/companies/*/journal', async (route) => {
      if (once || route.request().method() !== 'POST') return route.continue();
      once = true;
      await route.fetch();
      await route.abort('connectionreset');
    });
    await btn.click();
    await page.getByRole('alert').filter({ hasText: /เชื่อมต่อ|อินเทอร์เน็ต|ลองใหม่/ }).first().waitFor({ timeout: 15_000 });
    await page.unroute('**/api/companies/*/journal');
    await time('student.post', async () => { await btn.click(); await posted.waitFor({ timeout: 30_000 }); });
    return;
  }
  await time('student.post', async () => {
    if (s.dblPost) await btn.dblclick(); else await btn.click();
    await posted.waitFor({ timeout: 30_000 });
  });
  void home;
}

const results = new Map(); // code → { companyId, ... }
let submitGate; const gate = new Promise((r) => { submitGate = r; });
let enteredCount = 0;

async function studentRun(s) {
  const b = pool[s.i % pool.length];
  const ctx = await b.newContext({ viewport: s.device.viewport, isMobile: s.device.isMobile, hasTouch: s.device.hasTouch, locale: 'th-TH', timezoneId: 'Asia/Bangkok' });
  const page = await ctx.newPage();
  const who = `${s.code}(${s.device.name})`;
  watch(page, who);
  page.setDefaultTimeout(30_000);
  const r = { code: s.code, device: s.device.name, expected: s.expected, wrong: s.wrong };
  results.set(s.code, r);
  try {
    await jitter(0, 8000); // ทยอยเข้าห้องใน 8 วินาทีแรกของคาบ
    await time('student.login', async () => { await login(page, 'student', s.code, s.password); await page.waitForURL(/\/c\/[0-9a-f-]{36}$/, { timeout: 60_000 }); });
    const home = new URL(page.url()).pathname;
    r.companyId = home.split('/').pop();
    await time('student.openWork', async () => { await page.goto(`${base}${home}/work`); await page.getByText(ITEMS[0].text).first().waitFor(); });
    for (const it of ITEMS) {
      await jitter(300, 1500); // อ่านโจทย์
      if (s.twoTabs && it.no === 6) {
        const p2 = await ctx.newPage(); watch(p2, `${who}#2`);
        await p2.goto(`${base}${home}/journal/new`);
        await fillEntry(p2, s, it);
        await post(p2, s, it, home);
        await p2.close();
        continue;
      }
      await time('student.openForm', async () => { await page.goto(`${base}${home}/journal/new`); await page.getByLabel('คำอธิบายรายการ').waitFor(); });
      await fillEntry(page, s, it);
      if (s.reloadMid && it.no === 4) {
        await page.reload(); // รีโหลดกลางฟอร์ม: ร่างต้องไม่ถูกผ่านรายการเอง กรอกใหม่แล้วผ่านรายการ
        await page.getByLabel('คำอธิบายรายการ').waitFor();
        const restored = await page.getByLabel('คำอธิบายรายการ').inputValue();
        r.draftRestored = restored.includes(`ข้อ ${it.no}`);
        if (!r.draftRestored) await fillEntry(page, s, it);
      }
      await post(page, s, it, home);
    }
    enteredCount++;
    log(`ลงครบ ${enteredCount}/${N}`);
    await gate; // ส่งตรวจพร้อมกันทั้งห้อง
    await page.goto(`${base}${home}`);
    const submit = page.getByRole('button', { name: 'ส่งตรวจ (หลังส่งแก้ไม่ได้)' });
    await submit.click();
    await time('student.submit', async () => {
      const confirm = page.getByRole('button', { name: 'ยืนยันส่งตรวจ' });
      if (s.dblSubmit) await confirm.dblclick(); else await confirm.click();
      await page.getByText('งานนี้ส่งตรวจแล้ว แก้ไขไม่ได้จนกว่าครูจะส่งกลับให้แก้').waitFor({ timeout: 60_000 });
    });
    // หลังส่ง: ลงรายการเพิ่มไม่ได้ (ล็อกที่ DB)
    const lockedTry = await ctx.request.post(`${base}/api/companies/${r.companyId}/journal`, { headers: { origin: base, 'idempotency-key': randomUUID() },
      data: { date: '2026-10-25', description: 'แอบลงหลังส่ง', lines: [{ account_code: '1110', debit: '1' }, { account_code: '3110', credit: '1' }] } });
    r.postAfterSubmit = lockedTry.status();
    if (lockedTry.status() < 400) fail(who, `ลงรายการหลังส่งตรวจได้ (${lockedTry.status()})`);

    // ครูส่งกลับ → แก้ข้อที่ผิดด้วย "แก้ไขรายการ" แล้วส่งใหม่
    if (s.expected < MAX) {
      await time('student.waitReturned', async () => {
        for (;;) {
          await sleep(3000 + Math.random() * 2000);
          await page.goto(`${base}${home}`);
          if (await page.getByText('ครูส่งกลับให้แก้ แก้ตามคอมเมนต์แล้วส่งตรวจอีกครั้ง').count()) break;
        }
      });
      const entries = await (await ctx.request.get(`${base}/api/companies/${r.companyId}/journal`)).json();
      for (const [no, kind] of Object.entries(s.wrong)) {
        if (!kind) continue;
        const it = ITEMS[no - 1];
        const e = entries.find((x) => (x.description ?? '').startsWith(`ข้อ ${no} `) && !x.reversedBy && !x.reverses);
        if (!e) { fail(who, `หารายการข้อ ${no} ไม่เจอ`); continue; }
        await time('student.fix', async () => {
          await page.goto(`${base}${home}/journal/${e.id}`);
          await page.getByRole('link', { name: 'แก้ไขรายการ' }).click();
          await page.getByLabel('คำอธิบายรายการ').waitFor();
          await page.getByLabel('วันที่', { exact: true }).fill(thaiDate(it.date));
          const money = page.locator('input[inputmode=decimal]');
          for (const [k, [code, amt, side]] of it.lines.entries()) {
            const box = page.getByRole('combobox', { name: `รหัสบัญชี ${k + 1}` });
            await box.fill(code);
            await page.getByRole('option', { name: new RegExp(`^${code}`) }).first().click();
            await money.nth(k * 2 + (side === 'D' ? 0 : 1)).fill(amt);
            await money.nth(k * 2 + (side === 'D' ? 1 : 0)).fill('');
          }
          await page.getByRole('button', { name: /ผ่านรายการ/ }).click();
          await page.waitForURL(/\/journal\/[0-9a-f-]{36}$/);
        });
      }
      await page.goto(`${base}${home}`);
      await page.getByRole('button', { name: 'ส่งตรวจ (หลังส่งแก้ไม่ได้)' }).click();
      await time('student.resubmit', async () => {
        await page.getByRole('button', { name: 'ยืนยันส่งตรวจ' }).click();
        await page.getByText('งานนี้ส่งตรวจแล้ว แก้ไขไม่ได้จนกว่าครูจะส่งกลับให้แก้').waitFor({ timeout: 60_000 });
      });
      r.resubmitted = true;
    }
    r.ok = true;
  } catch (e) {
    fail(who, e.stack ?? e);
    await page.screenshot({ path: `${out}/fail-${s.code}.png`, fullPage: true }).catch(() => {});
  } finally {
    r.done = true;
    await ctx.close();
  }
}

// ---- ครู: ดูหน้ารวมห้องสดระหว่างคาบ แล้วตรวจทุกคนผ่านหน้าจอ ----
const tpage = await tctx.newPage();
watch(tpage, 'ครู');
tpage.setDefaultTimeout(30_000);
await time('teacher.login', async () => { await login(tpage, 'staff', teacherUser, teacherPw); await tpage.waitForURL('**/teacher'); });

let studentsDone = false;
async function teacherWatch() {
  // หน้ารวมห้องแบบสด (WebSocket) เปิดค้าง + เปิดดูสดนักเรียนสุ่มเป็นระยะ
  const live = await tctx.newPage(); watch(live, 'ครู(ดูสด)');
  await live.goto(`${base}/teacher/live/${room.id}`);
  while (!studentsDone && enteredCount < N) {
    await sleep(5000);
    const r = [...results.values()].filter((x) => x.companyId);
    if (r.length) {
      const pick = r[Math.floor(Math.random() * r.length)];
      await time('teacher.reviewPage', () => tpage.goto(`${base}/teacher/review/${pick.companyId}`)).catch((e) => fail('ครู', e));
    }
  }
  await live.close();
}

async function review(r, round) {
  await time('teacher.reviewPage', () => tpage.goto(`${base}/teacher/review/${r.companyId}`));
  const panel = tpage.getByRole('region', { name: 'การส่งงาน' }).or(tpage.locator('section').filter({ hasText: 'ส่งตรวจ' }).first());
  void panel;
  // คะแนนตรวจอัตโนมัติที่ครูเห็นต้องตรงกับที่คาด (รอบแรก = ตามที่ตั้งใจผิด, รอบสอง = เต็ม)
  const want = round === 1 ? r.expected : MAX;
  const scoreText = await tpage.getByText(new RegExp(`ได้ [\\d.]+ จาก ${MAX}\\.00 คะแนน`)).first().textContent({ timeout: 15_000 }).catch(() => null);
  const got = scoreText ? Number(scoreText.match(/ได้ ([\d.]+)/)[1]) : null;
  r[`autoScore${round}`] = got;
  if (got !== want) fail('ครู', `${r.code} รอบ ${round}: คะแนนอัตโนมัติ ${got} ไม่ตรงที่คาด ${want}`);
  if (await tpage.getByRole('button', { name: 'เริ่มตรวจ' }).count()) await time('teacher.startReview', async () => {
    await tpage.getByRole('button', { name: 'เริ่มตรวจ' }).click();
    await tpage.getByText('ครูกำลังตรวจ', { exact: true }).first().waitFor();
    await tpage.getByRole('button', { name: 'เริ่มตรวจ' }).waitFor({ state: 'detached' });
  });
  if (round === 1 && r.expected < MAX) {
    const nos = Object.entries(r.wrong).filter(([, w]) => w).map(([no]) => no).join(', ');
    await tpage.getByLabel(/คอมเมนต์ถึงนักเรียน/).fill(`ข้อ ${nos} ยังไม่ถูก ตรวจบัญชี จำนวนเงิน และวันที่อีกครั้ง`);
    await time('teacher.return', async () => {
      await tpage.getByRole('button', { name: 'ส่งกลับให้แก้' }).click();
      await tpage.getByText('ส่งกลับให้แก้', { exact: true }).first().waitFor();
      await tpage.getByRole('button', { name: 'เริ่มตรวจ' }).waitFor({ state: 'detached' });
    });
    r.returned = true;
  } else {
    // ช่องคะแนนต้องเติมคะแนนตรวจอัตโนมัติให้แล้ว (docs/phase4-spec.md ข้อ 3)
    const pre = await tpage.getByLabel(/^คะแนน \(เต็ม/).inputValue();
    r[`prefill${round}`] = pre;
    if (Number(pre) !== want) fail('ครู', `${r.code} รอบ ${round}: ช่องคะแนนเติมไว้ "${pre}" ไม่ใช่ ${want}`);
    await tpage.getByLabel(/^คะแนน \(เต็ม/).fill(String(got ?? want));
    await time('teacher.pass', async () => {
      await tpage.getByRole('button', { name: 'ให้ผ่าน' }).click();
      await tpage.getByRole('button', { name: 'ให้ผ่าน' }).waitFor({ state: 'detached' });
    });
    r.passed = true;
  }
}

async function teacherReviewLoop() {
  const reviewed = new Set();
  const deadline = Date.now() + 25 * 60_000;
  while (Date.now() < deadline) {
    const lr = await tctx.request.get(`${base}/api/teacher/submissions`);
    if (lr.status() !== 200) { fail('ครู', `รายการงานที่ส่ง ${lr.status()} ${(await lr.text()).slice(0, 120)}`); await sleep(3000); continue; }
    const list = await lr.json();
    const waiting = list.filter((x) => (x.status === 'submitted' || x.status === 'reviewing') && [...results.values()].some((r) => r.companyId === x.companyId));
    if (!waiting.length) {
      if ([...results.values()].every((r) => r.done && (!r.ok || r.passed))) break;
      await sleep(2000);
      continue;
    }
    for (const x of waiting) {
      const r = [...results.values()].find((y) => y.companyId === x.companyId);
      const round = reviewed.has(r.code) ? 2 : 1;
      // ครูจริงอ่านงานก่อนกด (3–8 วินาที) · FAST_TEACHER=1 = ตรวจเร็วที่สุดเท่าที่ทำได้ (ทดสอบเพดานคำขอ)
      if (process.env.FAST_TEACHER !== '1') await jitter(3000, 8000);
      try { await review(r, round); reviewed.add(r.code); } catch (e) { fail('ครู', `${r.code} รอบ ${round}: ${e.stack ?? e}`); await tpage.screenshot({ path: `${out}/fail-teacher-${r.code}.png`, fullPage: true }).catch(() => {}); }
    }
  }
}

// ---- เดินคาบเรียน ----
log('เริ่มคาบ: นักเรียนทยอยเข้า');
const runs = students.map((s) => studentRun(s));
const watcher = teacherWatch();
// เปิดประตูส่งตรวจเมื่อทุกคน (ที่ยังไม่พัง) ลงครบ หรือครบ 15 นาที
(async () => {
  const until = Date.now() + 15 * 60_000;
  while (Date.now() < until && enteredCount < N - [...results.values()].filter((r) => r.done && !r.ok).length) await sleep(500);
  log(`ส่งตรวจพร้อมกัน (${enteredCount} คนลงครบ)`);
  studentsDone = true;
  submitGate();
})();
await watcher;
await gate;
const reviewer = teacherReviewLoop();
await Promise.all(runs);
await reviewer;
log('จบคาบ');

// ---- สรุป ----
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)] : null; };
const summary = Object.fromEntries(Object.entries(timings).map(([k, a]) => [k, {
  n: a.length, p50: Math.round(pct(a, 0.5)), p95: Math.round(pct(a, 0.95)), max: Math.round(Math.max(...a)) }]));
const res = [...results.values()];
const report = {
  run: RUN, students: N, durationSec: Math.round((Date.now() - t0) / 1000),
  completed: res.filter((r) => r.ok).length, passed: res.filter((r) => r.passed).length, returned: res.filter((r) => r.returned).length,
  scoreMismatch: res.filter((r) => r.autoScore1 !== undefined && r.autoScore1 !== r.expected).map((r) => r.code),
  timings: summary, problems, results: res,
};
writeFileSync(`${out}/report.json`, JSON.stringify(report, null, 1));
log(JSON.stringify({ completed: report.completed, passed: report.passed, returned: report.returned, problems: problems.length, scoreMismatch: report.scoreMismatch.length }));
console.table(summary);
for (const b of browsers) await b.close();
process.exit(problems.length ? 1 : 0);
