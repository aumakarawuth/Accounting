import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../apps/api/src/app';
import { devAuth } from '../apps/api/src/auth';
import { authConfigFromEnv } from '../apps/api/src/config';
import { createPool } from '../apps/api/src/db';
import { apiUrl } from './global-setup';
import { pool as db, newSchool, newUser, newClassroom, newCompany, taxId } from './helpers';

// ทดสอบทั้งระบบผ่าน API (docs/full-system-test.md): บริษัทเดียวทำครบทุกโมดูลในเดือนเดียว
// แล้วตรวจความถูกต้องทางบัญชีทุกยอดคุม + กรณีผิด (ข้อมูลไม่ครบ ไม่ดุล สิทธิ์ ข้ามบริษัท กดซ้ำ เน็ตหลุด)
const apiPool = createPool(apiUrl());
const app = buildApp({ pool: apiPool, auth: devAuth(), cfg: { ...authConfigFromEnv({}), allowedOrigins: false } });
afterAll(async () => { await app.close(); await apiPool.end(); await db.end(); });

const roles = new Map<string, string>();
type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
const as = (user: string, method: Method, url: string, payload?: unknown, key: string | null = randomUUID()) =>
  app.inject({ method, url, payload: payload as object, headers: {
    'x-dev-user-id': user, 'x-dev-role': roles.get(user) ?? 'student', ...(key ? { 'idempotency-key': key } : {}) } });

/** สตางค์จากสตริงทศนิยม (ไม่ใช้ float) */
const c = (s: string | null | undefined) => {
  const [i, f = ''] = String(s ?? '0').split('.');
  const neg = i.startsWith('-');
  const v = BigInt(i.replace('-', '') || '0') * 100n + BigInt((f + '00').slice(0, 2));
  return neg ? -v : v;
};

/** เลขผู้เสียภาษีนิติบุคคล (ขึ้นต้น 0 → ภ.ง.ด.53) */
function juristicTaxId(seed: number) {
  const first12 = '0' + String(10_000_000_000 + seed).slice(-11);
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(first12[i]) * (13 - i);
  return first12 + ((11 - (sum % 11)) % 10);
}

let teacher: string, teacher2: string, owner: string, other: string, outsider: string, co: string, otherCo: string, room: string;
const M = '2026-10';

beforeAll(async () => {
  const school = await newSchool();
  const school2 = await newSchool();
  teacher = await newUser(school, 'teacher');
  roles.set(teacher, 'teacher');
  owner = await newUser(school, 'student');
  other = await newUser(school, 'student');
  outsider = await newUser(school2, 'student');
  room = await newClassroom(school, teacher, [owner, other]);
  teacher2 = await newUser(school, 'teacher'); // ครูห้องอื่นในโรงเรียนเดียวกัน
  roles.set(teacher2, 'teacher');
  await newClassroom(school, teacher2, []);
  co = await newCompany(owner, room);
  otherCo = await newCompany(other, room);
});

/** ตรวจยอดคุมทั้งหมดของบริษัทเทียบกับทะเบียนย่อย (เรียกหลายครั้งระหว่างสถานการณ์) */
async function checkInvariants(company: string, month = M) {
  // 1) งบทดลองดุล (ทุกบัญชี)
  const tb = (await as(owner, 'GET', `/companies/${company}/trial-balance?month=${month}&all=1`)).json();
  expect(tb.totalDebit, 'งบทดลองต้องดุล').toBe(tb.totalCredit);
  const bal = (code: string) => {
    const r = tb.rows.find((x: { code: string }) => x.code === code);
    return r ? c(r.debit) - c(r.credit) : 0n;
  };
  // 2) account_balances = ผลรวมจากสมุดรายวันจริง ทุกบัญชีทุกงวด
  const diff = await db.query(
    `with j as (select l.account_id, e.period_id, sum(l.debit) d, sum(l.credit) cr
                  from acc.journal_lines l join acc.journal_entries e on e.company_id = l.company_id and e.id = l.entry_id
                 where l.company_id = $1 group by 1, 2)
     select count(*)::int n from acc.account_balances b full join j on j.account_id = b.account_id and j.period_id = b.period_id
      where coalesce(b.company_id, $1) = $1 and (b.company_id = $1 or b.company_id is null)
        and (coalesce(b.debit_total, 0) <> coalesce(j.d, 0) or coalesce(b.credit_total, 0) <> coalesce(j.cr, 0))`, [company]);
  expect(diff.rows[0].n, 'account_balances ต้องตรงสมุดรายวัน').toBe(0);
  // ทุกรายการในสมุดดุลในตัวเอง
  const unbalanced = await db.query(
    `select count(*)::int n from (select entry_id from acc.journal_lines where company_id = $1 group by 1 having sum(debit) <> sum(credit)) x`, [company]);
  expect(unbalanced.rows[0].n).toBe(0);
  // 3) ยอดคุมลูกหนี้ 1210 = ลูกหนี้คงค้างรายใบ · เจ้าหนี้ 2110 = เจ้าหนี้คงค้างรายใบ
  const asOf = `${month}-28`;
  const ar = (await as(owner, 'GET', `/companies/${company}/receivables?asOf=${asOf}`)).json();
  const ap = (await as(owner, 'GET', `/companies/${company}/payables?asOf=${asOf}`)).json();
  const sumOpen = (r: { rows?: { open: string }[]; items?: { open: string }[] }) =>
    (r.rows ?? r.items ?? []).reduce((s, x) => s + c(x.open), 0n);
  expect(bal('1210'), 'ลูกหนี้ 1210 = ทะเบียนลูกหนี้').toBe(sumOpen(ar));
  expect(-bal('2110'), 'เจ้าหนี้ 2110 = ทะเบียนเจ้าหนี้').toBe(sumOpen(ap));
  // 4) สินค้าคงเหลือ 1310 = มูลค่าตามทะเบียนสินค้า (stock card)
  const inv = await db.query(
    `select coalesce(sum(b.value), 0)::text v from acc.items i cross join lateral acc.inventory_balance(i.company_id, i.id) b where i.company_id = $1`, [company]);
  expect(bal('1310'), 'สินค้าคงเหลือ 1310 = stock card').toBe(c(inv.rows[0].v));
  // 5) บัญชีพักเช็ค = เช็คที่ค้างในทะเบียน
  const ch = (await as(owner, 'GET', `/companies/${company}/cheques`)).json();
  const pending = (code: string) => ch.cheques
    .filter((x: { holdingCode: string; status: string }) => x.holdingCode === code && !['cleared', 'bounced', 'cancelled'].includes(x.status))
    .reduce((s: bigint, x: { amount: string }) => s + c(x.amount), 0n);
  expect(bal('1220'), 'เช็ครับ 1220 = ทะเบียน').toBe(pending('1220'));
  expect(bal('1221'), 'เช็ครับล่วงหน้า 1221 = ทะเบียน').toBe(pending('1221'));
  expect(-bal('2120'), 'เช็คจ่าย 2120 = ทะเบียน').toBe(pending('2120'));
  expect(-bal('2121'), 'เช็คจ่ายล่วงหน้า 2121 = ทะเบียน').toBe(pending('2121'));
  // 6) ค่าเสื่อมราคาสะสม = ทะเบียนสินทรัพย์ (รายบัญชี) · ราคาทุน = ทะเบียน
  const fa = (await as(owner, 'GET', `/companies/${company}/fixed-assets?month=${month}`)).json();
  const live = fa.assets.filter((a: { status: string }) => a.status !== 'disposed');
  for (const code of new Set<string>(live.map((a: { accumCode: string }) => a.accumCode))) {
    const reg = live.filter((a: { accumCode: string }) => a.accumCode === code).reduce((s: bigint, a: { accumulated: string }) => s + c(a.accumulated), 0n);
    expect(-bal(code), `ค่าเสื่อมสะสม ${code} = ทะเบียน`).toBe(reg);
  }
  // 7) งบการเงิน: สินทรัพย์ = หนี้สิน + ทุน + กำไรสะสมงวด
  const tbRows: { type: string; debit: string; credit: string }[] = tb.rows;
  const net = (t: string) => tbRows.filter((r) => r.type === t).reduce((s, r) => s + c(r.debit) - c(r.credit), 0n);
  expect(net('asset')).toBe(-(net('liability') + net('equity') + net('revenue') + net('expense')));
  // 8) กระดาษทำการทุกแบบที่เปิด: ทุกคู่คอลัมน์ดุล
  const ws = (await as(owner, 'GET', `/companies/${company}/worksheet?month=${month}`)).json();
  for (const f of ws.formats as number[]) {
    const w = (await as(owner, 'GET', `/companies/${company}/worksheet?month=${month}&format=${f}`)).json();
    for (const k of ['tb', 'adj', 'atb'] as const) expect(w.totals[k].debit, `กระดาษทำการ ${f} ช่อง ${k}`).toBe(w.totals[k].credit);
    expect(w.grand.is.debit).toBe(w.grand.is.credit);
    expect(w.grand.bs.debit).toBe(w.grand.bs.credit);
  }
  return { tb, bal };
}

describe('ทั้งระบบผ่าน API: หนึ่งเดือนของบริษัทจด VAT', () => {
  const ids: Record<string, string> = {};

  it('ข้อมูลหลัก: โปรไฟล์ภาษี ลูกค้า/ผู้ขาย สินค้า/บริการ (+ กรณีผิด)', async () => {
    const prof = (await as(owner, 'GET', `/companies/${co}/profile`)).json();
    const p = await as(owner, 'PATCH', `/companies/${co}/profile`, { version: prof.version, taxId: taxId(1001), address: 'กรุงเทพฯ', vatRegistered: true });
    expect(p.statusCode).toBe(200);
    // เวอร์ชันเก่า (แก้พร้อมกันสองแท็บ) → 409
    expect((await as(owner, 'PATCH', `/companies/${co}/profile`, { version: prof.version, address: 'x' })).statusCode).toBe(409);
    // เลขภาษีหลักตรวจสอบผิด → 400
    expect((await as(owner, 'PATCH', `/companies/${co}/profile`, { version: prof.version + 1, taxId: '1234567890123' })).statusCode).toBe(400);
    const parties = [
      { code: 'C1', name: 'บริษัท ลูกค้า จำกัด', isCustomer: true, isVendor: false, taxId: taxId(2001), vatRegistered: true, creditDays: 30 },
      { code: 'V1', name: 'บริษัท ผู้ขายสินค้า จำกัด', isCustomer: false, isVendor: true, taxId: taxId(3001), vatRegistered: true, creditDays: 30 },
      { code: 'V2', name: 'บริษัท รับจ้าง จำกัด', isCustomer: false, isVendor: true, taxId: juristicTaxId(3002), vatRegistered: true, whtKind: 'service' },
    ];
    for (const x of parties) expect((await as(owner, 'POST', `/companies/${co}/parties`, x)).statusCode).toBe(201);
    expect((await as(owner, 'POST', `/companies/${co}/parties`, parties[0])).statusCode, 'รหัสซ้ำ').toBe(409);
    expect((await as(owner, 'POST', `/companies/${co}/parties`, { code: 'X', name: 'x', isCustomer: false, isVendor: false })).statusCode).toBe(400);
    expect((await as(owner, 'POST', `/companies/${co}/parties`, { code: 'X', name: 'x', isCustomer: true, isVendor: false, vatRegistered: true })).statusCode,
      'จด VAT ต้องมีเลขภาษี').toBe(400);
    for (const x of [
      { code: 'G1', name: 'กระดาษ A4', unit: 'รีม', isService: false, salePrice: '150', purchasePrice: '100' },
      { code: 'S1', name: 'ค่าออกแบบ', unit: 'งาน', isService: true, salePrice: '5000' },
      { code: 'S2', name: 'ค่าบริการทำความสะอาด', unit: 'เดือน', isService: true, purchasePrice: '2000', purchaseAccount: '5260' },
    ]) expect((await as(owner, 'POST', `/companies/${co}/items`, x)).statusCode).toBe(201);
    // ครูแก้ข้อมูลหลักของนักเรียนไม่ได้ · นักเรียนอื่นไม่เห็นบริษัทนี้
    expect((await as(teacher, 'POST', `/companies/${co}/items`, { code: 'T1', name: 't', isService: true })).statusCode).toBe(403);
    expect((await as(other, 'GET', `/companies/${co}/items`)).statusCode).toBe(404);
    expect((await as(outsider, 'GET', `/companies/${co}/parties`)).statusCode).toBe(404);
  });

  it('สมุดรายวัน: ทุนเปิดบริษัท · ไม่ดุล/ไม่ครบ/บัญชีไม่มี · กดซ้ำ · เน็ตหลุดส่งใหม่ · ส่งซ้ำพร้อมกัน', async () => {
    const body = { date: `${M}-01`, description: 'นำเงินมาลงทุน', lines: [
      { account_code: '1120', debit: '300000' }, { account_code: '3110', credit: '300000' }] };
    const key = randomUUID();
    const first = await as(owner, 'POST', `/companies/${co}/journal`, body, key);
    expect(first.statusCode).toBe(201);
    // เน็ตหลุดหลังเซิร์ฟเวอร์บันทึกแล้ว → ส่งคำขอเดิมซ้ำด้วยคีย์เดิม ได้รายการเดิม
    const again = await as(owner, 'POST', `/companies/${co}/journal`, body, key);
    expect(again.json()).toEqual(first.json());
    // กดซ้ำพร้อมกัน 6 ครั้ง (คีย์เดียว) → รายการเดียว
    const k2 = randomUUID();
    const b2 = { date: `${M}-01`, description: 'เงินสดย่อย', lines: [{ account_code: '1110', debit: '20000' }, { account_code: '1120', credit: '20000' }] };
    const many = await Promise.all(Array.from({ length: 6 }, () => as(owner, 'POST', `/companies/${co}/journal`, b2, k2)));
    expect(new Set(many.map((r) => r.json().id)).size).toBe(1);
    expect(many.every((r) => r.statusCode === 201)).toBe(true);
    // คีย์เดิมแต่เนื้อหาต่าง → 409 ACC03
    expect((await as(owner, 'POST', `/companies/${co}/journal`, { ...body, description: 'อื่น' }, key)).json().code).toBe('ACC03');
    // ไม่มีคีย์ → 400
    expect((await as(owner, 'POST', `/companies/${co}/journal`, body, null)).statusCode).toBe(400);
    // ไม่ดุล
    const ub = await as(owner, 'POST', `/companies/${co}/journal`, { date: `${M}-02`, lines: [{ account_code: '1110', debit: '100' }, { account_code: '3110', credit: '90' }] });
    expect([ub.statusCode, ub.json().code]).toEqual([422, 'ACC01']);
    // บรรทัดเดียว / จำนวนเงินผิดรูปแบบ / วันที่ผิด
    expect((await as(owner, 'POST', `/companies/${co}/journal`, { date: `${M}-02`, lines: [{ account_code: '1110', debit: '100' }] })).statusCode).toBe(400);
    expect((await as(owner, 'POST', `/companies/${co}/journal`, { date: `${M}-02`, lines: [{ account_code: '1110', debit: '1.234' }, { account_code: '3110', credit: '1.234' }] })).statusCode).toBe(400);
    expect((await as(owner, 'POST', `/companies/${co}/journal`, { date: '2026-13-01', lines: [{ account_code: '1110', debit: '1' }, { account_code: '3110', credit: '1' }] })).statusCode).toBe(400);
    // ทั้งเดบิตและเครดิตในบรรทัดเดียว / ศูนย์ / บัญชีไม่มีในผัง
    expect((await as(owner, 'POST', `/companies/${co}/journal`, { date: `${M}-02`, lines: [{ account_code: '1110', debit: '1', credit: '1' }, { account_code: '3110', credit: '0' }] })).statusCode).toBeGreaterThanOrEqual(400);
    expect((await as(owner, 'POST', `/companies/${co}/journal`, { date: `${M}-02`, lines: [{ account_code: '9999', debit: '1' }, { account_code: '3110', credit: '1' }] })).json().code).toBe('ACC04');
    // ครูลงบัญชีให้นักเรียนไม่ได้ · นักเรียนอื่น/ต่างโรงเรียน = ไม่พบ
    expect((await as(teacher, 'POST', `/companies/${co}/journal`, body)).statusCode).toBe(403);
    expect([403, 404]).toContain((await as(other, 'POST', `/companies/${co}/journal`, body)).statusCode);
    expect([403, 404]).toContain((await as(outsider, 'POST', `/companies/${co}/journal`, body)).statusCode);
    // รหัสบริษัทผิดรูปแบบ → 400 ไม่ใช่ 500
    expect((await as(owner, 'GET', '/companies/not-a-uuid/journal')).statusCode).toBe(400);
  });

  it('สมุดรายวัน: แก้ไข (กลับ+ลงใหม่) · กลับรายการ · กลับซ้ำไม่ได้ · รายการปรับปรุง AJ', async () => {
    const r = (await as(owner, 'POST', `/companies/${co}/journal`, { date: `${M}-03`, description: 'ค่าเช่า', lines: [
      { account_code: '5220', debit: '5000' }, { account_code: '1110', credit: '5000' }] })).json();
    const rep = await as(owner, 'POST', `/companies/${co}/journal/${r.id}/replace`, { date: `${M}-03`, description: 'ค่าเช่า (แก้)', lines: [
      { account_code: '5220', debit: '4500' }, { account_code: '1110', credit: '4500' }] });
    expect(rep.statusCode).toBe(201);
    expect(rep.json().docNo).toMatch(/^JV-/);
    // รายการเดิมถูกกลับแล้ว แก้ซ้ำ/กลับซ้ำไม่ได้
    expect((await as(owner, 'POST', `/companies/${co}/journal/${r.id}/reverse`, { date: `${M}-03` })).json().code).toBe('ACC12');
    expect((await as(owner, 'POST', `/companies/${co}/journal/${r.id}/replace`, { date: `${M}-03`, lines: [
      { account_code: '5220', debit: '1' }, { account_code: '1110', credit: '1' }] })).json().code).toBe('ACC12');
    const rv = await as(owner, 'POST', `/companies/${co}/journal/${rep.json().id}/reverse`, { date: `${M}-04` });
    expect(rv.json().docNo).toMatch(/^RV-/);
    // กลับรายการของการกลับรายการไม่ได้
    expect((await as(owner, 'POST', `/companies/${co}/journal/${rv.json().id}/reverse`, { date: `${M}-04` })).json().code).toBe('ACC12');
    const aj = await as(owner, 'POST', `/companies/${co}/journal`, { date: `${M}-31`, description: 'ค่าใช้จ่ายค้างจ่าย', adjusting: true, lines: [
      { account_code: '5230', debit: '1200' }, { account_code: '2310', credit: '1200' }] });
    expect(aj.json().docNo).toMatch(/^AJ-/);
    // ดูรายการ: เจ้าของ ครู ได้ · คนอื่นไม่ได้
    expect((await as(owner, 'GET', `/companies/${co}/journal/${r.id}`)).statusCode).toBe(200);
    expect((await as(teacher, 'GET', `/companies/${co}/journal/${r.id}`)).statusCode).toBe(200);
    expect((await as(other, 'GET', `/companies/${co}/journal/${r.id}`)).statusCode).toBe(404);
    // id ของรายการบริษัทอื่น → ไม่พบ (ข้ามบริษัท)
    const theirs = (await as(other, 'POST', `/companies/${otherCo}/journal`, { date: `${M}-01`, lines: [
      { account_code: '1110', debit: '10' }, { account_code: '3110', credit: '10' }] })).json();
    expect((await as(owner, 'POST', `/companies/${co}/journal/${theirs.id}/reverse`, { date: `${M}-04` })).statusCode).toBe(404);
    expect((await as(owner, 'GET', `/companies/${co}/journal/${theirs.id}`)).statusCode).toBe(404);
    await checkInvariants(co);
  });

  it('ขาย: ขายเชื่อสินค้า/บริการ ขายสด ลดหนี้ เพิ่มหนี้ รับชำระ (ลูกค้าหัก 3%) ยกเลิก', async () => {
    const inv = await as(owner, 'POST', `/companies/${co}/sales/invoice`, { date: `${M}-05`, partyCode: 'C1', lines: [{ itemCode: 'G1', qty: '100', unitPrice: '150' }] });
    expect(inv.statusCode).toBe(201);
    ids.iv = inv.json().id;
    const svc = await as(owner, 'POST', `/companies/${co}/sales/invoice`, { date: `${M}-06`, partyCode: 'C1', isService: true, lines: [{ itemCode: 'S1', qty: '2', unitPrice: '5000' }] });
    ids.ivs = svc.json().id;
    const cash = await as(owner, 'POST', `/companies/${co}/sales/cash-sale`, { date: `${M}-07`, partyCode: 'C1', cashAccount: '1110', priceMode: 'inclusive', lines: [{ itemCode: 'G1', qty: '1', unitPrice: '107' }] });
    expect(cash.statusCode).toBe(201);
    ids.cs = cash.json().id;
    const d = (await as(owner, 'GET', `/companies/${co}/sales/documents/${ids.cs}`)).json();
    expect([d.base, d.vat, d.total]).toEqual(['100.00', '7.00', '107.00']); // รวม VAT: 107 × 7/107
    // สินค้าปนบริการในใบเดียวไม่ได้ · ไม่มีบรรทัด · ไม่มีลูกค้า · ลูกค้าบริษัทอื่น
    expect((await as(owner, 'POST', `/companies/${co}/sales/invoice`, { date: `${M}-07`, partyCode: 'C1', lines: [
      { itemCode: 'G1', qty: '1', unitPrice: '1' }, { itemCode: 'S1', qty: '1', unitPrice: '1' }] })).json().code).toBe('ACC15');
    expect((await as(owner, 'POST', `/companies/${co}/sales/invoice`, { date: `${M}-07`, partyCode: 'C1', lines: [] })).statusCode).toBe(400);
    expect((await as(owner, 'POST', `/companies/${co}/sales/invoice`, { date: `${M}-07`, lines: [{ itemCode: 'G1', qty: '1', unitPrice: '1' }] })).statusCode).toBe(400);
    expect((await as(owner, 'POST', `/companies/${co}/sales/invoice`, { date: `${M}-07`, partyCode: 'NOPE', lines: [{ itemCode: 'G1', qty: '1', unitPrice: '1' }] })).statusCode).toBe(422);
    // ลดหนี้: รับคืน 10 รีม (ภาษีตามส่วนต่าง) · ลดเกินยอดค้างไม่ได้
    const cn = await as(owner, 'POST', `/companies/${co}/sales/credit-note`, { date: `${M}-08`, refDocumentId: ids.iv, reason: 'สินค้าชำรุด', lines: [{ itemCode: 'G1', qty: '10', unitPrice: '150' }] });
    expect(cn.statusCode).toBe(201);
    expect(cn.json().docNo).toMatch(/^CN-/);
    expect((await as(owner, 'POST', `/companies/${co}/sales/credit-note`, { date: `${M}-08`, refDocumentId: ids.iv, reason: 'x', lines: [{ itemCode: 'G1', qty: '1000', unitPrice: '150' }] })).json().code).toBe('ACC15');
    const dn = await as(owner, 'POST', `/companies/${co}/sales/debit-note`, { date: `${M}-09`, refDocumentId: ids.iv, reason: 'คิดราคาขาด', lines: [{ description: 'ส่วนต่างราคา', qty: '1', unitPrice: '500' }] });
    expect(dn.statusCode).toBe(201);
    ids.dn = dn.json().id;
    // ยอดค้าง IV = 16,050 − 1,605 = 14,445 · DN = 535
    const ivDoc = (await as(owner, 'GET', `/companies/${co}/sales/documents/${ids.iv}`)).json();
    expect(ivDoc.open).toBe('14445.00');
    // รับชำระบริการ ลูกค้าหัก 3% ของ 10,000 = 300 · ภาษีขายยังไม่ถึงกำหนดโอนเป็นภาษีขาย
    const re = await as(owner, 'POST', `/companies/${co}/receipts`, { date: `${M}-15`, partyCode: 'C1', cashAccount: '1120', whtAmount: '300',
      allocations: [{ documentId: ids.ivs, amount: '10700' }, { documentId: ids.iv, amount: '4445' }] });
    expect(re.statusCode).toBe(201);
    ids.re = re.json().id;
    // รับเกินยอดค้าง · ใบของบริษัทอื่น (ข้ามบริษัท)
    expect((await as(owner, 'POST', `/companies/${co}/receipts`, { date: `${M}-15`, partyCode: 'C1', allocations: [{ documentId: ids.iv, amount: '999999' }] })).json().code).toBe('ACC15');
    const theirInv = await db.query(`select id from acc.documents where company_id <> $1 limit 1`, [co]);
    if (theirInv.rows[0]) {
      expect((await as(owner, 'POST', `/companies/${co}/receipts`, { date: `${M}-15`, partyCode: 'C1', allocations: [{ documentId: theirInv.rows[0].id, amount: '1' }] })).statusCode).toBe(422);
    }
    // ยกเลิกขายสด: ต้องมีเหตุผล · ยกเลิกซ้ำไม่ได้ · ใบที่มีใบลดหนี้อ้างอยู่ยกเลิกไม่ได้
    expect((await as(owner, 'POST', `/companies/${co}/sales/documents/${ids.cs}/void`, { date: `${M}-16`, reason: ' ' })).statusCode).toBe(400);
    const v = await as(owner, 'POST', `/companies/${co}/sales/documents/${ids.cs}/void`, { date: `${M}-16`, reason: 'ออกผิด' });
    expect(v.statusCode).toBe(200);
    expect((await as(owner, 'POST', `/companies/${co}/sales/documents/${ids.cs}/void`, { date: `${M}-16`, reason: 'ออกผิด' })).json().code).toBe('ACC16');
    expect((await as(owner, 'POST', `/companies/${co}/sales/documents/${ids.iv}/void`, { date: `${M}-16`, reason: 'x' })).json().code).toBe('ACC16');
    // ครูยกเลิกไม่ได้ ดูได้
    expect((await as(teacher, 'POST', `/companies/${co}/sales/documents/${ids.dn}/void`, { date: `${M}-16`, reason: 'x' })).statusCode).toBe(403);
    expect((await as(teacher, 'GET', `/companies/${co}/sales/documents/${ids.dn}`)).statusCode).toBe(200);
    // รายการบัญชีที่มาจากเอกสาร (IV/RE/CN/...) กลับรายการหรือแก้จากสมุดรายวันไม่ได้ ต้องยกเลิกที่ตัวเอกสาร (ยอดคุมลูกหนี้จะไม่ตรงทะเบียน)
    const ivEntry = (await db.query(`select entry_id from acc.documents where company_id = $1 and id = $2`, [co, ids.iv])).rows[0].entry_id;
    const rvDoc = await as(owner, 'POST', `/companies/${co}/journal/${ivEntry}/reverse`, { date: `${M}-16` });
    expect(rvDoc.statusCode, 'กลับรายการของใบกำกับจากสมุดรายวัน').toBe(422);
    expect((await as(owner, 'POST', `/companies/${co}/journal/${ivEntry}/replace`, { date: `${M}-16`, lines: [
      { account_code: '1210', debit: '1' }, { account_code: '4110', credit: '1' }] })).statusCode).toBe(422);
    const { bal } = await checkInvariants(co);
    // ภาษีถูกหัก ณ ที่จ่าย 1420 = 300 · ภาษีขายยังไม่ถึงกำหนด 2211 หมด (รับชำระบริการครบ)
    expect(bal('1420')).toBe(30000n);
    expect(bal('2211')).toBe(0n);
  });

  it('ซื้อ: ซื้อเชื่อสินค้า ซื้อสด ลดหนี้ ซื้อบริการ จ่ายชำระหัก 3% + 50 ทวิ · เลขที่ผู้ขายซ้ำไม่ได้', async () => {
    const pi = await as(owner, 'POST', `/companies/${co}/purchases/invoice`, { date: `${M}-02`, partyCode: 'V1', vendorDocNo: 'INV-889', lines: [{ itemCode: 'G1', qty: '200', unitPrice: '100' }] });
    expect(pi.statusCode).toBe(201);
    ids.pi = pi.json().id;
    expect((await as(owner, 'POST', `/companies/${co}/purchases/invoice`, { date: `${M}-02`, partyCode: 'V1', vendorDocNo: 'INV-889', lines: [{ itemCode: 'G1', qty: '1', unitPrice: '1' }] })).json().code).toBe('ACC15');
    expect((await as(owner, 'POST', `/companies/${co}/purchases/invoice`, { date: `${M}-02`, partyCode: 'V1', lines: [{ itemCode: 'G1', qty: '1', unitPrice: '1' }] })).statusCode).toBe(400);
    const cp = await as(owner, 'POST', `/companies/${co}/purchases/cash-purchase`, { date: `${M}-03`, partyCode: 'V1', vendorDocNo: 'RC-1', cashAccount: '1110', lines: [{ itemCode: 'G1', qty: '5', unitPrice: '100' }] });
    expect(cp.statusCode).toBe(201);
    const pcn = await as(owner, 'POST', `/companies/${co}/purchases/credit-note`, { date: `${M}-04`, refDocumentId: ids.pi, vendorDocNo: 'CN-77', reason: 'ส่งคืน', lines: [{ itemCode: 'G1', qty: '10', unitPrice: '100' }] });
    expect(pcn.statusCode).toBe(201);
    const ps = await as(owner, 'POST', `/companies/${co}/purchases/invoice`, { date: `${M}-10`, partyCode: 'V2', vendorDocNo: 'S-55', isService: true, lines: [{ itemCode: 'S2', qty: '1', unitPrice: '2000' }] });
    expect(ps.statusCode).toBe(201);
    ids.ps = ps.json().id;
    // จ่าย: ใบบริการ 2,140 หัก 3% ของ 2,000 = 60 → จ่ายจริง 2,080 · ใบสินค้า 10,000
    const pv = await as(owner, 'POST', `/companies/${co}/payments`, { date: `${M}-20`, partyCode: 'V2', cashAccount: '1120', whtKind: 'service',
      allocations: [{ documentId: ids.ps, amount: '2140' }] });
    expect(pv.statusCode).toBe(201);
    ids.pv = pv.json().id;
    const pvDoc = (await as(owner, 'GET', `/companies/${co}/purchases/documents/${ids.pv}`)).json();
    expect(JSON.stringify(pvDoc)).toContain('60.00');
    const pv2 = await as(owner, 'POST', `/companies/${co}/payments`, { date: `${M}-20`, partyCode: 'V1', cashAccount: '1120', allocations: [{ documentId: ids.pi, amount: '10000' }] });
    expect(pv2.statusCode).toBe(201);
    expect((await as(owner, 'POST', `/companies/${co}/payments`, { date: `${M}-20`, partyCode: 'V1', allocations: [{ documentId: ids.pi, amount: '999999' }] })).json().code).toBe('ACC15');
    const wht = (await as(owner, 'GET', `/companies/${co}/tax/wht?month=${M}`)).json();
    const p53 = wht.forms.find((f: { form: string }) => f.form === 'pnd53');
    expect([p53.count, p53.base, p53.amount]).toEqual([1, '2000.00', '60.00']);
    const { bal } = await checkInvariants(co);
    expect(-bal('2230')).toBe(6000n);
    expect(bal('1411')).toBe(0n);
  });

  it('เช็ค: รับเช็คชำระหนี้ → นำฝาก → ผ่าน · จ่ายเช็ค → คืน · สถานะผิดลำดับไม่ได้', async () => {
    const ivDoc = (await as(owner, 'GET', `/companies/${co}/sales/documents/${ids.dn}`)).json();
    const rc = await as(owner, 'POST', `/companies/${co}/cheques`, { direction: 'received', chequeNo: '1000001', bankName: 'กรุงไทย', chequeDate: `${M}-18`, date: `${M}-18`,
      receipt: { partyCode: 'C1', allocations: [{ documentId: ids.dn, amount: ivDoc.open }] } });
    expect(rc.statusCode).toBe(201);
    const chq = rc.json();
    expect(chq.status).toBeTruthy();
    // ผ่านก่อนนำฝากไม่ได้
    expect((await as(owner, 'POST', `/companies/${co}/cheques/${chq.id}/actions`, { action: 'clear', date: `${M}-19` })).statusCode).toBe(409);
    await checkInvariants(co);
    expect((await as(owner, 'POST', `/companies/${co}/cheques/${chq.id}/actions`, { action: 'deposit', date: `${M}-19`, bankAccount: '1120' })).statusCode).toBe(200);
    expect((await as(owner, 'POST', `/companies/${co}/cheques/${chq.id}/actions`, { action: 'clear', date: `${M}-21` })).statusCode).toBe(200);
    expect((await as(owner, 'POST', `/companies/${co}/cheques/${chq.id}/actions`, { action: 'bounce', date: `${M}-22` })).statusCode).toBe(409);
    // ใบเสร็จที่ผูกเช็คยกเลิกตรงจากฝั่งขายไม่ได้
    expect((await as(owner, 'POST', `/companies/${co}/sales/documents/${chq.documentId}/void`, { date: `${M}-22`, reason: 'x' })).statusCode).toBeGreaterThanOrEqual(400);
    const pc = await as(owner, 'POST', `/companies/${co}/cheques`, { direction: 'paid', chequeNo: '2000001', bankName: 'กสิกรไทย', chequeDate: `${M}-25`, date: `${M}-22`,
      amount: '3000', counterAccount: '5260', bankAccount: '1120', partyName: 'ร้านซ่อม' });
    expect(pc.statusCode).toBe(201);
    // เช็คเลขเดิมธนาคารเดิมซ้ำไม่ได้
    expect((await as(owner, 'POST', `/companies/${co}/cheques`, { direction: 'paid', chequeNo: '2000001', bankName: 'กสิกรไทย', chequeDate: `${M}-25`, date: `${M}-22`,
      amount: '1', counterAccount: '5260', bankAccount: '1120' })).statusCode).toBeGreaterThanOrEqual(400);
    await checkInvariants(co);
    expect((await as(owner, 'POST', `/companies/${co}/cheques/${pc.json().id}/actions`, { action: 'bounce', date: `${M}-26` })).statusCode).toBe(200);
    // ครูเปลี่ยนสถานะเช็คไม่ได้
    expect((await as(teacher, 'POST', `/companies/${co}/cheques/${chq.id}/actions`, { action: 'cancel', date: `${M}-26` })).statusCode).toBe(403);
    await checkInvariants(co);
  });

  it('กระทบยอดธนาคาร: นำเข้า statement (ตรวจยอด/วันที่/บัญชี) → จับคู่ (ตรวจทิศ/ยอด/บัญชี/ข้ามบริษัท) → สรุปยอด', async () => {
    const jIn = (await as(owner, 'POST', `/companies/${co}/journal`, { date: `${M}-12`, description: 'ดอกเบี้ยรับ', lines: [
      { account_code: '1120', debit: '1000' }, { account_code: '4310', credit: '1000' }] })).json();
    const jOut = (await as(owner, 'POST', `/companies/${co}/journal`, { date: `${M}-13`, description: 'ค่าธรรมเนียม', lines: [
      { account_code: '5260', debit: '50' }, { account_code: '1120', credit: '50' }] })).json();
    const notBank = (await as(owner, 'POST', `/companies/${co}/journal`, { date: `${M}-13`, lines: [
      { account_code: '5260', debit: '1000' }, { account_code: '1110', credit: '1000' }] })).json();
    const stmt = { accountCode: '1120', periodStart: `${M}-01`, periodEnd: `${M}-31`, openingBalance: '0', closingBalance: '930',
      lines: [{ date: `${M}-12`, description: 'ดอกเบี้ย', amount: '1000' }, { date: `${M}-13`, description: 'ค่าธรรมเนียม', amount: '-50' },
              { date: `${M}-31`, description: 'ค่าธรรมเนียมรายเดือน', amount: '-20', reference: 'FEE' }] };
    const url = `/companies/${co}/bank-reconciliation`;
    // วันที่ไม่มีจริง / ยอดไม่ใช่ตัวเลข → 400 ข้อความไทย · ยอดไม่ตรง / นอกงวด / ไม่มีบัญชี → 422
    const badDate = await as(owner, 'POST', `${url}/statements`, { ...stmt, lines: [{ ...stmt.lines[0], date: `${M}-32` }] });
    expect([badDate.statusCode, badDate.json().message]).toEqual([400, expect.stringContaining('ไม่มีวันที่นี้')]);
    expect((await as(owner, 'POST', `${url}/statements`, { ...stmt, openingBalance: 'abc' })).statusCode).toBe(400);
    const off = await as(owner, 'POST', `${url}/statements`, { ...stmt, closingBalance: '950' });
    expect([off.statusCode, off.json().message]).toEqual([422, expect.stringContaining('ไม่เท่ากับยอดปลายงวด')]);
    expect((await as(owner, 'POST', `${url}/statements`, { ...stmt, lines: [{ ...stmt.lines[0], date: '2026-11-01' }], closingBalance: '1000' })).statusCode).toBe(422);
    expect((await as(owner, 'POST', `${url}/statements`, { ...stmt, accountCode: '1199' })).statusCode).toBe(422);
    expect((await as(teacher, 'POST', `${url}/statements`, stmt)).statusCode).toBe(403);
    const imp = await as(owner, 'POST', `${url}/statements`, stmt);
    expect(imp.statusCode).toBe(201);
    const dup = await as(owner, 'POST', `${url}/statements`, stmt);
    expect([dup.statusCode, dup.json().message]).toEqual([409, expect.stringMatching(/ซ้ำ/)]);
    const view = (await as(owner, 'GET', url)).json();
    const line = (amt: string) => view.lines.find((l: { amount: string }) => l.amount === amt).id as string;
    const match = (lineId: string, entryId: string, amount: string, who = owner) =>
      as(who, 'POST', `${url}/matches`, { statementLineId: lineId, entryId, amount });
    // คนละทิศ · รายการที่ไม่ได้ลงบัญชีธนาคาร · รายการของบริษัทอื่น · ครู → ไม่ได้
    expect((await match(line('-50.00'), jIn.id, '-50')).json().code).toBe('ACC15');
    expect((await match(line('1000.00'), notBank.id, '1000')).json().code).toBe('ACC15');
    const theirs = (await db.query(`select id from acc.journal_entries where company_id = $1 limit 1`, [otherCo])).rows[0].id;
    expect((await match(line('1000.00'), theirs, '1000')).statusCode).toBe(422);
    expect((await match(line('1000.00'), jIn.id, '1000', teacher)).statusCode).toBe(403);
    expect((await match(line('1000.00'), jIn.id, '1000')).statusCode).toBe(204);
    expect((await match(line('1000.00'), jIn.id, '1000')).statusCode, 'กดซ้ำ = ไม่เพิ่ม').toBe(204);
    // บรรทัดนี้จับคู่ครบแล้ว จับกับรายการอื่นอีกไม่ได้
    expect((await match(line('1000.00'), jOut.id, '1000')).json().code).toBe('ACC15');
    expect((await match(line('-50.00'), jOut.id, '-50')).statusCode).toBe(204);
    const sum = (await as(owner, 'GET', url)).json().summary;
    expect(sum.unmatched_bank).toBe('-20.00');
    expect(sum.statement_total).toBe('930.00');
  });

  it('สินทรัพย์ถาวร: ลงทะเบียน → ค่าเสื่อม AJ → ค่าเสื่อมสะสมตรงทะเบียน · ซ้ำ/ผิดลำดับไม่ได้', async () => {
    const a = await as(owner, 'POST', `/companies/${co}/fixed-assets`, { code: 'FA-1', name: 'คอมพิวเตอร์', acquiredDate: `${M}-01`, cost: '36000', salvage: '0',
      lifeMonths: 36, assetAccount: '1630', accumAccount: '1631', counterAccount: '1120' });
    expect(a.statusCode).toBe(201);
    ids.fa = a.json().id;
    expect((await as(owner, 'POST', `/companies/${co}/fixed-assets`, { code: 'FA-1', name: 'ซ้ำ', acquiredDate: `${M}-01`, cost: '1', lifeMonths: 1, assetAccount: '1630', accumAccount: '1631' })).statusCode).toBe(409);
    // บัญชีค่าเสื่อมสะสมเดียวกับบัญชีสินทรัพย์ไม่ได้
    expect((await as(owner, 'POST', `/companies/${co}/fixed-assets`, { code: 'FA-2', name: 'x', acquiredDate: `${M}-01`, cost: '1', lifeMonths: 1, assetAccount: '1630', accumAccount: '1630' })).statusCode).toBeGreaterThanOrEqual(400);
    const run = await as(owner, 'POST', `/companies/${co}/depreciation`, { month: M });
    expect(run.statusCode).toBe(201);
    expect(run.json().docNo).toMatch(/^AJ-/);
    expect((await as(owner, 'POST', `/companies/${co}/depreciation`, { month: M })).statusCode, 'ลงซ้ำเดือนเดิม').toBe(409);
    const { bal } = await checkInvariants(co);
    expect(-bal('1631')).toBe(100000n); // 36,000 / 36 = 1,000 ต่อเดือน
    // ยกเลิกทะเบียนที่ยังไม่ลงค่าเสื่อม (กลับรายการ FA) แล้วใช้รหัสเดิมซ้ำได้ · ที่ลงค่าเสื่อมแล้วยกเลิกไม่ได้
    const fa2 = (await as(owner, 'POST', `/companies/${co}/fixed-assets`, { code: 'FA-9', name: 'โต๊ะ', acquiredDate: `${M}-20`, depStart: '2026-11', cost: '1200',
      lifeMonths: 12, assetAccount: '1630', accumAccount: '1631', counterAccount: '1110' })).json();
    expect((await as(owner, 'POST', `/companies/${co}/fixed-assets/${fa2.id}/void`, { reason: ' ' })).statusCode).toBe(400);
    expect((await as(teacher, 'POST', `/companies/${co}/fixed-assets/${fa2.id}/void`, { reason: 'ผิด' })).statusCode).toBe(403);
    expect((await as(owner, 'POST', `/companies/${co}/fixed-assets/${fa2.id}/void`, { reason: 'ลงผิด' })).statusCode).toBe(200);
    expect((await as(owner, 'POST', `/companies/${co}/fixed-assets/${fa2.id}/void`, { reason: 'ลงผิด' })).statusCode, 'ยกเลิกซ้ำ').toBe(409);
    expect((await as(owner, 'POST', `/companies/${co}/fixed-assets/${ids.fa}/void`, { reason: 'x' })).statusCode).toBe(409);
    expect((await as(owner, 'POST', `/companies/${co}/fixed-assets`, { code: 'FA-9', name: 'โต๊ะ', acquiredDate: `${M}-20`, cost: '1200',
      lifeMonths: 12, assetAccount: '1630', accumAccount: '1631' })).statusCode).toBe(201);
    await checkInvariants(co);
    // ขายก่อนลงค่าเสื่อมเดือนก่อนหน้าครบ: พ.ย. ขายได้ (ต.ค. ลงแล้ว) · ธ.ค. ไม่ได้
    expect((await as(owner, 'POST', `/companies/${co}/fixed-assets/${ids.fa}/dispose`, { date: '2026-12-05', proceeds: '30000', proceedsAccount: '1120' })).statusCode).toBe(409);
  });

  it('ภาษี: ภ.พ.30 ปิดเดือน (ยอดตรงรายงาน) → ลงย้อนไม่ได้ → ชำระ · ภ.ง.ด.53 นำส่ง · ปิดงวด → ลงย้อนไม่ได้', async () => {
    const vat = (await as(owner, 'GET', `/companies/${co}/tax/vat?month=${M}`)).json();
    const sumVat = (rows: { vat: string; status: string }[]) => rows.filter((r) => r.status !== 'voided').reduce((s, r) => s + c(r.vat), 0n);
    // รายงานภาษีขาย/ซื้อรวมกันตรงกับยอดที่จะปิดจากบัญชี
    expect(sumVat(vat.sales)).toBe(c(vat.preview.outputVat));
    expect(sumVat(vat.purchases)).toBe(c(vat.preview.inputVat));
    const close = await as(owner, 'POST', `/companies/${co}/tax/vat/${M}/close`);
    expect(close.statusCode).toBe(201);
    expect((await as(owner, 'POST', `/companies/${co}/tax/vat/${M}/close`)).json().code).toBe('ACC17');
    let { bal } = await checkInvariants(co);
    expect(bal('2210')).toBe(0n);
    expect(bal('1410')).toBe(0n);
    const net = c(vat.preview.outputVat) - c(vat.preview.inputVat);
    expect(-bal('2220') + bal('1430')).toBe(net);
    // ออกใบกำกับลงวันที่ในเดือนที่ปิดแล้วไม่ได้
    expect((await as(owner, 'POST', `/companies/${co}/sales/invoice`, { date: `${M}-30`, partyCode: 'C1', lines: [{ itemCode: 'G1', qty: '1', unitPrice: '150' }] })).json().code).toBe('ACC17');
    if (net > 0n) {
      expect((await as(owner, 'POST', `/companies/${co}/tax/vat/closings/${close.json().id}/pay`, { date: '2026-11-15', cashAccount: '1120' })).statusCode).toBe(200);
    }
    const remit = await as(owner, 'POST', `/companies/${co}/tax/wht/${M}/pnd53/remit`, { date: '2026-11-07', cashAccount: '1120' });
    expect(remit.statusCode).toBe(201);
    expect(remit.json().amount).toBe('60.00');
    expect((await as(owner, 'POST', `/companies/${co}/tax/wht/${M}/pnd53/remit`, { date: '2026-11-07' })).json().code).toBe('ACC17');
    ({ bal } = await checkInvariants(co, '2026-11'));
    expect(bal('2230')).toBe(0n);
    expect(bal('2220')).toBe(0n);
    // ปิดงวด ต.ค. → ลงรายการในเดือนนั้นไม่ได้ · ครูเปิดคืนได้ (ห้องตัวเอง) · นักเรียนเปิดคืนเองไม่ได้
    expect((await as(owner, 'POST', `/companies/${co}/periods/${M}/close`)).statusCode).toBe(200);
    const late = await as(owner, 'POST', `/companies/${co}/journal`, { date: `${M}-31`, lines: [{ account_code: '1110', debit: '1' }, { account_code: '3110', credit: '1' }] });
    expect(late.json().code).toBe('ACC02');
    expect((await as(owner, 'POST', `/companies/${co}/periods/${M}/reopen`)).statusCode).toBe(403);
    expect([403, 404]).toContain((await as(other, 'POST', `/companies/${co}/periods/${M}/close`)).statusCode);
    expect((await as(teacher, 'POST', `/companies/${co}/periods/${M}/reopen`)).statusCode).toBe(200);
  });

  it('ครู: ผังบัญชีตั้งต้นสำหรับเขียนเฉลย (นักเรียนเรียกไม่ได้)', async () => {
    const r = await as(teacher, 'GET', '/teacher/coa-template');
    expect(r.statusCode).toBe(200);
    expect(JSON.stringify(r.json())).toContain('1110');
    expect((await as(owner, 'GET', '/teacher/coa-template')).statusCode).toBe(403);
  });

  it('สิทธิ์: ครูห้องอื่น (โรงเรียนเดียวกัน) ทำอะไรกับนักเรียน/ห้องนี้ไม่ได้ · ครูประจำห้องคอมเมนต์/ดูสดได้ นักเรียนคอมเมนต์ไม่ได้', async () => {
    const entry = (await as(owner, 'GET', `/companies/${co}/journal`)).json()[0].id as string;
    const deny = (r: { statusCode: number }) => expect([403, 404], 'ต้องถูกปฏิเสธ').toContain(r.statusCode);
    deny(await as(teacher2, 'GET', `/companies/${co}`));
    deny(await as(teacher2, 'GET', `/companies/${co}/trial-balance?month=${M}`));
    deny(await as(teacher2, 'POST', `/companies/${co}/journal/${entry}/comments`, { body: 'แอบเขียน' }));
    deny(await as(teacher2, 'POST', `/companies/${co}/spectate`));
    deny(await as(teacher2, 'GET', `/companies/${co}/live`));
    deny(await as(teacher2, 'POST', `/companies/${co}/periods/${M}/reopen`));
    deny(await as(teacher2, 'POST', `/teacher/students/${owner}/reset-password`, {}));
    deny(await as(teacher2, 'POST', `/teacher/students/${owner}/revoke-sessions`));
    deny(await as(teacher2, 'POST', `/teacher/students/${owner}/delete`));
    deny(await as(teacher2, 'POST', `/classrooms/${room}/join-code`, { enabled: true }));
    deny(await as(teacher2, 'POST', `/classrooms/${room}/import`, { rows: [{ studentCode: '99999', name: 'แทรก' }] }));
    deny(await as(teacher2, 'POST', `/classrooms/${room}/companies`, { name: 'แทรก' }));
    deny(await as(teacher2, 'GET', `/teacher/classrooms/${room}/live`));
    // ครูประจำห้อง: คอมเมนต์ได้ (201) · นักเรียนเจ้าของคอมเมนต์ไม่ได้ · คอมเมนต์ว่างไม่ได้
    expect((await as(teacher, 'POST', `/companies/${co}/journal/${entry}/comments`, { body: 'ตรวจบัญชีคู่อีกครั้ง' })).statusCode).toBe(201);
    expect((await as(teacher, 'POST', `/companies/${co}/journal/${entry}/comments`, { body: '   ' })).statusCode).toBe(400);
    deny(await as(owner, 'POST', `/companies/${co}/journal/${entry}/comments`, { body: 'ตอบเอง' }));
    const sp = await as(teacher, 'POST', `/companies/${co}/spectate`);
    expect(sp.statusCode).toBe(201);
    const watchers = (await as(owner, 'GET', '/me/watchers')).json();
    expect(watchers.map((w: { id: string }) => w.id)).toContain(sp.json().id); // ป้าย "ครูกำลังดูอยู่"
    expect((await as(teacher, 'POST', `/spectate/${sp.json().id}/stop`)).statusCode).toBe(200);
    expect((await as(owner, 'GET', '/me/watchers')).json()).toEqual([]);
    // นักเรียนในห้องเดียวกันดูสด/ฟังบริษัทเพื่อนไม่ได้
    deny(await as(other, 'POST', `/companies/${co}/spectate`));
    deny(await as(other, 'GET', `/companies/${co}/live`));
  });

  it('งบการเงิน/แยกประเภท/งบทดลอง: ตัวเลขตรงกันทุกรายงาน (เจ้าของและครูเห็นเท่ากัน)', async () => {
    const tb = (await as(owner, 'GET', `/companies/${co}/trial-balance?month=${M}`)).json();
    const tbT = (await as(teacher, 'GET', `/companies/${co}/trial-balance?month=${M}`)).json();
    expect(tbT).toEqual(tb);
    const accts = (await as(owner, 'GET', `/companies/${co}/ledger-accounts?month=${M}`)).json();
    for (const a of accts as { code: string; closing: string; normalSide: string }[]) {
      const row = tb.rows.find((r: { code: string }) => r.code === a.code);
      const tbNet = row ? c(row.debit) - c(row.credit) : 0n;
      const ledgerNet = a.normalSide === 'debit' ? c(a.closing) : -c(a.closing);
      expect(ledgerNet, `แยกประเภท ${a.code} = งบทดลอง`).toBe(tbNet);
    }
    const st = await as(owner, 'GET', `/companies/${co}/statements?month=${M}&scope=ytd`);
    expect(st.statusCode).toBe(200);
    // ไม่ระบุเดือน → 400 ไม่ใช่ 500
    expect((await as(owner, 'GET', `/companies/${co}/ledger-accounts`)).statusCode).toBe(400);
    expect((await as(owner, 'GET', `/companies/${co}/trial-balance`)).statusCode).toBe(400);
  });
});

describe('ทั้งระบบผ่าน API: สินค้าคงเหลือแบบต่อเนื่อง (ติดตามสต็อก)', () => {
  let inv: string;
  const qty = async (code = 'G1') => {
    const r = (await as(owner, 'GET', `/companies/${inv}/inventory`)).json();
    const it = r.items.find((x: { code: string }) => x.code === code);
    expect(r.totalValue, 'มูลค่ารวมบัตรสต็อก = ยอด 1310').toBe(r.glBalance);
    return [it.quantity, it.value];
  };
  beforeAll(async () => {
    inv = await newCompany(owner);
    await db.query(`update acc.companies set tax_id = $2, address = 'กรุงเทพฯ', version = version + 1 where id = $1`, [inv, taxId(4001)]);
    await db.query(`insert into acc.parties (company_id, code, name, is_customer, is_vendor, credit_days, tax_id, vat_registered)
                    values ($1, 'C1', 'ลูกค้า', true, false, 30, $2, true), ($1, 'V1', 'ผู้ขาย', false, true, 30, $3, true)`, [inv, taxId(4002), taxId(4003)]);
  });

  it('สินค้าเปิดติดตามสต็อกผ่าน API · บริการติดตามไม่ได้ · เปิดยอดด้วยการปรับสต็อก', async () => {
    expect((await as(owner, 'POST', `/companies/${inv}/items`, { code: 'G1', name: 'สินค้า', unit: 'ชิ้น', isService: false, trackInventory: true })).json().trackInventory).toBe(true);
    expect((await as(owner, 'POST', `/companies/${inv}/items`, { code: 'S1', name: 'บริการ', isService: true, trackInventory: true })).statusCode).toBe(400);
    expect((await as(owner, 'POST', `/companies/${inv}/items`, { code: 'G2', name: 'ไม่ติดตาม', isService: false })).json().trackInventory).toBe(false);
    const adj = (body: object, key?: string) => as(owner, 'POST', `/companies/${inv}/inventory/adjustments`, body, key ?? randomUUID());
    // รับเข้าไม่ใส่ต้นทุน · จำนวนศูนย์ · สินค้าไม่ติดตาม · บัญชีคู่ไม่มี → ไม่ได้
    expect((await adj({ itemCode: 'G1', date: `${M}-01`, quantity: '5', offsetAccount: '3110' })).statusCode).toBe(400);
    expect((await adj({ itemCode: 'G1', date: `${M}-01`, quantity: '0', unitCost: '1', offsetAccount: '3110' })).statusCode).toBe(400);
    expect((await adj({ itemCode: 'G2', date: `${M}-01`, quantity: '5', unitCost: '1', offsetAccount: '3110' })).json().code).toBe('ACC04');
    expect((await adj({ itemCode: 'G1', date: `${M}-01`, quantity: '5', unitCost: '1', offsetAccount: '9999' })).json().code).toBe('ACC04');
    expect([403, 404]).toContain((await as(teacher, 'POST', `/companies/${inv}/inventory/adjustments`, { itemCode: 'G1', date: `${M}-01`, quantity: '5', unitCost: '8', offsetAccount: '3110' })).statusCode);
    const key = randomUUID();
    const open = await adj({ itemCode: 'G1', date: `${M}-01`, quantity: '5', unitCost: '8', offsetAccount: '3110', description: 'ยอดยกมา' }, key);
    expect(open.statusCode).toBe(201);
    expect(open.json().docNo).toMatch(/^IA-/);
    expect((await adj({ itemCode: 'G1', date: `${M}-01`, quantity: '5', unitCost: '8', offsetAccount: '3110', description: 'ยอดยกมา' }, key)).json(), 'กดซ้ำ = รายการเดิม').toEqual(open.json());
    expect(await qty()).toEqual(['5.000', '40.00']);
    // ตัดออกเกินคงเหลือไม่ได้
    expect((await adj({ itemCode: 'G1', date: `${M}-01`, quantity: '-6', offsetAccount: '5130' })).json().code).toBe('ACC15');
    await checkInvariants(inv);
  });

  it('ซื้อเข้า → ขาย (ต้นทุนถัวเฉลี่ย) → ขายเกินคงเหลือไม่ได้ → ยกเลิกใบขาย: 1310 = stock card ตลอด', async () => {
    const buy = (date: string, q: string, price: string, no: string) =>
      as(owner, 'POST', `/companies/${inv}/purchases/invoice`, { date, partyCode: 'V1', vendorDocNo: no, lines: [{ itemCode: 'G1', qty: q, unitPrice: price }] });
    expect((await buy(`${M}-01`, '5', '12', 'A1')).statusCode).toBe(201);
    expect((await buy(`${M}-02`, '10', '20', 'A2')).statusCode).toBe(201);
    expect(await qty()).toEqual(['20.000', '300.00']); // 40 + 60 + 200 → เฉลี่ย 15
    const sale = await as(owner, 'POST', `/companies/${inv}/sales/invoice`, { date: `${M}-03`, partyCode: 'C1', lines: [{ itemCode: 'G1', qty: '4', unitPrice: '50' }] });
    expect(sale.statusCode).toBe(201);
    const { bal } = await checkInvariants(inv);
    expect(bal('5130')).toBe(6000n); // 4 × 15
    expect((await as(owner, 'POST', `/companies/${inv}/sales/invoice`, { date: `${M}-04`, partyCode: 'C1', lines: [{ itemCode: 'G1', qty: '17', unitPrice: '50' }] })).json().code).toBe('ACC15');
    expect((await as(owner, 'POST', `/companies/${inv}/sales/documents/${sale.json().id}/void`, { date: `${M}-05`, reason: 'ออกผิด' })).statusCode).toBe(200);
    expect(await qty()).toEqual(['20.000', '300.00']);
    expect((await checkInvariants(inv)).bal('5130')).toBe(0n);
  });

  it('ใบลดหนี้ขาย = รับคืนเข้าสต็อกที่ต้นทุนตอนขาย · ใบลดหนี้ซื้อ = ส่งคืนออกจากสต็อก · ยกเลิกใบลดหนี้ = กลับสต็อก', async () => {
    const sale = await as(owner, 'POST', `/companies/${inv}/sales/invoice`, { date: `${M}-06`, partyCode: 'C1', lines: [{ itemCode: 'G1', qty: '5', unitPrice: '50' }] });
    expect(sale.statusCode).toBe(201);
    expect(await qty()).toEqual(['15.000', '225.00']);
    const cn = await as(owner, 'POST', `/companies/${inv}/sales/credit-note`, { date: `${M}-07`, refDocumentId: sale.json().id, reason: 'รับคืน', lines: [{ itemCode: 'G1', qty: '2', unitPrice: '50' }] });
    expect(cn.statusCode).toBe(201);
    expect(await qty()).toEqual(['17.000', '255.00']); // คืน 2 × 15
    let { bal } = await checkInvariants(inv);
    expect(bal('5130')).toBe(4500n); // 75 − 30
    // รับคืนเกินที่ขายในใบนั้นไม่ได้ (ขาย 5 คืนแล้ว 2 อีก 4 = เกิน)
    expect((await as(owner, 'POST', `/companies/${inv}/sales/credit-note`, { date: `${M}-07`, refDocumentId: sale.json().id, reason: 'x', lines: [{ itemCode: 'G1', qty: '4', unitPrice: '1' }] })).json().code).toBe('ACC15');
    const pi = (await db.query(`select id from acc.purchase_documents where company_id = $1 and vendor_doc_no = 'A2'`, [inv])).rows[0].id;
    const pcn = await as(owner, 'POST', `/companies/${inv}/purchases/credit-note`, { date: `${M}-08`, refDocumentId: pi, vendorDocNo: 'R1', reason: 'ส่งคืน', lines: [{ itemCode: 'G1', qty: '3', unitPrice: '20' }] });
    expect(pcn.statusCode).toBe(201);
    expect(await qty()).toEqual(['14.000', '195.00']); // ส่งคืน 3 × 20 = 60
    ({ bal } = await checkInvariants(inv));
    expect(bal('5140')).toBe(0n); // ส่งคืนสินค้าที่ติดตามสต็อกหัก 1310 ตรง ไม่ค้างใน 5140
    // ยกเลิกใบลดหนี้ซื้อ → สต็อกกลับ · ยกเลิกใบลดหนี้ขาย → สต็อกออก
    expect((await as(owner, 'POST', `/companies/${inv}/purchases/documents/${pcn.json().id}/void`, { date: `${M}-09`, reason: 'ผิด' })).statusCode).toBe(200);
    expect(await qty()).toEqual(['17.000', '255.00']);
    expect((await as(owner, 'POST', `/companies/${inv}/sales/documents/${cn.json().id}/void`, { date: `${M}-09`, reason: 'ผิด' })).statusCode).toBe(200);
    expect(await qty()).toEqual(['15.000', '225.00']);
    await checkInvariants(inv);
    // บัตรสต็อก: ยอดคงเหลือหลังรายการสุดท้าย = ยอดคงเหลือ · มีเลขที่เอกสารอ้างอิงทุกบรรทัด
    const card = (await as(owner, 'GET', `/companies/${inv}/inventory/G1`)).json();
    expect(card.card.at(-1)).toMatchObject({ balanceQty: '15.000', balanceValue: '225.00' });
    expect(card.card.every((m: { entryDocNo: string }) => m.entryDocNo)).toBe(true);
    expect((await as(teacher, 'GET', `/companies/${inv}/inventory/G1`)).statusCode).toBe(404); // บริษัทนอกห้องเรียน: ครูไม่เห็น
    expect((await as(other, 'GET', `/companies/${inv}/inventory`)).statusCode).toBe(404);
    // ปิดการติดตามสต็อกเมื่อมีความเคลื่อนไหวแล้วไม่ได้
    const it = (await as(owner, 'GET', `/companies/${inv}/items`)).json().find((x: { code: string }) => x.code === 'G1');
    expect((await as(owner, 'PATCH', `/companies/${inv}/items/G1`, { version: it.version, trackInventory: false })).json().code).toBe('ACC18');
  });
});
