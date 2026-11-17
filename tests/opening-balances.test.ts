import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../apps/api/src/app';
import { devAuth } from '../apps/api/src/auth';
import { authConfigFromEnv } from '../apps/api/src/config';
import { createPool } from '../apps/api/src/db';
import { apiUrl } from './global-setup';
import { pool as db, asUser, newSchool, newUser, newClassroom, newCompany, taxId } from './helpers';

// ยอดยกมาพร้อมรายตัว (docs/phase5-spec.md ข้อ 3) เฉลยคิดด้วยมือล่วงหน้า เทียบทุกบรรทัด
const apiPool = createPool(apiUrl());
const app = buildApp({ pool: apiPool, auth: devAuth(), cfg: { ...authConfigFromEnv({}), allowedOrigins: false } });
afterAll(async () => { await app.close(); await apiPool.end(); await db.end(); });

type Method = 'GET' | 'POST' | 'PATCH';
let owner: string;
const call = (method: Method, url: string, payload?: unknown, key = randomUUID()) =>
  app.inject({ method, url, payload: payload as object, headers: { 'x-dev-user-id': owner, 'x-dev-role': 'student', 'idempotency-key': key } });
async function ok(method: Method, url: string, payload?: unknown, key?: string) {
  const r = await call(method, url, payload, key);
  if (r.statusCode >= 300) throw new Error(`${method} ${url} → ${r.statusCode} ${r.body}`);
  return r.json();
}
/** รายการบัญชีหนึ่งรายการ รวมตามบัญชี { รหัส: [เดบิต, เครดิต] } */
async function lines(entryId: string) {
  const r = await db.query(
    `select a.code, sum(l.debit)::numeric(18,2)::text d, sum(l.credit)::numeric(18,2)::text c
       from acc.journal_lines l join acc.chart_of_accounts a on a.company_id = l.company_id and a.id = l.account_id
      where l.entry_id = $1 group by a.code order by a.code`, [entryId]);
  return Object.fromEntries(r.rows.map((x) => [x.code, [x.d, x.c]]));
}
const docEntry = async (id: string) => lines((await db.query(
  `select entry_id from acc.documents where id = $1 union all select entry_id from acc.purchase_documents where id = $1`, [id])).rows[0].entry_id);
async function tb(co: string, month: string) {
  const t = await ok('GET', `/companies/${co}/trial-balance?month=${month}`);
  expect(t.totalDebit).toBe(t.totalCredit);
  return Object.fromEntries((t.rows as { code: string; debit: string; credit: string }[]).map((r) => [r.code, [r.debit, r.credit]]));
}

async function company() {
  const school = await newSchool();
  const teacher = await newUser(school, 'teacher');
  owner = await newUser(school, 'student');
  const co = await newCompany(owner, await newClassroom(school, teacher, [owner]));
  const prof = await ok('GET', `/companies/${co}/profile`);
  await ok('PATCH', `/companies/${co}/profile`, { version: prof.version, taxId: taxId(9501), vatRegistered: true });
  await ok('POST', `/companies/${co}/parties`, { code: 'C1', name: 'ร้าน ลูกค้าหนึ่ง', isCustomer: true, isVendor: false, taxId: taxId(9511), vatRegistered: true, creditDays: 30 });
  await ok('POST', `/companies/${co}/parties`, { code: 'V1', name: 'บริษัท ขายส่ง จำกัด', isCustomer: false, isVendor: true, taxId: taxId(9521), vatRegistered: true });
  await ok('POST', `/companies/${co}/parties`, { code: 'V3', name: 'บริษัท บริการ จำกัด', isCustomer: false, isVendor: true, taxId: taxId(9531), vatRegistered: true, whtKind: 'service' });
  await ok('POST', `/companies/${co}/items`, { code: 'A', name: 'สินค้า A', unit: 'ชิ้น', isService: false, trackInventory: true });
  return co;
}

// ยอดยกมา 31 ธ.ค. 2568: เดบิต 307,510 = เครดิต 307,510
const OB = {
  date: '2025-12-31',
  accounts: [{ code: '1110', debit: '50000' }, { code: '1120', debit: '200000' }, { code: '3110', credit: '250000' }, { code: '3210', credit: '8550' }],
  receivables: [
    { partyCode: 'C1', ref: 'INV-901', date: '2025-11-15', amount: '10700' },
    { partyCode: 'C1', ref: 'INV-905', date: '2025-12-10', amount: '5350', undueVat: '350' },
  ],
  payables: [
    { partyCode: 'V1', ref: 'P-77', date: '2025-12-01', amount: '21400' },
    { partyCode: 'V3', ref: 'S-12', date: '2025-12-20', amount: '3210', undueVat: '210' },
  ],
  assets: [{ code: 'FA-1', name: 'คอมพิวเตอร์', acquiredDate: '2024-01-01', cost: '36000', lifeMonths: 36, assetAccount: '1630', accumAccount: '1631', accumulated: '24000' }],
  inventory: [{ itemCode: 'A', qty: '100', unitCost: '52.50' }],
};

describe('ยอดยกมาพร้อมรายตัว', () => {
  let co: string;
  let obEntry: string;
  beforeAll(async () => { co = await company(); });

  it('กรณีผิด: ไม่ดุล · พิมพ์บัญชีคุมเอง · ค่าเสื่อมสะสมไม่ตรงวิธีเส้นตรง', async () => {
    const unbalanced = await call('POST', `/companies/${co}/opening`, { ...OB, accounts: OB.accounts.slice(0, 3) });
    expect([unbalanced.statusCode, unbalanced.json().message]).toEqual([422, 'เดบิต 307,510.00 ไม่เท่าเครดิต 298,960.00 ผลต่าง 8,550.00']);
    const typed = await call('POST', `/companies/${co}/opening`, { ...OB, accounts: [...OB.accounts, { code: '1210', debit: '1' }] });
    expect([typed.statusCode, typed.json().code]).toEqual([409, 'ACC21']);
    expect(typed.json().message).toContain('บัญชี 1210 เป็นบัญชีคุม');
    const acc = await call('POST', `/companies/${co}/opening`, { ...OB, assets: [{ ...OB.assets[0], accumulated: '23000' }] });
    expect([acc.statusCode, acc.json().message]).toEqual([422, 'สินทรัพย์ FA-1: ค่าเสื่อมราคาสะสม ณ 31/12/2568 ต้องเป็น 24,000.00 (เส้นตรง 24 เดือน เดือนละ 1,000.00)']);
    expect((await db.query('select count(*)::int n from acc.journal_entries where company_id = $1', [co])).rows[0].n).toBe(0);
  });

  it('ลงยอดยกมา: OB-0001 ตรงเฉลยทุกบัญชี · กดซ้ำได้ผลเดิม · ชุดที่สองไม่ได้', async () => {
    const key = randomUUID();
    const r = await ok('POST', `/companies/${co}/opening`, OB, key);
    expect(r.docNo).toBe('OB-0001');
    expect(await ok('POST', `/companies/${co}/opening`, OB, key)).toEqual(r);
    obEntry = (await db.query(`select id from acc.journal_entries where company_id = $1 and doc_no = 'OB-0001'`, [co])).rows[0].id;
    expect(await lines(obEntry)).toEqual({
      1110: ['50000.00', '0.00'], 1120: ['200000.00', '0.00'], 1210: ['16050.00', '0.00'], 1310: ['5250.00', '0.00'],
      1411: ['210.00', '0.00'], 1630: ['36000.00', '0.00'], 1631: ['0.00', '24000.00'], 2110: ['0.00', '24610.00'],
      2211: ['0.00', '350.00'], 3110: ['0.00', '250000.00'], 3210: ['0.00', '8550.00'],
    });
    const again = await call('POST', `/companies/${co}/opening`, OB);
    expect([again.statusCode, again.json().code]).toEqual([409, 'ACC21']);
    const view = await ok('GET', `/companies/${co}/opening`);
    expect(view.opening.receivables.map((x: { docNo: string; dueDate: string; amount: string; undueVat: string }) => [x.docNo, x.dueDate, x.amount, x.undueVat]))
      .toEqual([['OB-0001/INV-901', '2025-12-15', '10700.00', '0.00'], ['OB-0001/INV-905', '2026-01-09', '5350.00', '350.00']]);
    expect(view.opening.assets).toEqual([{ code: 'FA-1', name: 'คอมพิวเตอร์', cost: '36000.00', accumulated: '24000.00', months: 24 }]);
  });

  it('รับชำระใบยกมา (บริการ): ภาษีขายยังไม่ถึงกำหนด 350 โอนเป็นภาษีขาย', async () => {
    const inv = (await db.query(`select id from acc.documents where company_id = $1 and doc_no = 'OB-0001/INV-905'`, [co])).rows[0].id;
    const re = await ok('POST', `/companies/${co}/receipts`, { date: '2026-01-10', partyCode: 'C1', cashAccount: '1120', allocations: [{ documentId: inv, amount: '5350' }] });
    expect(await docEntry(re.id)).toEqual({ 1120: ['5350.00', '0.00'], 1210: ['0.00', '5350.00'], 2210: ['0.00', '350.00'], 2211: ['350.00', '0.00'] });
  });

  it('จ่ายชำระใบยกมา (บริการ) หัก ณ ที่จ่าย 3% ของฐาน 3,000 = 90 · ภาษีซื้อ 210 ถึงกำหนด', async () => {
    const pi = (await db.query(`select id from acc.purchase_documents where company_id = $1 and doc_no = 'OB-0001/S-12'`, [co])).rows[0].id;
    const pv = await ok('POST', `/companies/${co}/payments`, { date: '2026-01-12', partyCode: 'V3', cashAccount: '1120', whtKind: 'service',
      allocations: [{ documentId: pi, amount: '3210' }] });
    expect(await docEntry(pv.id)).toEqual({ 1120: ['0.00', '3120.00'], 1410: ['210.00', '0.00'], 1411: ['0.00', '210.00'], 2110: ['3210.00', '0.00'], 2230: ['0.00', '90.00'] });
  });

  it('ค่าเสื่อมราคาเดือนแรกหลังยกมา = เดือนที่ 25 · 1,000 · ทะเบียนสะสม 25,000', async () => {
    const run = await ok('POST', `/companies/${co}/depreciation`, { month: '2026-01' });
    const e = (await db.query(`select entry_id from acc.depreciation_runs where id = $1`, [run.id])).rows[0].entry_id;
    expect(await lines(e)).toEqual({ 1631: ['0.00', '1000.00'], 5250: ['1000.00', '0.00'] });
    expect((await db.query(`select seq, dep_month::text m from acc.depreciation_lines where run_id = $1`, [run.id])).rows).toEqual([{ seq: 25, m: '2026-01-01' }]);
    const reg = await ok('GET', `/companies/${co}/fixed-assets?month=2026-01`);
    const fa = reg.assets.find((a: { code: string }) => a.code === 'FA-1');
    expect([fa.monthsPosted, fa.accumulated, fa.bookValue, fa.nextMonth]).toEqual([25, '25000.00', '11000.00', '2026-02']);
  });

  it('ขายสินค้ายกมา: ต้นทุนถัวเฉลี่ยจากต้นทุนยกมา 10 × 52.50', async () => {
    const iv = await ok('POST', `/companies/${co}/sales/invoice`, { date: '2026-01-15', partyCode: 'C1', lines: [{ itemCode: 'A', qty: '10', unitPrice: '80' }] });
    const cg = (await db.query(`select entry_id from acc.inventory_document_posts where source_kind = 'sales_cogs' and source_id = $1`, [iv.id])).rows[0].entry_id;
    expect(await lines(cg)).toEqual({ 1310: ['0.00', '525.00'], 5130: ['525.00', '0.00'] });
  });

  it('ทะเบียนย่อยเท่ายอดคุม · ยอดคงเหลือ ม.ค. 2569 ตรงเฉลย', async () => {
    const t = await tb(co, '2026-01');
    // 1210: 16,050 − 5,350 + 856 · 2110: 24,610 − 3,210 · 1310: 5,250 − 525
    expect([t['1210'], t['2110'], t['1310'], t['1631'], t['2211'], t['1411'], t['2230']])
      .toEqual([['11556.00', '0.00'], ['0.00', '21400.00'], ['4725.00', '0.00'], ['0.00', '25000.00'], undefined, undefined, ['0.00', '90.00']]);
    const ar = (await db.query(`select doc_no, open::text from acc.ar_open_items($1) order by doc_no`, [co])).rows;
    expect(ar.map((x) => [x.doc_no, x.open])).toEqual([['IV-0001', '856.00'], ['OB-0001/INV-901', '10700.00']]);
    const ap = (await db.query(`select doc_no, open::text from acc.ap_open_items($1)`, [co])).rows;
    expect(ap.map((x) => [x.doc_no, x.open])).toEqual([['OB-0001/P-77', '21400.00']]);
    const stock = (await db.query(`select b.quantity::text q, b.value::text v from acc.items i cross join lateral acc.inventory_balance(i.company_id, i.id) b
      where i.company_id = $1 and i.code = 'A'`, [co])).rows[0];
    expect(stock).toEqual({ q: '90.000', v: '4725.00' });
  });

  it('ยกเลิกรายใบไม่ได้ · กลับรายการ OB จากสมุดรายวันไม่ได้ · ยกเลิกทั้งชุดไม่ได้เมื่อมีรับชำระอ้าง', async () => {
    const inv = (await db.query(`select id from acc.documents where company_id = $1 and doc_no = 'OB-0001/INV-901'`, [co])).rows[0].id;
    const v = await call('POST', `/companies/${co}/sales/documents/${inv}/void`, { date: '2026-01-20', reason: 'ทดสอบ' });
    expect([v.statusCode, v.json().code]).toEqual([409, 'ACC16']);
    await expect(asUser(owner, (c) => c.query(`select acc.reverse_journal($1,$2,'2026-01-20',$3)`, [co, obEntry, randomUUID()])))
      .rejects.toMatchObject({ code: 'ACC16' });
    const fake = asUser(owner, (c) => c.query(`select acc.post_journal($1,'2026-01-20','x','[{"account_code":"1110","debit":"1"},{"account_code":"3110","credit":"1"}]'::jsonb,$2,'OB')`, [co, randomUUID()]));
    await expect(fake).rejects.toMatchObject({ code: 'ACC16' });
    const all = await call('POST', `/companies/${co}/opening/void`, { reason: 'ลงผิด' });
    expect([all.statusCode, all.json().message]).toEqual([409, 'ยอดยกมา OB-0001/INV-905 มีรับ/จ่ายชำระหรือลด/เพิ่มหนี้อ้างอยู่ ยกเลิกเอกสารเหล่านั้นก่อน']);
  });

  it('มีรายการก่อน/ในวันยกมาแล้ว ลงยอดยกมาไม่ได้', async () => {
    const c2 = await company();
    await ok('POST', `/companies/${c2}/journal`, { date: '2025-12-01', description: 'x', lines: [{ account_code: '1110', debit: '1' }, { account_code: '3110', credit: '1' }] });
    const r = await call('POST', `/companies/${c2}/opening`, OB);
    expect([r.statusCode, r.json().message]).toEqual([409, 'มีรายการวันที่ 01/12/2568 อยู่แล้ว วันยกมาต้องก่อนรายการอื่นทุกรายการ']);
  });

  it('ยกเลิกทั้งชุด: กลับรายการ OB ยกเลิกรายตัวทั้งหมด สต็อกเป็นศูนย์ · ขายสินค้ายกมาไปแล้วยกเลิกไม่ได้ (สต็อกติดลบ)', async () => {
    const c3 = await company();
    await ok('POST', `/companies/${c3}/opening`, OB);
    const v = await ok('POST', `/companies/${c3}/opening/void`, { reason: 'ลงผิดวันที่' });
    expect(v).toEqual({ voided: true, docNo: 'RV-0001' });
    expect(await tb(c3, '2025-12')).toEqual({});
    expect((await db.query(`select count(*)::int n from acc.ar_open_items($1)`, [c3])).rows[0].n).toBe(0);
    expect((await db.query(`select count(*)::int n from acc.ap_open_items($1)`, [c3])).rows[0].n).toBe(0);
    expect((await db.query(`select count(*)::int n from acc.fixed_assets where company_id = $1 and voided_at is null`, [c3])).rows[0].n).toBe(0);
    const stock = (await db.query(`select b.quantity::text q from acc.items i cross join lateral acc.inventory_balance(i.company_id, i.id) b
      where i.company_id = $1 and i.code = 'A'`, [c3])).rows[0];
    expect(stock.q).toBe('0.000');
    expect((await ok('GET', `/companies/${c3}/opening`)).opening).toBeNull();
    // ลงใหม่ได้ (รหัสสินทรัพย์/เลขที่ใบเดิมใช้ซ้ำได้หลังยกเลิก)
    const again = await ok('POST', `/companies/${c3}/opening`, OB);
    expect(again.docNo).toBe('OB-0002');
    await ok('POST', `/companies/${c3}/sales/invoice`, { date: '2026-01-15', partyCode: 'C1', lines: [{ itemCode: 'A', qty: '10', unitPrice: '80' }] });
    const blocked = await call('POST', `/companies/${c3}/opening/void`, { reason: 'ลองยกเลิก' });
    expect([blocked.statusCode, blocked.json().code]).toEqual([422, 'ACC15']);
  });
});
