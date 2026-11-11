import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../apps/api/src/app';
import { devAuth } from '../apps/api/src/auth';
import { authConfigFromEnv } from '../apps/api/src/config';
import { createPool } from '../apps/api/src/db';
import { apiUrl } from './global-setup';
import { pool as db, newSchool, newUser, newClassroom, newCompany, taxId } from './helpers';

// ใบเสนอราคา → ใบสั่งขาย → ขายเชื่อ → ใบวางบิล · รับเงินมัดจำ/หักมัดจำ (docs/phase5-spec.md ข้อ 4)
// เฉลยคิดด้วยมือล่วงหน้า (VAT 7%) เทียบทุกบรรทัด
const apiPool = createPool(apiUrl());
const app = buildApp({ pool: apiPool, auth: devAuth(), cfg: { ...authConfigFromEnv({}), allowedOrigins: false } });
afterAll(async () => { await app.close(); await apiPool.end(); await db.end(); });

type Method = 'GET' | 'POST' | 'PATCH';
let owner: string;
let co: string;
const call = (method: Method, url: string, payload?: unknown, key = randomUUID()) =>
  app.inject({ method, url, payload: payload as object, headers: { 'x-dev-user-id': owner, 'x-dev-role': 'student', 'idempotency-key': key } });
async function ok(method: Method, url: string, payload?: unknown, key?: string) {
  const r = await call(method, url, payload, key);
  if (r.statusCode >= 300) throw new Error(`${method} ${url} → ${r.statusCode} ${r.body}`);
  return r.json();
}
async function lines(entryId: string) {
  const r = await db.query(
    `select a.code, sum(l.debit)::numeric(18,2)::text d, sum(l.credit)::numeric(18,2)::text c
       from acc.journal_lines l join acc.chart_of_accounts a on a.company_id = l.company_id and a.id = l.account_id
      where l.entry_id = $1 group by a.code order by a.code`, [entryId]);
  return Object.fromEntries(r.rows.map((x) => [x.code, [x.d, x.c]]));
}
const docEntry = async (docNo: string) =>
  lines((await db.query(`select entry_id from acc.documents where company_id = $1 and doc_no = $2`, [co, docNo])).rows[0].entry_id);
const doc = async (docNo: string) => (await db.query(`select id from acc.documents where company_id = $1 and doc_no = $2`, [co, docNo])).rows[0].id as string;
const open = async (docNo: string) => (await ok('GET', `/companies/${co}/sales/documents/${await doc(docNo)}`)).open as string;
async function vat(month: string) {
  const r = await db.query(`select doc_no, base::numeric(18,2)::text b, vat::numeric(18,2)::text v from acc.vat_report($1, $2::date, 'sales') order by row_date, doc_no`, [co, `${month}-01`]);
  return r.rows.map((x) => [x.doc_no, x.b, x.v]);
}
const gl = async (code: string, from: string, to: string) =>
  (await db.query(`select acc.account_movement($1, $2, $3::date, $4::date)::numeric(18,2)::text v`, [co, code, from, to])).rows[0].v as string;

beforeAll(async () => {
  const school = await newSchool();
  const teacher = await newUser(school, 'teacher');
  owner = await newUser(school, 'student');
  co = await newCompany(owner, await newClassroom(school, teacher, [owner]));
  const prof = await ok('GET', `/companies/${co}/profile`);
  await ok('PATCH', `/companies/${co}/profile`, { version: prof.version, taxId: taxId(9601), vatRegistered: true });
  await ok('POST', `/companies/${co}/parties`, { code: 'C1', name: 'ร้าน ลูกค้าหนึ่ง', isCustomer: true, isVendor: false, taxId: taxId(9611), vatRegistered: true, creditDays: 30 });
  await ok('POST', `/companies/${co}/items`, { code: 'P', name: 'เครื่องกรองน้ำ', unit: 'เครื่อง', isService: false, salePrice: '1000' });
  await ok('POST', `/companies/${co}/items`, { code: 'S', name: 'ค่าติดตั้ง', unit: 'งาน', isService: true });
});

describe('ใบเสนอราคา → ใบสั่งขาย → มัดจำ (สินค้า) → ขายเชื่อสองครั้งหักมัดจำ → ใบวางบิล → รับชำระ', () => {
  let qt: string, so: string;

  it('ใบเสนอราคา 10 × 1,000 ลด 500: ฐาน 9,500 ภาษี 665 รวม 10,165 · ไม่ลงบัญชี · เลยวันยืนราคา = หมดอายุ', async () => {
    const r = await ok('POST', `/companies/${co}/sales-orders`, { kind: 'quotation', date: '2026-03-01', untilDate: '2026-03-31', partyCode: 'C1',
      discount: '500', lines: [{ itemCode: 'P', qty: '10', unitPrice: '1000' }] });
    expect(r.docNo).toBe('QT-0001');
    qt = r.id;
    const q = await ok('GET', `/companies/${co}/sales-orders/${qt}`);
    expect([q.gross, q.discount, q.base, q.vat, q.total, q.status]).toEqual(['10000.00', '500.00', '9500.00', '665.00', '10165.00', 'expired']);
    expect((await db.query('select count(*)::int n from acc.journal_entries where company_id = $1', [co])).rows[0].n).toBe(0);
  });

  it('ใบสั่งขายจากใบเสนอราคา → ใบเสนอราคา "อนุมัติแล้ว"', async () => {
    const r = await ok('POST', `/companies/${co}/sales-orders`, { kind: 'sales_order', date: '2026-03-05', untilDate: '2026-04-30', partyCode: 'C1',
      sourceId: qt, lines: [{ itemCode: 'P', qty: '10', unitPrice: '1000' }] });
    expect(r.docNo).toBe('SO-0001');
    so = r.id;
    expect((await ok('GET', `/companies/${co}/sales-orders/${qt}`)).status).toBe('accepted');
    const cancel = await call('POST', `/companies/${co}/sales-orders/${qt}/cancel`, { reason: 'ทดสอบ' });
    expect([cancel.statusCode, cancel.json().code]).toEqual([409, 'ACC16']);
  });

  it('รับเงินมัดจำ 2,000 + ภาษี 140 ตามใบสั่งขาย: ภาษีขายถึงกำหนดตอนรับเงิน', async () => {
    const r = await ok('POST', `/companies/${co}/sales/deposit`, { date: '2026-03-10', partyCode: 'C1', amount: '2000', orderId: so });
    expect(r.docNo).toBe('DP-0001');
    expect(await docEntry('DP-0001')).toEqual({ 1110: ['2140.00', '0.00'], 2210: ['0.00', '140.00'], 2420: ['0.00', '2000.00'] });
    expect(await vat('2026-03')).toEqual([['DP-0001', '2000.00', '140.00']]);
  });

  it('ขายเชื่อ 6 เครื่องจากใบสั่งขาย หักมัดจำ 1,070 (ภาษีตามสัดส่วน 70)', async () => {
    const dp = await doc('DP-0001');
    const r = await ok('POST', `/companies/${co}/sales/invoice`, { date: '2026-04-05', partyCode: 'C1', orderId: so,
      lines: [{ itemCode: 'P', qty: '6', unitPrice: '1000', orderLineNo: 1 }], deposits: [{ documentId: dp, amount: '1070' }] });
    expect(r.docNo).toBe('IV-0001');
    expect(await docEntry('IV-0001')).toEqual({ 1210: ['6420.00', '0.00'], 2210: ['0.00', '420.00'], 4110: ['0.00', '6000.00'] });
    expect(await docEntry('DA-0001')).toEqual({ 1210: ['0.00', '1070.00'], 2210: ['70.00', '0.00'], 2420: ['1000.00', '0.00'] });
    expect(await open('IV-0001')).toBe('5350.00');
    const o = await ok('GET', `/companies/${co}/sales-orders/${so}`);
    expect([o.status, o.lines[0].delivered, o.deposits[0].remaining]).toEqual(['partial', '6.000', '1070.00']);
  });

  it('ส่งเกินที่สั่งไม่ได้ · ส่งที่เหลือ 4 เครื่อง หักมัดจำที่เหลือ (ภาษีรับเศษ 70) → ใบสั่งขายปิด', async () => {
    const dp = await doc('DP-0001');
    const over = await call('POST', `/companies/${co}/sales/invoice`, { date: '2026-04-20', partyCode: 'C1', orderId: so,
      lines: [{ itemCode: 'P', qty: '5', unitPrice: '1000', orderLineNo: 1 }] });
    expect([over.statusCode, over.json().message]).toEqual([422, 'บรรทัดที่ 1: ส่งเกินจำนวนในใบสั่งขาย SO-0001 (สั่ง 10.000 ส่งแล้ว 6.000)']);
    const tooMuch = await call('POST', `/companies/${co}/sales/invoice`, { date: '2026-04-20', partyCode: 'C1', orderId: so,
      lines: [{ itemCode: 'P', qty: '4', unitPrice: '1000', orderLineNo: 1 }], deposits: [{ documentId: dp, amount: '1071' }] });
    expect(tooMuch.json().message).toBe('DP-0001 เหลือ 1,070.00 หักเกินไม่ได้');
    await ok('POST', `/companies/${co}/sales/invoice`, { date: '2026-04-20', partyCode: 'C1', orderId: so,
      lines: [{ itemCode: 'P', qty: '4', unitPrice: '1000', orderLineNo: 1 }], deposits: [{ documentId: dp, amount: '1070' }] });
    expect(await docEntry('IV-0002')).toEqual({ 1210: ['4280.00', '0.00'], 2210: ['0.00', '280.00'], 4110: ['0.00', '4000.00'] });
    expect(await docEntry('DA-0002')).toEqual({ 1210: ['0.00', '1070.00'], 2210: ['70.00', '0.00'], 2420: ['1000.00', '0.00'] });
    expect(await open('IV-0002')).toBe('3210.00');
    const o = await ok('GET', `/companies/${co}/sales-orders/${so}`);
    expect([o.status, o.deposits[0].remaining, o.invoices.map((x: { docNo: string }) => x.docNo)]).toEqual(['closed', '0.00', ['IV-0001', 'IV-0002']]);
  });

  it('รายงานภาษีขาย เม.ย.: ใบขายเต็มจำนวน หักมัดจำเป็นรายการลบ = ยอด 2210 · ภาษีรวมทั้งงาน 700 = 7% ของ 10,000', async () => {
    expect(await vat('2026-04')).toEqual([
      ['DA-0001', '-1000.00', '-70.00'], ['IV-0001', '6000.00', '420.00'], ['DA-0002', '-1000.00', '-70.00'], ['IV-0002', '4000.00', '280.00']]);
    expect(await gl('2210', '2026-04-01', '2026-04-30')).toBe('-560.00');
    expect(await gl('2210', '2026-03-01', '2026-04-30')).toBe('-700.00');
    expect(await gl('2420', '2026-03-01', '2026-04-30')).toBe('0.00');
  });

  it('ใบวางบิลรวมสองใบ 8,560 ครบกำหนดตามใบหลัง · ใบเดิมวางซ้ำไม่ได้ · รับชำระครบ → ชำระครบ · ยกเลิกตามกติกา', async () => {
    const [iv1, iv2] = [await doc('IV-0001'), await doc('IV-0002')];
    const bl = await ok('POST', `/companies/${co}/billing-notes`, { date: '2026-04-30', partyCode: 'C1', documentIds: [iv1, iv2] });
    expect(bl.docNo).toBe('BL-0001');
    const n = await ok('GET', `/companies/${co}/billing-notes/${bl.id}`);
    expect([n.total, n.dueDate, n.status, n.items.map((x: { docNo: string; amount: string }) => [x.docNo, x.amount])])
      .toEqual(['8560.00', '2026-05-20', 'open', [['IV-0001', '5350.00'], ['IV-0002', '3210.00']]]);
    const dup = await call('POST', `/companies/${co}/billing-notes`, { date: '2026-05-01', partyCode: 'C1', documentIds: [iv1] });
    expect(dup.json().message).toBe('IV-0001 อยู่ในใบวางบิล BL-0001 แล้ว');
    expect(await doc('DA-0001')).toBeTruthy();
    // ยกเลิกไม่ได้: มัดจำมีการหักอ้าง · ใบขายมีการหักมัดจำอ้าง · ใบสั่งขายมีใบขาย
    for (const [url, body] of [
      [`/companies/${co}/sales/documents/${await doc('DP-0001')}/void`, { date: '2026-04-30', reason: 'ทดสอบ' }],
      [`/companies/${co}/sales/documents/${iv1}/void`, { date: '2026-04-30', reason: 'ทดสอบ' }],
      [`/companies/${co}/sales-orders/${so}/cancel`, { reason: 'ทดสอบ' }],
    ] as const) {
      const r = await call('POST', url, body);
      expect([r.statusCode, r.json().code]).toEqual([409, 'ACC16']);
    }
    await ok('POST', `/companies/${co}/receipts`, { date: '2026-05-05', partyCode: 'C1', cashAccount: '1110',
      allocations: [{ documentId: iv1, amount: '5350' }, { documentId: iv2, amount: '3210' }] });
    const paid = await ok('GET', `/companies/${co}/billing-notes/${bl.id}`);
    expect([paid.status, paid.open]).toEqual(['paid', '0.00']);
  });
});

describe('มัดจำงานบริการ: ภาษีเสียตอนรับมัดจำ ภาษียังไม่ถึงกำหนดของใบขายลดตามที่หัก', () => {
  it('มัดจำ 1,000 + 70 → ขายเชื่อบริการ 5,000 + 350 หักมัดจำ → รับชำระส่วนที่เหลือ: ภาษีรวม 350 พอดี 2211 เป็นศูนย์', async () => {
    const dp = await ok('POST', `/companies/${co}/sales/deposit`, { date: '2026-05-02', partyCode: 'C1', amount: '1000', isService: true });
    expect(await docEntry(dp.docNo)).toEqual({ 1110: ['1070.00', '0.00'], 2210: ['0.00', '70.00'], 2420: ['0.00', '1000.00'] });
    const iv = await ok('POST', `/companies/${co}/sales/invoice`, { date: '2026-05-10', partyCode: 'C1',
      lines: [{ itemCode: 'S', qty: '1', unitPrice: '5000' }], deposits: [{ documentId: dp.id, amount: '1070' }] });
    expect(await docEntry(iv.docNo)).toEqual({ 1210: ['5350.00', '0.00'], 2211: ['0.00', '350.00'], 4120: ['0.00', '5000.00'] });
    expect(await docEntry('DA-0003')).toEqual({ 1210: ['0.00', '1070.00'], 2211: ['70.00', '0.00'], 2420: ['1000.00', '0.00'] });
    const d = await ok('GET', `/companies/${co}/sales/documents/${iv.id}`);
    expect(d.open).toBe('4280.00');
    const re = await ok('POST', `/companies/${co}/receipts`, { date: '2026-05-20', partyCode: 'C1', cashAccount: '1110', allocations: [{ documentId: iv.id, amount: '4280' }] });
    expect(await lines((await db.query('select entry_id from acc.documents where id = $1', [re.id])).rows[0].entry_id))
      .toEqual({ 1110: ['4280.00', '0.00'], 1210: ['0.00', '4280.00'], 2210: ['0.00', '280.00'], 2211: ['280.00', '0.00'] });
    expect(await gl('2211', '2026-05-01', '2026-05-31')).toBe('0.00');
    // พ.ค.: ภาษีขายในรายงาน = มัดจำ 70 + รับชำระ 280 (ใบขายบริการและใบหักมัดจำบริการไม่ใช่ใบกำกับภาษี) = ยอด 2210
    const may = await vat('2026-05');
    expect(may.reduce((s, x) => s + Number(x[2]) * 100, 0) / 100).toBe(350);
    expect(await gl('2210', '2026-05-01', '2026-05-31')).toBe('-350.00');
  });

  it('ยกเลิกใบหักมัดจำ → มัดจำคืนยอด ใบขายค้างเต็ม · แล้วยกเลิกมัดจำได้', async () => {
    const dp = await ok('POST', `/companies/${co}/sales/deposit`, { date: '2026-06-01', partyCode: 'C1', amount: '500' });
    const iv = await ok('POST', `/companies/${co}/sales/invoice`, { date: '2026-06-02', partyCode: 'C1',
      lines: [{ itemCode: 'P', qty: '1', unitPrice: '1000' }], deposits: [{ documentId: dp.id, amount: '535' }] });
    const da = (await db.query(`select id from acc.documents where company_id = $1 and kind = 'deposit_applied' and ref_document_id = $2`, [co, dp.id])).rows[0].id;
    await ok('POST', `/companies/${co}/sales/documents/${da}/void`, { date: '2026-06-02', reason: 'หักผิด' });
    expect((await ok('GET', `/companies/${co}/sales/documents/${iv.id}`)).open).toBe('1070.00');
    expect((await ok('GET', `/companies/${co}/deposits?party=C1`)).map((x: { docNo: string; remaining: string }) => [x.docNo, x.remaining]))
      .toEqual([[dp.docNo, '535.00']]);
    await ok('POST', `/companies/${co}/sales/documents/${dp.id}/void`, { date: '2026-06-02', reason: 'คืนมัดจำ' });
    expect(await ok('GET', `/companies/${co}/deposits?party=C1`)).toEqual([]);
  });
});
