import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../apps/api/src/app';
import { devAuth } from '../apps/api/src/auth';
import { authConfigFromEnv } from '../apps/api/src/config';
import { createPool } from '../apps/api/src/db';
import { apiUrl } from './global-setup';
import { pool as db, newSchool, newUser, newClassroom, newCompany, taxId } from './helpers';

// ทดสอบสุ่มข้ามโมดูล: ซื้อ/ขาย/ลดหนี้/ยกเลิก/รับ-จ่ายชำระพร้อมส่วนลด/ปรับสต็อก/โอนคลัง (FIFO + ถัวเฉลี่ย, ลงย้อนวันที่)
// โอนเงิน เงินสดย่อย สินทรัพย์รายเดือน/รายวัน แล้วตรวจว่าบัญชีแยกประเภทตรงกับทะเบียนย่อยทุกตัว
// · ANALYZE ก่อนสร้างบริษัท = บริษัทใหม่ที่สถิติยังไม่รู้จัก (กรณีจริงของนักเรียน) ทุกคำขอต้องเสร็จใน 3 วินาที
//   (เดิมงบการเงิน/กระดาษทำการ/สมุดรายวันของบริษัทแบบนี้ค้างหลายนาที)
const apiPool = createPool(apiUrl());
const app = buildApp({ pool: apiPool, auth: devAuth(), limiter: { hit: async () => 0 }, cfg: { ...authConfigFromEnv({}), allowedOrigins: false } });
afterAll(async () => { await app.close(); await apiPool.end(); await db.end(); });

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT';
function rng(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

async function scenario(seed: number, vat: boolean) {
  const R = rng(seed);
  const int = (a: number, b: number) => a + Math.floor(R() * (b - a + 1));
  const pick = <T,>(xs: T[]) => xs[Math.floor(R() * xs.length)];
  const day = () => `2026-0${int(1, 6)}-${String(int(1, 28)).padStart(2, '0')}`;
  await db.query('analyze'); // สถิติเก็บก่อนมีบริษัทนี้ = บริษัทใหม่ของนักเรียนตามจริง
  const school = await newSchool();
  const teacher = await newUser(school, 'teacher');
  const owner = await newUser(school, 'student');
  const co = await newCompany(owner, await newClassroom(school, teacher, [owner]));
  const slow: string[] = [];
  const call = async (method: Method, url: string, payload?: unknown) => {
    const t0 = Date.now();
    const r = await app.inject({ method, url: `/companies/${co}${url}`, payload: payload as object, headers: { 'x-dev-user-id': owner, 'x-dev-role': 'student', 'idempotency-key': randomUUID() } });
    if (Date.now() - t0 > 3000) slow.push(`${method} ${url} ${Date.now() - t0} ms`);
    return r;
  };
  const log: string[] = [];
  const errors: Record<string, number> = {};
  const unexpected: string[] = [];
  async function tryOp(name: string, method: Method, url: string, payload?: unknown) {
    const r = await call(method, url, payload);
    if (r.statusCode < 300) { log.push(`${name} ${JSON.stringify(payload)}`); return r.json(); }
    if (r.statusCode >= 500) unexpected.push(`${name} ${r.statusCode} ${r.body} ${JSON.stringify(payload)}`);
    const k = `${name}:${r.json().message ?? r.statusCode}`.replace(/[0-9.,]+/g, '#');
    errors[k] = (errors[k] ?? 0) + 1;
    return null;
  }
  const must = async (method: Method, url: string, payload?: unknown) => {
    const r = await call(method, url, payload);
    if (r.statusCode >= 300) throw new Error(`${url} ${r.statusCode} ${r.body}`);
    return r.json();
  };
  const prof = await must('GET', '/profile');
  await must('PATCH', '/profile', { version: prof.version, taxId: taxId(seed), vatRegistered: vat });
  await must('POST', '/parties', { code: 'C1', name: 'ลูกค้า', isCustomer: true, isVendor: false, taxId: taxId(seed + 1), vatRegistered: true });
  await must('POST', '/parties', { code: 'V1', name: 'ผู้ขาย', isCustomer: false, isVendor: true, taxId: taxId(seed + 2), vatRegistered: true });
  await must('POST', '/items', { code: 'F', name: 'สินค้า FIFO', unit: 'ชิ้น', isService: false, trackInventory: true, costMethod: 'fifo' });
  await must('POST', '/items', { code: 'A', name: 'สินค้าถัวเฉลี่ย', unit: 'ชิ้น', isService: false, trackInventory: true });
  await must('POST', '/items', { code: 'S', name: 'บริการ', unit: 'งาน', isService: true });
  await must('POST', '/warehouses', { code: 'W2', name: 'คลังสอง' });
  await must('POST', '/journal', { date: '2026-01-01', description: 'ทุน', lines: [{ account_code: '1110', debit: '500000' }, { account_code: '3110', credit: '500000' }] });
  await must('POST', '/petty-cash/fund', { date: '2026-01-02', fund: '5000', custodian: 'สมชาย' });
  // สินทรัพย์ถาวร: รายเดือน + รายวัน ได้มาระหว่างเดือน ลงค่าเสื่อม ม.ค.–พ.ค. ขายตัวหนึ่ง มิ.ย.
  const fa1 = await must('POST', '/fixed-assets', { code: 'FA1', name: 'คอมพิวเตอร์', acquiredDate: '2026-01-10', cost: '36000.00', salvage: '1', lifeMonths: 36, assetAccount: '1630', accumAccount: '1631', counterAccount: '1110' });
  const fa2 = await must('POST', '/fixed-assets', { code: 'FA2', name: 'รถตู้', acquiredDate: '2026-01-15', cost: '36500', lifeMonths: 12, depMethod: 'daily', assetAccount: '1630', accumAccount: '1631', counterAccount: '1110' });
  for (const month of ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05']) await must('POST', '/depreciation', { month });
  await must('POST', `/fixed-assets/${(R() < 0.5 ? fa1 : fa2).id}/dispose`, { date: '2026-06-10', proceeds: '30000', proceedsAccount: '1110', partyCode: 'C1' });
  const items = ['F', 'A'];
  const whs = [undefined, 'W2'];
  const sales: { id: string }[] = [], buys: { id: string }[] = [], vouchers: string[] = [];
  const money = (a: number, b: number) => `${int(a, b)}.${pick(['00', '25', '50', '33', '99'])}`;
  for (let i = 0; i < Number(process.env.FUZZ_OPS ?? 120); i++) {
    const op = int(0, 15);
    if (op <= 2) {
      const r = await tryOp('ซื้อ', 'POST', '/purchases/invoice', { date: day(), partyCode: 'V1', vendorDocNo: `B${i}`, warehouse: pick(whs),
        discount: R() < 0.3 ? money(1, 30) : undefined, priceMode: R() < 0.3 ? 'inclusive' : undefined,
        lines: [{ itemCode: pick(items), qty: String(int(1, 20)), unitPrice: money(40, 200) }, ...(R() < 0.4 ? [{ itemCode: 'F', qty: String(int(1, 5)), unitPrice: money(40, 200) }].filter(() => true) : [])].filter((l, k, a) => a.findIndex((x) => x.itemCode === l.itemCode) === k) });
      if (r) buys.push(r);
    } else if (op <= 5) {
      const r = await tryOp('ขาย', 'POST', '/sales/invoice', { date: day(), partyCode: 'C1', warehouse: pick(whs), discount: R() < 0.3 ? money(1, 30) : undefined,
        lines: [{ itemCode: pick(items), qty: String(int(1, 6)), unitPrice: money(150, 400) }, ...(R() < 0.3 ? [{ itemCode: 'S', qty: '1', unitPrice: money(100, 900) }] : [])] });
      if (r) sales.push(r);
    } else if (op === 6) {
      await tryOp('ปรับสต็อก', 'POST', '/inventory/adjustments', R() < 0.5
        ? { itemCode: pick(items), date: day(), quantity: `-${int(1, 3)}`, offsetAccount: '5130', warehouse: pick(whs) }
        : { itemCode: pick(items), date: day(), quantity: String(int(1, 5)), unitCost: money(30, 150), offsetAccount: '3110', warehouse: pick(whs) });
    } else if (op === 7) {
      const from = R() < 0.5;
      await tryOp('โอนคลัง', 'POST', '/inventory/transfers', { date: day(), from: from ? 'MAIN' : 'W2', to: from ? 'W2' : 'MAIN', lines: [{ itemCode: pick(items), qty: String(int(1, 4)) }] });
    } else if (op === 8 && sales.length) {
      const s = pick(sales);
      const d = await must('GET', `/sales/documents/${s.id}`);
      const l = d.lines.find((x: { itemCode: string }) => x.itemCode !== 'S') ?? d.lines[0];
      await tryOp('ลดหนี้ขาย', 'POST', '/sales/credit-note', { date: day(), refDocumentId: s.id, reason: 'คืน', lines: [{ itemCode: l.itemCode, qty: '1', unitPrice: l.unitPrice }] });
    } else if (op === 9 && buys.length) {
      const b = pick(buys);
      const d = await must('GET', `/purchases/documents/${b.id}`);
      const l = d.lines[0];
      await tryOp('ลดหนี้ซื้อ', 'POST', '/purchases/credit-note', { date: day(), refDocumentId: b.id, vendorDocNo: `CN${i}`, reason: 'คืน', lines: [{ itemCode: l.itemCode, qty: '1', unitPrice: l.unitPrice }] });
    } else if (op === 10 && (sales.length || buys.length)) {
      if (R() < 0.5 && sales.length) await tryOp('ยกเลิกขาย', 'POST', `/sales/documents/${pick(sales).id}/void`, { date: '2026-06-28', reason: 'ผิด' });
      else if (buys.length) await tryOp('ยกเลิกซื้อ', 'POST', `/purchases/documents/${pick(buys).id}/void`, { date: '2026-06-28', reason: 'ผิด' });
    } else if (op === 11 && sales.length) {
      const s = pick(sales);
      const d = await must('GET', `/sales/documents/${s.id}`);
      if (Number(d.open) > 0) {
        const disc = R() < 0.5 ? (Math.min(Number(d.open), int(1, 50))).toFixed(2) : undefined;
        const amt = (Number(d.open) - Number(disc ?? 0)).toFixed(2);
        if (Number(amt) > 0) await tryOp('รับชำระ', 'POST', '/receipts', { date: '2026-06-' + String(int(1, 27)).padStart(2, '0'), partyCode: 'C1', cashAccount: '1110', allocations: [{ documentId: s.id, amount: amt, discount: disc }] });
      }
    } else if (op === 12 && buys.length) {
      const b = pick(buys);
      const d = await must('GET', `/purchases/documents/${b.id}`);
      if (Number(d.open) > 0) {
        const disc = R() < 0.5 ? (Math.min(Number(d.open), int(1, 50))).toFixed(2) : undefined;
        const amt = (Number(d.open) - Number(disc ?? 0)).toFixed(2);
        if (Number(amt) > 0) await tryOp('จ่ายชำระ', 'POST', '/payments', { date: '2026-06-' + String(int(1, 27)).padStart(2, '0'), partyCode: 'V1', cashAccount: '1110', allocations: [{ documentId: b.id, amount: amt, discount: disc }] });
      }
    } else if (op === 13) {
      await tryOp('โอนเงิน', 'POST', '/cash-transfers', { date: day(), from: pick(['1110', '1120']), to: pick(['1120', '1130']), amount: money(100, 3000), fee: R() < 0.5 ? '25' : undefined });
    } else if (op === 14) {
      const v = await tryOp('ใบสำคัญเงินสดย่อย', 'POST', '/petty-cash/vouchers', { date: day(), payee: 'ร้านค้า', description: 'ของใช้', account: pick(['5260', '5230']), amount: money(10, 800) });
      if (v) vouchers.push(v.id);
    } else if (op === 15 && vouchers.length) {
      await tryOp('เบิกชดเชย', 'POST', '/petty-cash/reimbursements', { date: '2026-06-28', voucherIds: vouchers.splice(0, int(1, vouchers.length)) });
    }
  }

  // ---- ตรวจความสอดคล้อง ----
  const q = async (sql: string, p: unknown[] = [co]) => (await db.query(sql, p)).rows;
  const one = async (sql: string, p: unknown[] = [co]) => (await q(sql, p))[0];
  const problems: string[] = [...unexpected, ...slow];
  const gl = async (code: string) => (await one(`select coalesce(sum(l.debit - l.credit), 0)::numeric(18,2)::text v from acc.journal_lines l join acc.chart_of_accounts a on a.company_id = l.company_id and a.id = l.account_id where l.company_id = $1 and a.code = $2`, [co, code])).v;
  const tb = await one(`select sum(debit)::text d, sum(credit)::text c from acc.journal_lines where company_id = $1`);
  if (tb.d !== tb.c) problems.push(`งบทดลองไม่ดุล ${tb.d} ${tb.c}`);
  const card = await one(`select coalesce(sum(eff_value), 0)::numeric(18,2)::text v from acc.inventory_movements_effective where company_id = $1 and live`);
  const g1310 = await gl('1310');
  if (card.v !== g1310) problems.push(`1310 ${g1310} ≠ บัตรสต็อก ${card.v}`);
  for (const code of items) {
    const inv = await must('GET', `/inventory/${code}`);
    const rows = await q(`select m.movement_date::text d, m.quantity::numeric q, m.eff_value::numeric v from acc.inventory_movements_effective m join acc.items i on i.company_id = m.company_id and i.id = m.item_id
                           where m.company_id = $1 and i.code = $2 and m.live order by m.movement_date, m.created_at, m.id`, [co, code]);
    let qq = 0, vv = 0;
    for (const r of rows) { qq += Number(r.q); vv += Number(r.v); if (qq < -1e-9) problems.push(`${code} ติดลบ ${r.d}`); if (qq === 0 && Math.abs(vv) > 0.004) problems.push(`${code} จำนวน 0 แต่มูลค่า ${vv.toFixed(2)} ณ ${r.d}`); if (vv < -0.004) problems.push(`${code} มูลค่าติดลบ ${vv.toFixed(2)} ณ ${r.d}`); }
    if (code === 'F') {
      const ls = inv.layers.reduce((s: number, l: { value: string }) => s + Number(l.value), 0);
      if (Math.abs(ls - vv) > 0.004) problems.push(`F ชั้น FIFO ${ls.toFixed(2)} ≠ มูลค่า ${vv.toFixed(2)}`);
      const lq = inv.layers.reduce((s: number, l: { qty: string }) => s + Number(l.qty), 0);
      if (Math.abs(lq - qq) > 1e-9) problems.push(`F จำนวนชั้น ${lq} ≠ ${qq}`);
      if (inv.layers.some((l: { value: string }) => Number(l.value) < 0)) problems.push(`F ชั้นมูลค่าติดลบ ${JSON.stringify(inv.layers)}`);
    }
    const wh = await q(`select w.code, sum(m.quantity)::numeric q from acc.items i cross join lateral acc.warehouse_movements(i.company_id, i.id) m join acc.warehouses w on w.company_id = i.company_id and w.id = m.warehouse_id
                         where i.company_id = $1 and i.code = $2 group by w.code`, [co, code]);
    const tot = wh.reduce((s, r) => s + Number(r.q), 0);
    if (Math.abs(tot - qq) > 1e-9) problems.push(`${code} รวมคลัง ${tot} ≠ ${qq}`);
    for (const r of wh) if (Number(r.q) < 0) problems.push(`${code} คลัง ${r.code} ติดลบ ${r.q}`);
    // คำนวณซ้ำต้องไม่เปลี่ยนอะไร
    const c = await db.connect();
    try {
      await c.query('begin'); await c.query(`select set_config('app.user_id', $1, true)`, [owner]);
      const n = (await c.query(`select acc.restate_inventory_item($1, (select id from acc.items where company_id = $1 and code = $2), 'ตรวจ') n`, [co, code])).rows[0].n;
      if (n !== 0) problems.push(`${code} คำนวณซ้ำแล้วเปลี่ยน ${n} รายการ`);
    } finally { await c.query('rollback'); c.release(); }
  }
  const ar = await one(`select coalesce(sum(open), 0)::numeric(18,2)::text v from acc.ar_open_items($1)`);
  const g1210 = await gl('1210');
  if (ar.v !== g1210) problems.push(`ลูกหนี้ 1210 ${g1210} ≠ ยอดค้าง ${ar.v}`);
  const ap = await one(`select coalesce(sum(open), 0)::numeric(18,2)::text v from acc.ap_open_items($1)`);
  const g2110 = await gl('2110');
  if ((-Number(ap.v)).toFixed(2) !== Number(g2110).toFixed(2)) problems.push(`เจ้าหนี้ 2110 ${g2110} ≠ ยอดค้าง ${ap.v}`);
  const und = await one(`select coalesce(sum(undue_vat), 0)::numeric(18,2)::text v from acc.ar_open_items($1)`);
  const g2211 = await gl('2211');
  if ((-Number(und.v)).toFixed(2) !== Number(g2211).toFixed(2)) problems.push(`ภาษีขายยังไม่ถึงกำหนด 2211 ${g2211} ≠ ${und.v}`);
  const pc = await one(`select fund::text f from acc.petty_cash_status($1)`);
  if (Number(pc.f).toFixed(2) !== Number(await gl('1140')).toFixed(2)) problems.push(`เงินสดย่อย ${pc.f} ≠ GL`);
  for (let m = 1; m <= 6; m++) {
    const rows = await q(`select status, vat::numeric v from acc.vat_report($1, $2, 'sales')`, [co, `2026-0${m}-01`]);
    const rowsP = await q(`select status, vat::numeric v from acc.vat_report($1, $2, 'purchases')`, [co, `2026-0${m}-01`]);
    const mv = await one(`select (-acc.account_movement($1, '2210', $2::date, ($2::date + interval '1 month - 1 day')::date))::numeric(18,2)::text s,
                                acc.account_movement($1, '1410', $2::date, ($2::date + interval '1 month - 1 day')::date)::numeric(18,2)::text p`, [co, `2026-0${m}-01`]);
    const sumS = rows.reduce((s, r) => s + Number(r.v), 0), sumP = rowsP.reduce((s, r) => s + Number(r.v), 0);
    if (sumS.toFixed(2) !== Number(mv.s).toFixed(2)) problems.push(`ภาษีขาย ${m}/2569 รายงาน ${sumS.toFixed(2)} ≠ GL ${mv.s} [${[...new Set(rows.map((r) => r.status))]}]`);
    if (sumP.toFixed(2) !== Number(mv.p).toFixed(2)) problems.push(`ภาษีซื้อ ${m}/2569 รายงาน ${sumP.toFixed(2)} ≠ GL ${mv.p} [${[...new Set(rowsP.map((r) => r.status))]}]`);
  }
  for (const u of ['/trial-balance?month=2026-06', '/trial-balance?month=2026-06&stage=after', '/ledger?month=2026-06&account=1110', '/ledger-accounts?month=2026-06',
    '/worksheet?month=2026-06', '/receivables', '/payables', '/tax/vat?month=2026-06', '/tax/wht?month=2026-06', '/inventory', '/inventory/F', '/journal',
    '/fixed-assets?month=2026-06', '/petty-cash', '/cash-transfers', '/deposits', '/purchase-deposits', '/periods', '/sales', '/purchases', '/fiscal-years',
    '/statements?month=2026-03&scope=month', '/inventory/transfers', '/warehouses', '/opening', '/chart', '/accounts', '/ending-inventory', '/billing-notes',
    '/sales-orders', '/purchase-orders', '/goods-receipts/open', '/bank-reconciliation', '/cheques', '/live']) {
    const r = await call('GET', u);
    if (r.statusCode >= 500) problems.push(`GET ${u} ${r.statusCode}`);
  }
  // ทะเบียนสินทรัพย์ = GL
  const reg = await one(`select coalesce(sum(cost) filter (where status not in ('disposed', 'voided')), 0)::numeric(18,2)::text c,
                                coalesce(sum(accumulated) filter (where status not in ('disposed', 'voided')), 0)::numeric(18,2)::text a from acc.fixed_asset_register($1, '2026-06-01')`);
  if (Number(reg.c).toFixed(2) !== Number(await gl('1630')).toFixed(2)) problems.push(`ทะเบียนทุน ${reg.c} ≠ 1630 ${await gl('1630')}`);
  if ((-Number(reg.a)).toFixed(2) !== Number(await gl('1631')).toFixed(2)) problems.push(`ทะเบียนค่าเสื่อมสะสม ${reg.a} ≠ 1631 ${await gl('1631')}`);
  const st = await must('GET', '/statements?month=2026-06&scope=ytd');
  if (!st.balanced) problems.push(`งบการเงินไม่ดุล`);
  if (st.multiStep.netIncome !== st.netIncome) problems.push(`กำไรหลายขั้น ${st.multiStep.netIncome} ≠ ${st.netIncome}`);
  problems.push(...slow.filter((x) => !problems.includes(x)));
  return { problems, errors, ops: log.length };
}

describe('ทดสอบสุ่มข้ามโมดูล', () => {
  for (const [seed, vat] of [[11, true], [22, false], [33, true], [44, true], [55, false], [66, true]] as const) {
    it(`seed ${seed} vat=${vat}`, async () => {
      const r = await scenario(seed, vat);
      expect(r.ops).toBeGreaterThan(40);
      expect(r.problems).toEqual([]);
    }, 300_000);
  }
});
