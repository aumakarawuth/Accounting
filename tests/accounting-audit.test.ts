import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../apps/api/src/app';
import { devAuth } from '../apps/api/src/auth';
import { authConfigFromEnv } from '../apps/api/src/config';
import { createPool } from '../apps/api/src/db';
import { apiUrl } from './global-setup';
import { pool as db, newSchool, newUser, newClassroom, newCompany, taxId } from './helpers';

// ตรวจความถูกต้องของตัวเลขบัญชี (docs/accounting-audit.md)
// สถานการณ์ 2 เดือนของบริษัทจด VAT ซื้อขายสินค้า (ต้นทุนถัวเฉลี่ยเคลื่อนที่) + บริการ + สินทรัพย์ + เช็ค + ภาษี
// ทุกรายการเทียบกับเฉลยที่คำนวณด้วยมือล่วงหน้า (ปัดสตางค์ครึ่งขึ้น) รายบัญชีรายบรรทัด ไม่ใช่แค่ตรวจว่า "ดุล"
const apiPool = createPool(apiUrl());
const app = buildApp({ pool: apiPool, auth: devAuth(), cfg: { ...authConfigFromEnv({}), allowedOrigins: false } });
afterAll(async () => { await app.close(); await apiPool.end(); await db.end(); });

type Method = 'GET' | 'POST' | 'PATCH';
let owner: string;
const as = (method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as object, headers: { 'x-dev-user-id': owner, 'x-dev-role': 'student', 'idempotency-key': randomUUID() } });
async function ok(method: Method, url: string, payload?: unknown) {
  const r = await as(method, url, payload);
  if (r.statusCode >= 300) throw new Error(`${method} ${url} → ${r.statusCode} ${r.body}`);
  return r.statusCode === 204 ? null : r.json();
}

function juristicTaxId(seed: number) {
  const first12 = '0' + String(10_000_000_000 + seed).slice(-11);
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(first12[i]) * (13 - i);
  return first12 + ((11 - (sum % 11)) % 10);
}

type Lines = Record<string, [string, string]>; // รหัสบัญชี → [เดบิต, เครดิต]
/** รายการบัญชีหนึ่งรายการ รวมตามบัญชี */
async function lines(entryId: string): Promise<Lines> {
  const r = await db.query(
    `select a.code, sum(l.debit)::numeric(18,2)::text d, sum(l.credit)::numeric(18,2)::text c
       from acc.journal_lines l join acc.chart_of_accounts a on a.company_id = l.company_id and a.id = l.account_id
      where l.entry_id = $1 group by a.code order by a.code`, [entryId]);
  return Object.fromEntries(r.rows.map((x) => [x.code, [x.d, x.c]]));
}
async function docEntry(id: string) {
  const r = await db.query(`select entry_id from acc.documents where id = $1 union all select entry_id from acc.purchase_documents where id = $1`, [id]);
  return lines(r.rows[0].entry_id);
}
async function invEntry(kind: string, id: string) {
  const r = await db.query(`select entry_id from acc.inventory_document_posts where source_kind = $1 and source_id = $2`, [kind, id]);
  return r.rows[0] ? lines(r.rows[0].entry_id) : {};
}
/** งบทดลองสะสมถึงสิ้นเดือน เป็นยอดสุทธิ (เดบิต +, เครดิต −) เฉพาะบัญชีที่ไม่เป็นศูนย์ */
async function tbNet(co: string, month: string) {
  const tb = await ok('GET', `/companies/${co}/trial-balance?month=${month}&all=1`);
  expect(tb.totalDebit).toBe(tb.totalCredit);
  const out: Record<string, string> = {};
  for (const r of tb.rows as { code: string; debit: string; credit: string }[]) {
    const net = (Number(r.debit) * 100 - Number(r.credit) * 100) / 100;
    if (Math.round(net * 100) !== 0) out[r.code] = net.toFixed(2);
  }
  return out;
}

const M1 = '2026-10', M2 = '2026-11';
let co: string;
const id: Record<string, string> = {};

beforeAll(async () => {
  const school = await newSchool();
  const teacher = await newUser(school, 'teacher');
  owner = await newUser(school, 'student');
  const room = await newClassroom(school, teacher, [owner]);
  co = await newCompany(owner, room);
  const prof = await ok('GET', `/companies/${co}/profile`);
  await ok('PATCH', `/companies/${co}/profile`, { version: prof.version, taxId: taxId(7001), address: 'กรุงเทพฯ', vatRegistered: true });
  for (const p of [
    { code: 'C1', name: 'ร้าน ลูกค้าหนึ่ง', isCustomer: true, isVendor: false, taxId: taxId(7101), vatRegistered: true, creditDays: 30 },
    { code: 'C2', name: 'บริษัท ลูกค้าสอง จำกัด', isCustomer: true, isVendor: false, taxId: juristicTaxId(7102), vatRegistered: true },
    { code: 'V1', name: 'บริษัท ขายส่ง จำกัด', isCustomer: false, isVendor: true, taxId: juristicTaxId(7201), vatRegistered: true },
    { code: 'V2', name: 'นาย เจ้าของตึก', isCustomer: false, isVendor: true, taxId: taxId(7202), vatRegistered: false, whtKind: 'rent' },
    { code: 'V3', name: 'บริษัท บริการ จำกัด', isCustomer: false, isVendor: true, taxId: juristicTaxId(7203), vatRegistered: true, whtKind: 'service' },
  ]) await ok('POST', `/companies/${co}/parties`, p);
  for (const i of [
    { code: 'A', name: 'สินค้า A', unit: 'ชิ้น', isService: false, trackInventory: true },
    { code: 'B', name: 'สินค้า B', unit: 'ชิ้น', isService: false, trackInventory: true },
    { code: 'S', name: 'ค่าติดตั้งระบบ', unit: 'งาน', isService: true },
    { code: 'RENT', name: 'ค่าเช่าสำนักงาน', unit: 'เดือน', isService: true, purchaseAccount: '5220' },
    { code: 'SVC', name: 'ค่าบริการดูแลระบบ', unit: 'เดือน', isService: true, purchaseAccount: '5260' },
  ]) await ok('POST', `/companies/${co}/items`, i);
});

describe('ตุลาคม 2569: ทุกรายการลงบัญชีตรงเฉลย', () => {
  it('เปิดบริษัท + ซื้อคอมพิวเตอร์เชื่อ (มี VAT) + ลงทะเบียนสินทรัพย์', async () => {
    const j1 = await ok('POST', `/companies/${co}/journal`, { date: `${M1}-01`, description: 'นำเงินมาลงทุน', lines: [
      { account_code: '1120', debit: '500000' }, { account_code: '3110', credit: '500000' }] });
    expect(await lines(j1.id)).toEqual({ 1120: ['500000.00', '0.00'], 3110: ['0.00', '500000.00'] });
    await ok('POST', `/companies/${co}/journal`, { date: `${M1}-01`, description: 'ถอนเงินมาใช้เป็นเงินสด', lines: [
      { account_code: '1110', debit: '20000' }, { account_code: '1120', credit: '20000' }] });
    const fa = await ok('POST', `/companies/${co}/purchases/invoice`, { date: `${M1}-01`, partyCode: 'V1', vendorDocNo: 'A-1', isService: false,
      lines: [{ description: 'คอมพิวเตอร์', qty: '1', unitPrice: '36000', accountCode: '1630' }] });
    id.faPi = fa.id;
    expect(await docEntry(fa.id)).toEqual({ 1410: ['2520.00', '0.00'], 1630: ['36000.00', '0.00'], 2110: ['0.00', '38520.00'] });
    const asset = await ok('POST', `/companies/${co}/fixed-assets`, { code: 'FA-1', name: 'คอมพิวเตอร์', acquiredDate: `${M1}-01`, cost: '36000',
      lifeMonths: 36, assetAccount: '1630', accumAccount: '1631' });
    id.fa = asset.id;
  });

  it('ค่าเช่าจากบุคคลธรรมดาไม่จด VAT: ไม่มีภาษีซื้อ · จ่ายหัก 5% (ภ.ง.ด.3)', async () => {
    const pi = await ok('POST', `/companies/${co}/purchases/invoice`, { date: `${M1}-01`, partyCode: 'V2', vendorDocNo: 'R-10', lines: [{ itemCode: 'RENT', qty: '1', unitPrice: '10000' }] });
    expect(await docEntry(pi.id)).toEqual({ 2110: ['0.00', '10000.00'], 5220: ['10000.00', '0.00'] });
    const pv = await ok('POST', `/companies/${co}/payments`, { date: `${M1}-05`, partyCode: 'V2', cashAccount: '1120', whtKind: 'rent', allocations: [{ documentId: pi.id, amount: '10000' }] });
    expect(await docEntry(pv.id)).toEqual({ 1120: ['0.00', '9500.00'], 2110: ['10000.00', '0.00'], 2230: ['0.00', '500.00'] });
  });

  it('ซื้อเชื่อสินค้า 2 รายการมีส่วนลดท้ายบิล: ส่วนลดหักก่อนคิด VAT · ต้นทุนแต่ละสินค้าได้ส่วนลดตามสัดส่วน', async () => {
    // A 100 × 50 = 5,000 · B 30 × 33.33 = 999.90 · รวม 5,999.90 ลด 100 → ฐาน 5,899.90 VAT 412.99 รวม 6,312.89
    const pi = await ok('POST', `/companies/${co}/purchases/invoice`, { date: `${M1}-02`, partyCode: 'V1', vendorDocNo: 'INV-1', discount: '100',
      lines: [{ itemCode: 'A', qty: '100', unitPrice: '50' }, { itemCode: 'B', qty: '30', unitPrice: '33.33' }] });
    id.pi1 = pi.id;
    expect(await docEntry(pi.id)).toEqual({ 1410: ['412.99', '0.00'], 2110: ['0.00', '6312.89'], 5110: ['5899.90', '0.00'] });
    // รับเข้าคลัง: A 5,899.90 × 5,000/5,999.90 = 4,916.67 · B 983.23
    expect(await invEntry('purchase_receipt', pi.id)).toEqual({ 1310: ['5899.90', '0.00'], 5110: ['0.00', '5899.90'] });
    const a = await ok('GET', `/companies/${co}/inventory/A`);
    expect(JSON.stringify(a)).toContain('4916.67');
  });

  it('ซื้อสดราคารวม VAT: แยกภาษี 7/107', async () => {
    // 50 × 59.92 = 2,996 รวม VAT → VAT 196 ฐาน 2,800
    const cp = await ok('POST', `/companies/${co}/purchases/cash-purchase`, { date: `${M1}-03`, partyCode: 'V1', vendorDocNo: 'RC-1', cashAccount: '1110',
      priceMode: 'inclusive', lines: [{ itemCode: 'A', qty: '50', unitPrice: '59.92' }] });
    expect(await docEntry(cp.id)).toEqual({ 1110: ['0.00', '2996.00'], 1410: ['196.00', '0.00'], 5110: ['2800.00', '0.00'] });
    expect(await invEntry('purchase_receipt', cp.id)).toEqual({ 1310: ['2800.00', '0.00'], 5110: ['0.00', '2800.00'] });
  });

  it('ขายเชื่อ: ต้นทุนขายตามถัวเฉลี่ยเคลื่อนที่ · ลดหนี้รับคืนที่ต้นทุนเดิม', async () => {
    // A คงเหลือ 150 ชิ้น 7,716.67 → ต่อหน่วย 51.444467 · ขาย 120 → ต้นทุน 6,173.34
    const iv = await ok('POST', `/companies/${co}/sales/invoice`, { date: `${M1}-05`, partyCode: 'C1', lines: [{ itemCode: 'A', qty: '120', unitPrice: '80' }] });
    id.iv1 = iv.id;
    expect(await docEntry(iv.id)).toEqual({ 1210: ['10272.00', '0.00'], 2210: ['0.00', '672.00'], 4110: ['0.00', '9600.00'] });
    expect(await invEntry('sales_cogs', iv.id)).toEqual({ 1310: ['0.00', '6173.34'], 5130: ['6173.34', '0.00'] });
    const cn = await ok('POST', `/companies/${co}/sales/credit-note`, { date: `${M1}-08`, refDocumentId: iv.id, reason: 'สินค้าชำรุด',
      lines: [{ itemCode: 'A', qty: '10', unitPrice: '80' }] });
    expect(await docEntry(cn.id)).toEqual({ 1210: ['0.00', '856.00'], 2210: ['56.00', '0.00'], 4220: ['800.00', '0.00'] });
    // รับคืน 10 × 51.444467 = 514.44
    expect(await invEntry('sales_return', cn.id)).toEqual({ 1310: ['514.44', '0.00'], 5130: ['0.00', '514.44'] });
  });

  it('ลดหนี้ซื้อ (ส่งคืน B 5 ชิ้น): ลดสินค้าคงเหลือและภาษีซื้อ', async () => {
    const pn = await ok('POST', `/companies/${co}/purchases/credit-note`, { date: `${M1}-09`, refDocumentId: id.pi1, vendorDocNo: 'CN-1', reason: 'ส่งคืนสินค้า',
      lines: [{ itemCode: 'B', qty: '5', unitPrice: '33.33' }] });
    expect(await docEntry(pn.id)).toEqual({ 1410: ['0.00', '11.67'], 2110: ['178.32', '0.00'], 5140: ['0.00', '166.65'] });
    expect(await invEntry('purchase_return', pn.id)).toEqual({ 1310: ['0.00', '166.65'], 5140: ['166.65', '0.00'] });
  });

  it('ขายเชื่อบริการ: ภาษีขายยังไม่ถึงกำหนด · รับชำระ (ลูกค้าหัก 3%) โอนเป็นภาษีขาย', async () => {
    const iv = await ok('POST', `/companies/${co}/sales/invoice`, { date: `${M1}-10`, partyCode: 'C2', lines: [{ itemCode: 'S', qty: '1', unitPrice: '20000' }] });
    expect(await docEntry(iv.id)).toEqual({ 1210: ['21400.00', '0.00'], 2211: ['0.00', '1400.00'], 4120: ['0.00', '20000.00'] });
    const re = await ok('POST', `/companies/${co}/receipts`, { date: `${M1}-25`, partyCode: 'C2', cashAccount: '1120', whtAmount: '600',
      allocations: [{ documentId: iv.id, amount: '21400' }] });
    expect(await docEntry(re.id)).toEqual({
      1120: ['20800.00', '0.00'], 1210: ['0.00', '21400.00'], 1420: ['600.00', '0.00'], 2210: ['0.00', '1400.00'], 2211: ['1400.00', '0.00'] });
  });

  it('ซื้อบริการจากนิติบุคคลจด VAT: ภาษีซื้อยังไม่ถึงกำหนด → จ่าย (หัก 3% ของฐานก่อน VAT) โอนเป็นภาษีซื้อ', async () => {
    const pi = await ok('POST', `/companies/${co}/purchases/invoice`, { date: `${M1}-12`, partyCode: 'V3', vendorDocNo: 'S-1', lines: [{ itemCode: 'SVC', qty: '1', unitPrice: '3000' }] });
    expect(await docEntry(pi.id)).toEqual({ 1411: ['210.00', '0.00'], 2110: ['0.00', '3210.00'], 5260: ['3000.00', '0.00'] });
    const pv = await ok('POST', `/companies/${co}/payments`, { date: `${M1}-28`, partyCode: 'V3', cashAccount: '1120', whtKind: 'service',
      allocations: [{ documentId: pi.id, amount: '3210' }] });
    expect(await docEntry(pv.id)).toEqual({
      1120: ['0.00', '3120.00'], 1410: ['210.00', '0.00'], 1411: ['0.00', '210.00'], 2110: ['3210.00', '0.00'], 2230: ['0.00', '90.00'] });
  });

  it('ขายสด + รับชำระบางส่วน', async () => {
    // B คงเหลือ 25 ชิ้น 816.58 → 32.6632 · ขาย 10 → 326.63
    const cs = await ok('POST', `/companies/${co}/sales/cash-sale`, { date: `${M1}-15`, partyCode: 'C1', cashAccount: '1110', lines: [{ itemCode: 'B', qty: '10', unitPrice: '50' }] });
    expect(await docEntry(cs.id)).toEqual({ 1110: ['535.00', '0.00'], 2210: ['0.00', '35.00'], 4110: ['0.00', '500.00'] });
    expect(await invEntry('sales_cogs', cs.id)).toEqual({ 1310: ['0.00', '326.63'], 5130: ['326.63', '0.00'] });
    const re = await ok('POST', `/companies/${co}/receipts`, { date: `${M1}-20`, partyCode: 'C1', cashAccount: '1120', allocations: [{ documentId: id.iv1, amount: '5000' }] });
    expect(await docEntry(re.id)).toEqual({ 1120: ['5000.00', '0.00'], 1210: ['0.00', '5000.00'] });
  });

  it('ปรับปรุงสิ้นเดือน: ค่าใช้จ่ายค้างจ่าย + ค่าเสื่อมราคา (36,000 / 36 เดือน = 1,000)', async () => {
    await ok('POST', `/companies/${co}/journal`, { date: `${M1}-31`, description: 'ค่าไฟค้างจ่าย', adjusting: true, lines: [
      { account_code: '5230', debit: '1500' }, { account_code: '2310', credit: '1500' }] });
    const run = await ok('POST', `/companies/${co}/depreciation`, { month: M1 });
    const e = (await db.query(`select entry_id from acc.depreciation_runs where id = $1`, [run.id])).rows[0].entry_id;
    expect(await lines(e)).toEqual({ 1631: ['0.00', '1000.00'], 5250: ['1000.00', '0.00'] });
  });

  it('ภ.พ.30 ต.ค.: ภาษีขาย 2,051 ภาษีซื้อ 3,327.32 → ชำระเกิน 1,276.32 · ภ.ง.ด.3/53 ตรง', async () => {
    const vat = await ok('GET', `/companies/${co}/tax/vat?month=${M1}`);
    expect([vat.preview.outputVat, vat.preview.inputVat]).toEqual(['2051.00', '3327.32']);
    const sum = (rows: { vat: string; status?: string }[]) => rows.filter((r) => r.status !== 'voided').reduce((s, r) => s + Math.round(Number(r.vat) * 100), 0) / 100;
    expect(sum(vat.sales)).toBe(2051);
    expect(sum(vat.purchases)).toBe(3327.32);
    const wht = await ok('GET', `/companies/${co}/tax/wht?month=${M1}`);
    const f = (k: string) => wht.forms.find((x: { form: string }) => x.form === k);
    expect([f('pnd3').count, f('pnd3').base, f('pnd3').amount]).toEqual([1, '10000.00', '500.00']);
    expect([f('pnd53').count, f('pnd53').base, f('pnd53').amount]).toEqual([1, '3000.00', '90.00']);
    const vc = await ok('POST', `/companies/${co}/tax/vat/${M1}/close`);
    const e = (await db.query(`select entry_id from acc.vat_closings where id = $1`, [vc.id])).rows[0].entry_id;
    expect(await lines(e)).toEqual({ 1410: ['0.00', '3327.32'], 1430: ['1276.32', '0.00'], 2210: ['2051.00', '0.00'] });
  });

  it('งบทดลอง ต.ค. ตรงเฉลยทุกบัญชี · งบการเงิน · กระดาษทำการ 10 ช่อง', async () => {
    expect(await tbNet(co, M1)).toEqual({
      1110: '17539.00', 1120: '493180.00', 1210: '4416.00', 1310: '2547.72', 1420: '600.00', 1430: '1276.32', 1630: '36000.00', 1631: '-1000.00',
      2110: '-44654.57', 2230: '-590.00', 2310: '-1500.00', 3110: '-500000.00',
      4110: '-10100.00', 4120: '-20000.00', 4220: '800.00', 5130: '5985.53', 5220: '10000.00', 5230: '1500.00', 5250: '1000.00', 5260: '3000.00' });
    const st = await ok('GET', `/companies/${co}/statements?month=${M1}&scope=month`);
    expect([st.totalRevenue, st.totalExpense, st.netIncome]).toEqual(['29300.00', '21485.53', '7814.47']);
    expect([st.totalAssets, st.totalLiabilities, st.totalEquity, st.balanced]).toEqual(['554559.04', '46744.57', '507814.47', true]);
    const ws = await ok('GET', `/companies/${co}/worksheet?month=${M1}&format=10`);
    expect(ws.totals.adj).toEqual({ debit: '2500.00', credit: '2500.00' });
    expect(ws.netIncome).toBe('7814.47');
    expect(ws.grand.is.debit).toBe(ws.grand.is.credit);
    expect(ws.grand.bs.debit).toBe(ws.grand.bs.credit);
    // สินค้าคงเหลือตามบัตรสต็อก = 1310: A 40 ชิ้น 2,057.77 · B 15 ชิ้น 489.95
    const inv = (await db.query(`select i.code, b.quantity::text q, b.value::text v from acc.items i cross join lateral acc.inventory_balance(i.company_id, i.id) b
      where i.company_id = $1 and i.track_inventory order by 1`, [co])).rows;
    expect(inv).toEqual([{ code: 'A', q: '40.000', v: '2057.77' }, { code: 'B', q: '15.000', v: '489.95' }]);
    await ok('POST', `/companies/${co}/periods/${M1}/close`);
  });
});

describe('พฤศจิกายน 2569: เช็ค นำส่งภาษี ขายสินทรัพย์ ตรวจนับ', () => {
  it('ซื้อ A เพิ่มแล้วขายสองสินค้าในใบเดียว: ถัวเฉลี่ยใหม่', async () => {
    const pi = await ok('POST', `/companies/${co}/purchases/invoice`, { date: `${M2}-02`, partyCode: 'V1', vendorDocNo: 'INV-2', lines: [{ itemCode: 'A', qty: '200', unitPrice: '52.50' }] });
    expect(await docEntry(pi.id)).toEqual({ 1410: ['735.00', '0.00'], 2110: ['0.00', '11235.00'], 5110: ['10500.00', '0.00'] });
    // A 240 ชิ้น 12,557.77 → 52.324042 · ขาย 100 = 5,232.40 · B 15 ชิ้น 489.95 → 32.663333 · ขาย 10 = 326.63
    const iv = await ok('POST', `/companies/${co}/sales/invoice`, { date: `${M2}-03`, partyCode: 'C1', lines: [
      { itemCode: 'A', qty: '100', unitPrice: '80' }, { itemCode: 'B', qty: '10', unitPrice: '60' }] });
    id.iv3 = iv.id;
    expect(await docEntry(iv.id)).toEqual({ 1210: ['9202.00', '0.00'], 2210: ['0.00', '602.00'], 4110: ['0.00', '8600.00'] });
    expect(await invEntry('sales_cogs', iv.id)).toEqual({ 1310: ['0.00', '5559.03'], 5130: ['5559.03', '0.00'] });
  });

  it('จ่ายเช็คชำระค่าคอมพิวเตอร์ · รับเช็คลูกค้า → นำฝาก → ผ่าน · นำส่งภาษีหัก ณ ที่จ่าย ต.ค.', async () => {
    const pc = await ok('POST', `/companies/${co}/cheques`, { direction: 'paid', chequeNo: '500001', bankName: 'กรุงเทพ', chequeDate: `${M2}-05`, date: `${M2}-05`,
      bankAccount: '1120', payment: { partyCode: 'V1', allocations: [{ documentId: id.faPi, amount: '38520' }] } });
    await ok('POST', `/companies/${co}/cheques/${pc.id}/actions`, { action: 'clear', date: `${M2}-07` });
    const rc = await ok('POST', `/companies/${co}/cheques`, { direction: 'received', chequeNo: '900001', bankName: 'กสิกรไทย', chequeDate: `${M2}-10`, date: `${M2}-10`,
      receipt: { partyCode: 'C1', allocations: [{ documentId: id.iv1, amount: '4416' }] } });
    await ok('POST', `/companies/${co}/cheques/${rc.id}/actions`, { action: 'deposit', date: `${M2}-11`, bankAccount: '1120' });
    await ok('POST', `/companies/${co}/cheques/${rc.id}/actions`, { action: 'clear', date: `${M2}-13` });
    await ok('POST', `/companies/${co}/tax/wht/${M1}/pnd3/remit`, { date: `${M2}-07`, cashAccount: '1120' });
    await ok('POST', `/companies/${co}/tax/wht/${M1}/pnd53/remit`, { date: `${M2}-07`, cashAccount: '1120' });
  });

  it('เงินเดือน · ตรวจนับ B ขาด 1 ชิ้น (ตัดที่ต้นทุนถัวเฉลี่ย 32.66)', async () => {
    await ok('POST', `/companies/${co}/journal`, { date: `${M2}-25`, description: 'เงินเดือน', lines: [
      { account_code: '5210', debit: '15000' }, { account_code: '1120', credit: '15000' }] });
    const adj = await ok('POST', `/companies/${co}/inventory/adjustments`, { itemCode: 'B', date: `${M2}-30`, quantity: '-1', offsetAccount: '5260', description: 'ตรวจนับขาด' });
    expect(await lines(adj.entryId ?? adj.entry_id ?? (await db.query(
      `select entry_id from acc.inventory_movements where company_id = $1 and item_id = (select id from acc.items where company_id = $1 and code = 'B') order by created_at desc limit 1`, [co])).rows[0].entry_id))
      .toEqual({ 1310: ['0.00', '32.66'], 5260: ['32.66', '0.00'] });
  });

  it('ขายคอมพิวเตอร์ 30,000 ใน พ.ย.: ไม่คิดค่าเสื่อมเดือนที่จำหน่าย (assumptions ข้อ 32) → ราคาตามบัญชี 35,000 ขาดทุน 5,000', async () => {
    // ลงค่าเสื่อม พ.ย. ก่อนแล้วจำหน่ายใน พ.ย. ไม่ได้ (กติกาของระบบ ต่างจาก Express ที่คิดตามวันถึงวันจำหน่าย: docs/accounting-audit.md)
    const d = await ok('POST', `/companies/${co}/fixed-assets/${id.fa}/dispose`, { date: `${M2}-30`, proceeds: '30000', proceedsAccount: '1120' });
    const e = (await db.query(`select entry_id from acc.asset_disposals where id = $1`, [d.id])).rows[0].entry_id;
    expect(await lines(e)).toEqual({ 1120: ['30000.00', '0.00'], 1630: ['0.00', '36000.00'], 1631: ['1000.00', '0.00'], 5320: ['5000.00', '0.00'] });
    // สินทรัพย์ที่จำหน่ายแล้วไม่ถูกคิดค่าเสื่อมอีก
    expect((await as('POST', `/companies/${co}/depreciation`, { month: M2 })).statusCode).toBe(409);
  });

  it('ภ.พ.30 พ.ย. ชำระเกินอีก 133 (สะสม 1,409.32) · งบทดลอง/งบการเงินสะสม ตรงเฉลย', async () => {
    const vat = await ok('GET', `/companies/${co}/tax/vat?month=${M2}`);
    expect([vat.preview.outputVat, vat.preview.inputVat]).toEqual(['602.00', '735.00']);
    await ok('POST', `/companies/${co}/tax/vat/${M2}/close`);
    expect(await tbNet(co, M2)).toEqual({
      1110: '17539.00', 1120: '473486.00', 1210: '9202.00', 1310: '7456.03', 1420: '600.00', 1430: '1409.32',
      2110: '-17369.57', 2310: '-1500.00', 3110: '-500000.00',
      4110: '-18700.00', 4120: '-20000.00', 4220: '800.00', 5130: '11544.56', 5210: '15000.00', 5220: '10000.00', 5230: '1500.00',
      5250: '1000.00', 5260: '3032.66', 5320: '5000.00' });
    const ytd = await ok('GET', `/companies/${co}/statements?month=${M2}&scope=ytd`);
    expect([ytd.totalRevenue, ytd.totalExpense, ytd.netIncome]).toEqual(['37900.00', '47077.22', '-9177.22']);
    expect([ytd.totalAssets, ytd.totalLiabilities, ytd.totalEquity, ytd.balanced]).toEqual(['509692.35', '18869.57', '490822.78', true]);
    const mo = await ok('GET', `/companies/${co}/statements?month=${M2}&scope=month`);
    expect([mo.totalRevenue, mo.totalExpense, mo.netIncome]).toEqual(['8600.00', '25591.69', '-16991.69']);
    // ทะเบียนลูกหนี้/เจ้าหนี้ = ยอดคุม
    const ar = await ok('GET', `/companies/${co}/receivables?asOf=${M2}-30`);
    const ap = await ok('GET', `/companies/${co}/payables?asOf=${M2}-30`);
    const open = (r: { rows?: { open: string }[]; items?: { open: string }[] }) => (r.rows ?? r.items ?? []).reduce((s, x) => s + Math.round(Number(x.open) * 100), 0) / 100;
    expect(open(ar)).toBe(9202);
    expect(open(ap)).toBe(17369.57);
    const inv = (await db.query(`select i.code, b.quantity::text q, b.value::text v from acc.items i cross join lateral acc.inventory_balance(i.company_id, i.id) b
      where i.company_id = $1 and i.track_inventory order by 1`, [co])).rows;
    expect(inv).toEqual([{ code: 'A', q: '140.000', v: '7325.37' }, { code: 'B', q: '4.000', v: '130.66' }]);
  });
});

describe('กรณีขอบของการคำนวณ', () => {
  async function setup(vat = true) {
    const school = await newSchool();
    const teacher = await newUser(school, 'teacher');
    owner = await newUser(school, 'student');
    const c = await newCompany(owner, await newClassroom(school, teacher, [owner]));
    const prof = await ok('GET', `/companies/${c}/profile`);
    await ok('PATCH', `/companies/${c}/profile`, { version: prof.version, taxId: taxId(8001), vatRegistered: vat });
    await ok('POST', `/companies/${c}/parties`, { code: 'C1', name: 'ลูกค้า', isCustomer: true, isVendor: false, taxId: taxId(8101), vatRegistered: true });
    await ok('POST', `/companies/${c}/parties`, { code: 'V1', name: 'ผู้ขาย', isCustomer: false, isVendor: true, taxId: juristicTaxId(8201), vatRegistered: true });
    for (const k of ['X', 'Y', 'Z']) await ok('POST', `/companies/${c}/items`, { code: k, name: 'สินค้า ' + k, isService: false, trackInventory: true });
    await ok('POST', `/companies/${c}/items`, { code: 'S', name: 'บริการ', isService: true });
    await ok('POST', `/companies/${c}/journal`, { date: '2026-10-01', lines: [{ account_code: '1120', debit: '1000000' }, { account_code: '3110', credit: '1000000' }] });
    return c;
  }
  const stock = async (c: string) => (await db.query(`select i.code, b.quantity::text q, b.value::text v from acc.items i
    cross join lateral acc.inventory_balance(i.company_id, i.id) b where i.company_id = $1 and i.track_inventory and b.quantity <> 0 or i.company_id = $1 and b.value <> 0 order by 1`, [c])).rows;

  it('ส่วนลดท้ายบิลหลายบรรทัด: ต้นทุนรับเข้าคลังรวม = ยอดที่ลงบัญชีซื้อพอดี (บัญชี 5110 ไม่มีเศษค้าง)', async () => {
    const c = await setup();
    // 3 × 100 ลด 1 → ฐาน 299.00 แบ่ง 99.66 / 99.67 / 99.67 (เดิมปัดแยก 99.67 × 3 = 299.01)
    const pi = await ok('POST', `/companies/${c}/purchases/invoice`, { date: '2026-10-02', partyCode: 'V1', vendorDocNo: 'P1', discount: '1',
      lines: ['X', 'Y', 'Z'].map((k) => ({ itemCode: k, qty: '1', unitPrice: '100' })) });
    expect(await invEntry('purchase_receipt', pi.id)).toEqual({ 1310: ['299.00', '0.00'], 5110: ['0.00', '299.00'] });
    expect((await tbNet(c, '2026-10'))['5110']).toBeUndefined();
    expect((await stock(c)).reduce((s, r) => s + Number(r.v), 0).toFixed(2)).toBe('299.00');
    // ส่งคืนทั้งใบด้วยส่วนลดเท่าเดิม ก็ต้องรวมพอดี
    const pn = await ok('POST', `/companies/${c}/purchases/credit-note`, { date: '2026-10-03', refDocumentId: pi.id, vendorDocNo: 'N1', reason: 'คืน', discount: '1',
      lines: ['X', 'Y', 'Z'].map((k) => ({ itemCode: k, qty: '1', unitPrice: '100' })) });
    expect(await invEntry('purchase_return', pn.id)).toEqual({ 1310: ['0.00', '299.00'], 5140: ['299.00', '0.00'] });
    expect(await stock(c)).toEqual([]);
    // หลายบัญชีในใบเดียว (สินค้า 5110 + อุปกรณ์ 1630) มีส่วนลด: 5110 ยังไม่มีเศษค้าง
    await ok('POST', `/companies/${c}/purchases/invoice`, { date: '2026-10-04', partyCode: 'V1', vendorDocNo: 'P1b', discount: '0.07', lines: [
      { itemCode: 'X', qty: '1', unitPrice: '100' }, { itemCode: 'Y', qty: '2', unitPrice: '33.33' }, { description: 'ชั้นวาง', qty: '1', unitPrice: '100.01', accountCode: '1630' }] });
    const tb = await tbNet(c, '2026-10');
    expect(tb['5110']).toBeUndefined();
    expect((Number(tb['1310']) + Number(tb['1630'])).toFixed(2)).toBe('266.60'); // 100 + 66.66 + 100.01 − 0.07
  });

  it('บริษัทไม่จด VAT: ภาษีที่ผู้ขายเรียกเก็บรวมเป็นต้นทุนสินค้า · ขายไม่มีภาษีขาย', async () => {
    const c = await setup(false);
    const pi = await ok('POST', `/companies/${c}/purchases/invoice`, { date: '2026-10-02', partyCode: 'V1', vendorDocNo: 'P4', lines: [{ itemCode: 'X', qty: '10', unitPrice: '100' }] });
    expect(await docEntry(pi.id)).toEqual({ 2110: ['0.00', '1070.00'], 5110: ['1070.00', '0.00'] });
    const iv = await ok('POST', `/companies/${c}/sales/invoice`, { date: '2026-10-05', partyCode: 'C1', lines: [{ itemCode: 'X', qty: '4', unitPrice: '150' }] });
    expect(await docEntry(iv.id)).toEqual({ 1210: ['600.00', '0.00'], 4110: ['0.00', '600.00'] });
    expect(await invEntry('sales_cogs', iv.id)).toEqual({ 1310: ['0.00', '428.00'], 5130: ['428.00', '0.00'] });
  });

  it('รับชำระบริการสองงวด: ภาษีขายโอนตามสัดส่วน รวมเท่าภาษีทั้งใบ · จ่ายบางส่วนหัก 3% จากฐานของส่วนที่จ่าย', async () => {
    const c = await setup();
    const iv = await ok('POST', `/companies/${c}/sales/invoice`, { date: '2026-10-02', partyCode: 'C1', lines: [{ itemCode: 'S', qty: '1', unitPrice: '10000' }] });
    const r1 = await ok('POST', `/companies/${c}/receipts`, { date: '2026-10-10', partyCode: 'C1', cashAccount: '1120', allocations: [{ documentId: iv.id, amount: '3333.33' }] });
    expect((await docEntry(r1.id))['2210']).toEqual(['0.00', '218.07']); // 3,333.33 × 700 / 10,700
    const r2 = await ok('POST', `/companies/${c}/receipts`, { date: '2026-10-20', partyCode: 'C1', cashAccount: '1120', allocations: [{ documentId: iv.id, amount: '7366.67' }] });
    expect((await docEntry(r2.id))['2210']).toEqual(['0.00', '481.93']); // ครั้งสุดท้ายรับภาษีที่เหลือพอดี
    expect((await tbNet(c, '2026-10'))['2211']).toBeUndefined();
    const pi = await ok('POST', `/companies/${c}/purchases/invoice`, { date: '2026-10-02', partyCode: 'V1', vendorDocNo: 'P6', lines: [{ itemCode: 'S', qty: '1', unitPrice: '10000' }] });
    const pv = await ok('POST', `/companies/${c}/payments`, { date: '2026-10-10', partyCode: 'V1', cashAccount: '1120', whtKind: 'service', allocations: [{ documentId: pi.id, amount: '5350' }] });
    expect(await docEntry(pv.id)).toEqual({ 1120: ['0.00', '5200.00'], 1410: ['350.00', '0.00'], 1411: ['0.00', '350.00'], 2110: ['5350.00', '0.00'], 2230: ['0.00', '150.00'] });
  });

  it('ภ.พ.30: ภาษีชำระเกินเดือนก่อนนำมาหักก่อนคิดยอดต้องชำระ · ราคารวม VAT แยกภาษีจากยอดทั้งใบ', async () => {
    const c = await setup();
    await ok('POST', `/companies/${c}/purchases/invoice`, { date: '2026-10-02', partyCode: 'V1', vendorDocNo: 'P8', lines: [{ itemCode: 'X', qty: '10', unitPrice: '100' }] });
    await ok('POST', `/companies/${c}/tax/vat/2026-10/close`);
    const iv = await ok('POST', `/companies/${c}/sales/invoice`, { date: '2026-11-05', partyCode: 'C1', lines: [{ itemCode: 'X', qty: '10', unitPrice: '150' }] });
    const vc = await ok('POST', `/companies/${c}/tax/vat/2026-11/close`);
    const e = (await db.query(`select entry_id from acc.vat_closings where id = $1`, [vc.id])).rows[0].entry_id;
    expect(await lines(e)).toEqual({ 1430: ['0.00', '70.00'], 2210: ['105.00', '0.00'], 2220: ['0.00', '35.00'] });
    await ok('POST', `/companies/${c}/sales/documents/${iv.id}/void`, { date: '2026-12-01', reason: 'ทดสอบ' }).catch(() => null);
    const cs = await ok('POST', `/companies/${c}/sales/cash-sale`, { date: '2026-12-05', partyCode: 'C1', priceMode: 'inclusive',
      lines: [{ itemCode: 'Y', qty: '3', unitPrice: '99.99', description: 'ไม่ตัดสต็อก' }].map((l) => ({ ...l, itemCode: undefined })) });
    const d = await ok('GET', `/companies/${c}/sales/documents/${cs.id}`);
    expect([d.base, d.vat, d.total]).toEqual(['280.35', '19.62', '299.97']); // 299.97 × 7/107 = 19.624
  });
});

describe('ต้นทุนถัวเฉลี่ยตามลำดับวันที่ (แบบ Express): ลงย้อนวันที่ / ยกเลิก → คำนวณใหม่', () => {
  async function setup() {
    const school = await newSchool();
    const teacher = await newUser(school, 'teacher');
    owner = await newUser(school, 'student');
    const c = await newCompany(owner, await newClassroom(school, teacher, [owner]));
    const prof = await ok('GET', `/companies/${c}/profile`);
    await ok('PATCH', `/companies/${c}/profile`, { version: prof.version, taxId: taxId(9001), vatRegistered: true });
    await ok('POST', `/companies/${c}/parties`, { code: 'C1', name: 'ลูกค้า', isCustomer: true, isVendor: false, taxId: taxId(9101), vatRegistered: true });
    await ok('POST', `/companies/${c}/parties`, { code: 'V1', name: 'ผู้ขาย', isCustomer: false, isVendor: true, taxId: juristicTaxId(9201), vatRegistered: true });
    await ok('POST', `/companies/${c}/items`, { code: 'X', name: 'สินค้า X', isService: false, trackInventory: true });
    return c;
  }
  let n = 0;
  const buy = (c: string, date: string, qty: string, price: string) =>
    ok('POST', `/companies/${c}/purchases/invoice`, { date, partyCode: 'V1', vendorDocNo: `B-${++n}`, lines: [{ itemCode: 'X', qty, unitPrice: price }] });
  const sell = (c: string, date: string, qty: string) =>
    as('POST', `/companies/${c}/sales/invoice`, { date, partyCode: 'C1', lines: [{ itemCode: 'X', qty, unitPrice: '500' }] });
  const bal = async (c: string) => (await db.query(`select quantity::text q, value::text v from acc.inventory_balance($1, (select id from acc.items where company_id = $1 and code = 'X'))`, [c])).rows[0];
  /** ต้นทุนขายของใบขาย ณ ตอนนี้ (รายการต้นทุนปัจจุบัน) */
  const cogsOf = async (docId: string) => {
    const r = await db.query(`select distinct x.cur_entry_id from acc.inventory_movements_effective x
      join acc.inventory_document_posts p on p.company_id = x.company_id and p.entry_id = x.entry_id where p.source_id = $1`, [docId]);
    return lines(r.rows[0].cur_entry_id);
  };
  /** 1310 ในงบทดลอง = มูลค่าตามบัตรสต็อก */
  const glMatches = async (c: string) => expect((await tbNet(c, '2026-10'))['1310'] ?? '0.00').toBe(Number((await bal(c)).v).toFixed(2));

  it('ขายลงวันที่ระหว่างการซื้อสองครั้ง (บันทึกทีหลัง): ใช้ถัวเฉลี่ย ณ วันที่ขาย ไม่ใช่ล่าสุด', async () => {
    const c = await setup();
    await buy(c, '2026-10-01', '10', '100');
    await buy(c, '2026-10-20', '10', '200');
    const iv = (await sell(c, '2026-10-10', '5')).json();
    expect(await invEntry('sales_cogs', iv.id)).toEqual({ 1310: ['0.00', '500.00'], 5130: ['500.00', '0.00'] }); // เดิมคิด 750
    expect(await bal(c)).toEqual({ q: '15.000', v: '2500.00' });
    await glMatches(c);
  });

  it('ขายก่อนวันที่ของเข้า / ทำให้รายการหลังจากนั้นสต็อกติดลบ → ปฏิเสธ', async () => {
    const c = await setup();
    await buy(c, '2026-10-20', '10', '100');
    const early = await sell(c, '2026-10-05', '10');
    expect([early.statusCode, early.json().message]).toEqual([422, expect.stringContaining('ณ วันที่ 05/10/2569')]);
    const later = (await sell(c, '2026-10-25', '8')).json();
    expect(later.id).toBeTruthy();
    // ณ 22 ต.ค. มี 10 ขายได้ 5 แต่ทำให้ใบวันที่ 25 (8 ชิ้น) ขาด
    const mid = await sell(c, '2026-10-22', '5');
    expect([mid.statusCode, mid.json().message]).toEqual([422, expect.stringContaining('ไม่พอตัดออก')]);
    expect(await bal(c)).toEqual({ q: '2.000', v: '200.00' });
  });

  it('ซื้อลงย้อนวันที่ก่อนใบขาย: กลับรายการต้นทุนเดิม (RV) ลงใหม่ (CG) วันที่เดิม · ตรวจคำตอบไม่นับคู่ที่กลับ', async () => {
    const c = await setup();
    await buy(c, '2026-10-01', '10', '100');
    const iv = (await sell(c, '2026-10-15', '5')).json();
    expect(await cogsOf(iv.id)).toEqual({ 1310: ['0.00', '500.00'], 5130: ['500.00', '0.00'] });
    await buy(c, '2026-10-05', '10', '200'); // ถัวเฉลี่ย ณ 15 ต.ค. = 3,000 / 20 = 150
    expect(await cogsOf(iv.id)).toEqual({ 1310: ['0.00', '750.00'], 5130: ['750.00', '0.00'] });
    const rs = (await db.query(`select r.entry_id, o.doc_no old_no, v.doc_no rv_no, v.entry_date::text rv_date, v.reverses_entry_id = r.entry_id linked,
        n.doc_no new_no, n.entry_date::text new_date, n.description from acc.inventory_restatements r
        join acc.journal_entries o on o.company_id = r.company_id and o.id = r.entry_id
        join acc.journal_entries v on v.company_id = r.company_id and v.id = r.reversal_entry_id
        join acc.journal_entries n on n.company_id = r.company_id and n.id = r.new_entry_id where r.company_id = $1`, [c])).rows;
    expect(rs).toHaveLength(1);
    expect(rs[0]).toMatchObject({ rv_date: '2026-10-15', new_date: '2026-10-15', linked: true });
    expect(rs[0].old_no).toMatch(/^CG-/);
    expect(rs[0].rv_no).toMatch(/^RV-/);
    expect(rs[0].new_no).toMatch(/^CG-/);
    expect(rs[0].description).toContain('ลงย้อนวันที่');
    expect((await tbNet(c, '2026-10'))['5130']).toBe('750.00');
    expect(await bal(c)).toEqual({ q: '15.000', v: '2250.00' });
    await glMatches(c);
    // ตรวจคำตอบ: รายการที่ถูกกลับและการกลับรายการไม่ถูกนับ เหลือ CG ใหม่ 750
    const keys = (await db.query(`select app.company_entry_keys($1) k`, [c])).rows[0].k as { doc: string; key: string[] }[];
    expect(keys.filter((k) => k.doc.startsWith('CG-')).map((k) => k.key)).toEqual([['1310|C|750.00', '5130|D|750.00']]);
    // บัตรสต็อกแสดงค่าหลังคำนวณใหม่ เรียงตามวันที่
    const card = (await ok('GET', `/companies/${c}/inventory/X`)).card as { date: string; valueOut: string; balanceValue: string; entryDocNo: string; restated: boolean }[];
    expect(card.map((r) => [r.date, r.valueOut, r.balanceValue])).toEqual([
      ['2026-10-01', '0', '1000.00'], ['2026-10-05', '0', '3000.00'], ['2026-10-15', '750.00', '2250.00']]);
    expect(card[2]).toMatchObject({ entryDocNo: rs[0].new_no, restated: true });
    // ยกเลิกใบขายที่คำนวณใหม่แล้ว: กลับ CG ปัจจุบัน (750) สต็อกกลับครบ
    await ok('POST', `/companies/${c}/sales/documents/${iv.id}/void`, { date: '2026-10-16', reason: 'ทดสอบ' });
    expect((await tbNet(c, '2026-10'))['5130']).toBeUndefined();
    expect(await bal(c)).toEqual({ q: '20.000', v: '3000.00' });
    await glMatches(c);
  });

  it('ยกเลิกใบซื้อที่อยู่ก่อนใบขาย: คิดใหม่เหมือนไม่เคยซื้อ · ยกเลิกแล้วทำให้สต็อกติดลบไม่ได้', async () => {
    const c = await setup();
    await buy(c, '2026-10-01', '10', '100');
    const p2 = await buy(c, '2026-10-05', '10', '200');
    const iv = (await sell(c, '2026-10-10', '10')).json();
    expect(await cogsOf(iv.id)).toEqual({ 1310: ['0.00', '1500.00'], 5130: ['1500.00', '0.00'] });
    await ok('POST', `/companies/${c}/purchases/documents/${p2.id}/void`, { date: '2026-10-12', reason: 'บันทึกผิด' });
    expect(await cogsOf(iv.id)).toEqual({ 1310: ['0.00', '1000.00'], 5130: ['1000.00', '0.00'] });
    expect(await bal(c)).toEqual({ q: '0.000', v: '0.00' });
    await glMatches(c);
    // ซื้อชุดแรกถูกขายไปหมดแล้ว: ยกเลิกแล้ววันที่ 10 ต.ค. จะขายของที่ไม่มี → ไม่ได้
    const p1 = (await db.query(`select id from acc.purchase_documents where company_id = $1 and vendor_doc_no = $2`, [c, `B-${n - 1}`])).rows[0];
    const r = await as('POST', `/companies/${c}/purchases/documents/${p1.id}/void`, { date: '2026-10-12', reason: 'ทดสอบ' });
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    expect(r.statusCode).toBeLessThan(500);
    expect(await cogsOf(iv.id)).toEqual({ 1310: ['0.00', '1000.00'], 5130: ['1000.00', '0.00'] });
  });

  it('รับคืนจากลูกค้าตามต้นทุนใบขายที่คำนวณใหม่', async () => {
    const c = await setup();
    await buy(c, '2026-10-01', '10', '100');
    const iv = (await sell(c, '2026-10-10', '4')).json();
    const cn = await ok('POST', `/companies/${c}/sales/credit-note`, { date: '2026-10-12', refDocumentId: iv.id, reason: 'คืน', lines: [{ itemCode: 'X', qty: '2', unitPrice: '500' }] });
    expect(await cogsOf(cn.id)).toEqual({ 1310: ['200.00', '0.00'], 5130: ['0.00', '200.00'] });
    await buy(c, '2026-10-05', '10', '130'); // ถัวเฉลี่ย ณ 10 ต.ค. = 2,300 / 20 = 115
    expect(await cogsOf(iv.id)).toEqual({ 1310: ['0.00', '460.00'], 5130: ['460.00', '0.00'] });
    expect(await cogsOf(cn.id)).toEqual({ 1310: ['230.00', '0.00'], 5130: ['0.00', '230.00'] });
    expect((await tbNet(c, '2026-10'))['5130']).toBe('230.00');
    expect(await bal(c)).toEqual({ q: '18.000', v: '2070.00' });
    await glMatches(c);
  });

  it('สุ่ม 80 เอกสาร (ซื้อ/ขาย/รับคืน/ยกเลิก วันที่สุ่ม): ต้นทุนทุกใบตรงโมเดลถัวเฉลี่ยตามวันที่ที่คิดแยก · ไม่มีวันไหนติดลบ · 1310 = บัตรสต็อก', async () => {
    const c = await setup();
    let seed = 20261110;
    const rnd = (k: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return Math.floor(seed / 65536) % k; };
    type Doc = { id: string; kind: 'buy' | 'sell' | 'ret'; date: string; seq: number; qty: bigint; cents?: bigint; ref?: string; voided?: boolean };
    const docs: Doc[] = [];
    let seq = 0;
    for (let i = 0; i < 80; i++) {
      const date = `2026-10-${String(1 + rnd(28)).padStart(2, '0')}`;
      const op = rnd(10);
      if (op < 4) {
        const qty = 1 + rnd(20), price = 1000 + rnd(9000); // 10.00–99.99
        const d = await buy(c, date, String(qty), (price / 100).toFixed(2));
        docs.push({ id: d.id, kind: 'buy', date, seq: seq++, qty: BigInt(qty), cents: BigInt(qty * price) });
      } else if (op < 8) {
        const qty = 1 + rnd(8);
        const r = await sell(c, date, String(qty));
        if (r.statusCode === 201) docs.push({ id: r.json().id, kind: 'sell', date, seq: seq++, qty: BigInt(qty) });
        else expect(r.json().code).toBe('ACC15');
      } else if (op < 9) {
        const sales = docs.filter((d) => d.kind === 'sell' && !d.voided && !docs.some((x) => x.ref === d.id));
        if (!sales.length) continue;
        const s0 = sales[rnd(sales.length)];
        const r = await as('POST', `/companies/${c}/sales/credit-note`, { date: s0.date > date ? s0.date : date, refDocumentId: s0.id, reason: 'คืน',
          lines: [{ itemCode: 'X', qty: '1', unitPrice: '500' }] });
        if (r.statusCode === 201) docs.push({ id: r.json().id, kind: 'ret', date: s0.date > date ? s0.date : date, seq: seq++, qty: 1n, ref: s0.id });
        else expect(r.json().code).toBe('ACC15');
      } else {
        const live = docs.filter((d) => !d.voided && d.kind !== 'ret' && !docs.some((x) => x.ref === d.id && !x.voided));
        if (!live.length) continue;
        const d = live[rnd(live.length)];
        const url = d.kind === 'buy' ? `/companies/${c}/purchases/documents/${d.id}/void` : `/companies/${c}/sales/documents/${d.id}/void`;
        const r = await as('POST', url, { date: '2026-10-28', reason: 'สุ่ม' });
        if (r.statusCode === 200) d.voided = true;
        else expect(r.statusCode).toBeLessThan(500);
      }
    }
    // โมเดล: เรียงตามวันที่ แล้วลำดับที่บันทึก (รายการยกเลิกไม่นับ) หน่วยสตางค์ ต้นทุนต่อหน่วย 6 ตำแหน่ง ปัดครึ่งขึ้น
    const div = (a: bigint, b: bigint) => (2n * a + b) / (2n * b); // a, b > 0
    const live = docs.filter((d) => !d.voided).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.seq - b.seq));
    let Q = 0n, V = 0n;
    const unit = new Map<string, bigint>(); // ต้นทุนต่อหน่วย × 10^6 บาท = สตางค์ × 10^4
    const cost = new Map<string, bigint>();
    for (const d of live) {
      if (d.kind === 'buy') { Q += d.qty; V += d.cents!; continue; }
      if (d.kind === 'sell') {
        expect(Q >= d.qty, `สต็อก ณ ${d.date} ต้องพอ`).toBe(true);
        const u = div(V * 10000n, Q);
        const cst = d.qty === Q ? V : div(d.qty * u, 10000n);
        unit.set(d.id, u); cost.set(d.id, cst); Q -= d.qty; V -= cst;
      } else {
        const cst = div(d.qty * unit.get(d.ref!)!, 10000n);
        cost.set(d.id, cst); Q += d.qty; V += cst;
      }
      expect(Q >= 0n).toBe(true);
    }
    const money = (x: bigint) => `${x / 100n}.${String(x % 100n).padStart(2, '0')}`;
    for (const d of live.filter((x) => x.kind !== 'buy')) {
      const l = await cogsOf(d.id);
      expect(d.kind === 'sell' ? l['5130'][0] : l['5130'][1], `${d.kind} ${d.date}`).toBe(money(cost.get(d.id)!));
    }
    expect(await bal(c)).toEqual({ q: `${Q}.000`, v: money(V) });
    await glMatches(c);
    expect(live.filter((d) => d.kind === 'sell').length).toBeGreaterThan(5);
    const stat = (await db.query(`select (select count(*)::int from acc.inventory_restatements where company_id = $1) restated`, [c])).rows[0];
    expect(stat.restated).toBeGreaterThan(5); // มีการคำนวณใหม่จริงหลายครั้ง
    expect(docs.filter((d) => d.voided).length).toBeGreaterThan(2);
    expect(docs.filter((d) => d.kind === 'ret').length).toBeGreaterThan(2);
  });

  it('ขายหรือตัดสต็อกจนหมด: ไม่เหลือมูลค่าค้างแม้จำนวนมาก', async () => {
    const c = await setup();
    await buy(c, '2026-10-02', '30000', '0.33');
    await ok('POST', `/companies/${c}/inventory/adjustments`, { itemCode: 'X', date: '2026-10-02', quantity: '1', unitCost: '100', offsetAccount: '3110' });
    const iv = (await sell(c, '2026-10-05', '30001')).json(); // 30,001 ชิ้น 10,000.00 → ต้นทุน 10,000.00 (เดิม 9,999.99 ค้าง 0.01)
    expect(await invEntry('sales_cogs', iv.id)).toEqual({ 1310: ['0.00', '10000.00'], 5130: ['10000.00', '0.00'] });
    expect(await bal(c)).toEqual({ q: '0.000', v: '0.00' });
  });
});
