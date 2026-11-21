import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { curriculumApp } from './curriculum-helpers';
import { pool as db } from './helpers';

// เฟส 6 โมดูล 4: ค่าเผื่อหนี้สงสัยจะสูญ · ตัดหนี้สูญ · หนี้สูญได้รับคืน (docs/phase6-spec.md ข้อ 4) เทียบเฉลยคิดมือ
// ลูกหนี้รายใบ (ทะเบียนย่อย) = บัญชีคุม 1210 ทุกขั้น
const { ok, as, close, setup } = curriculumApp();
afterAll(close);

let owner: string, other: string, co: string;
const id: Record<string, string> = {};
type Lines = Record<string, [string, string]>;
async function lines(entryId: string): Promise<Lines> {
  const r = await db.query(
    `select a.code, sum(l.debit)::numeric(18,2)::text d, sum(l.credit)::numeric(18,2)::text c, min(e.doc_prefix) p, min(e.entry_date)::text dt
       from acc.journal_lines l join acc.chart_of_accounts a on a.company_id = l.company_id and a.id = l.account_id
       join acc.journal_entries e on e.company_id = l.company_id and e.id = l.entry_id
      where l.entry_id = $1 group by a.code order by a.code`, [entryId]);
  return Object.fromEntries(r.rows.map((x) => [x.code, [x.d, x.c]]));
}
const entryOf = async (table: string, rowId: string) => (await db.query(`select entry_id from acc.${table} where id = $1`, [rowId])).rows[0].entry_id as string;
const status = (month: string) => ok(owner, 'GET', `/companies/${co}/bad-debts?month=${month}`);
const subledgerMatches = async (month: string) => {
  const s = await status(month);
  expect([s.receivables, s.matches]).toEqual([s.subledger, true]);
  return s;
};

beforeAll(async () => {
  ({ owner, other, co } = await setup());
  await ok(owner, 'POST', `/companies/${co}/items`, { code: 'S', name: 'ค่าบริการ', unit: 'งาน', isService: true });
  const iv = (date: string, party: string, qty: string, item = 'G') =>
    ok(owner, 'POST', `/companies/${co}/sales/invoice`, { date, partyCode: party, lines: [{ itemCode: item, qty, unitPrice: '1000' }] });
  id.iv1 = (await iv('2026-01-05', 'C1', '10')).id; // 10,700 ครบกำหนด 4 ก.พ.
  id.iv2 = (await iv('2026-01-20', 'C2', '5')).id;  // 5,350 ครบกำหนด 19 ก.พ.
  await ok(owner, 'POST', `/companies/${co}/sales/credit-note`, { date: '2026-01-25', refDocumentId: id.iv1, reason: 'ชำรุด',
    lines: [{ itemCode: 'G', qty: '1', unitPrice: '1000' }] });                // 1,070 → IV1 ค้าง 9,630
});

describe('ตั้งค่าเผื่อหนี้สงสัยจะสูญ 3 วิธี (AJ สิ้นเดือน)', () => {
  it('ร้อยละของยอดขายเชื่อ ม.ค. 1%: ขายเชื่อสุทธิ 15,000 − 1,000 = 14,000 → 140.00', async () => {
    const body = { month: '2026-01', method: 'sales', rate: '1' };
    const pv = await ok(owner, 'POST', `/companies/${co}/bad-debts/allowance/preview`, body);
    expect(pv).toMatchObject({ base: '14000.00', required: '140.00', previous: '0.00', amount: '140.00' });
    const a = await ok(owner, 'POST', `/companies/${co}/bad-debts/allowance`, body);
    expect(a.docNo).toMatch(/^AJ-\d{4}$/);
    const e = await entryOf('allowance_entries', a.id);
    expect(await lines(e)).toEqual({ 1211: ['0.00', '140.00'], 5270: ['140.00', '0.00'] });
    expect((await db.query('select entry_date::text d from acc.journal_entries where id = $1', [e])).rows[0].d).toBe('2026-01-31');
    await subledgerMatches('2026-01');
  });

  it('ร้อยละของลูกหนี้ ก.พ. 2%: ลูกหนี้ 14,980 → ต้องมี 299.60 มีแล้ว 140 → ตั้งเพิ่ม 159.60', async () => {
    const a = await ok(owner, 'POST', `/companies/${co}/bad-debts/allowance`, { month: '2026-02', method: 'receivables', rate: '2' });
    expect(a.amount).toBe('159.60');
    expect(await lines(await entryOf('allowance_entries', a.id))).toEqual({ 1211: ['0.00', '159.60'], 5270: ['159.60', '0.00'] });
  });

  it('ตามอายุลูกหนี้ มี.ค.: ยังไม่ครบ 3,210 × 1% + ค้าง 31–60 วัน 14,980 × 5% = 781.10 → ตั้งเพิ่ม 481.50', async () => {
    id.iv3 = (await ok(owner, 'POST', `/companies/${co}/sales/invoice`, { date: '2026-03-20', partyCode: 'C1', lines: [{ itemCode: 'G', qty: '3', unitPrice: '1000' }] })).id;
    const body = { month: '2026-03', method: 'aging', rates: { current: '1', d30: '2', d60: '5', d90: '10', over90: '50' } };
    const pv = await ok(owner, 'POST', `/companies/${co}/bad-debts/allowance/preview`, body);
    expect(pv.buckets.map((b: { bucket: string; open: string; count: number; required: string }) => [b.bucket, b.open, b.count, b.required])).toEqual([
      ['current', '3210.00', 1, '32.10'], ['d30', '0.00', 0, '0.00'], ['d60', '14980.00', 2, '749.00'], ['d90', '0.00', 0, '0.00'], ['over90', '0.00', 0, '0.00']]);
    expect(pv).toMatchObject({ base: '18190.00', required: '781.10', previous: '299.60', amount: '481.50' });
    const a = await ok(owner, 'POST', `/companies/${co}/bad-debts/allowance`, body);
    expect(a.amount).toBe('481.50');
    const s = await subledgerMatches('2026-03');
    expect([s.allowance, s.receivables]).toEqual(['781.10', '18190.00']);
  });

  it('ยอดเท่าที่ต้องมีแล้ว = ไม่มีรายการ · อัตราผิด = 400', async () => {
    const r = await as(owner, 'POST', `/companies/${co}/bad-debts/allowance`, { month: '2026-03', method: 'aging', rates: { current: '1', d30: '2', d60: '5', d90: '10', over90: '50' } });
    expect(r.statusCode).toBe(409);
    expect((await as(owner, 'POST', `/companies/${co}/bad-debts/allowance`, { month: '2026-03', method: 'receivables' })).statusCode).toBe(400);
    expect((await as(owner, 'POST', `/companies/${co}/bad-debts/allowance/preview`, { month: '2026-03', method: 'receivables', rate: '150' })).statusCode).toBe(400);
  });
});

describe('ตัดหนี้สูญรายใบ และหนี้สูญได้รับคืน (JV)', () => {
  it('ตัด IV2 ทั้งใบ 5,350: Dr 1211 / Cr 1210 · ยอดค้างของใบเป็นศูนย์ · ลูกหนี้คงค้างไม่มี IV2', async () => {
    const w = await ok(owner, 'POST', `/companies/${co}/bad-debts/writeoffs`, { documentId: id.iv2, date: '2026-04-10', amount: '5350', reason: 'ลูกหนี้ปิดกิจการ' });
    id.w2 = w.id;
    expect(w.docNo).toMatch(/^JV-\d{4}$/);
    expect(await lines(w.entryId)).toEqual({ 1210: ['0.00', '5350.00'], 1211: ['5350.00', '0.00'] });
    const s = await subledgerMatches('2026-04');
    expect([s.receivables, s.allowance]).toEqual(['12840.00', '-4568.90']);
    expect(s.open.map((o: { id: string }) => o.id)).not.toContain(id.iv2);
    const rec = await ok(owner, 'GET', `/companies/${co}/receivables?asOf=2026-04-30`);
    expect(rec.totals.all).toBe('12840.00');
  });

  it('ตัดเกินยอดค้าง = 422 · คีย์ซ้ำได้ผลเดิม', async () => {
    expect((await as(owner, 'POST', `/companies/${co}/bad-debts/writeoffs`, { documentId: id.iv2, date: '2026-04-11', amount: '1', reason: 'ซ้ำ' })).statusCode).toBe(422);
    const key = randomUUID();
    const a = await ok(owner, 'POST', `/companies/${co}/bad-debts/writeoffs`, { documentId: id.iv3, date: '2026-04-12', amount: '10', reason: 'ทดสอบคีย์' }, key);
    const b = await ok(owner, 'POST', `/companies/${co}/bad-debts/writeoffs`, { documentId: id.iv3, date: '2026-04-12', amount: '10', reason: 'ทดสอบคีย์' }, key);
    expect(b.id).toBe(a.id);
    const v = await ok(owner, 'POST', `/companies/${co}/bad-debts/writeoff/${a.id}/void`, { date: '2026-04-12', reason: 'ทดสอบ' });
    expect(v.voidDocNo).toMatch(/^RV-\d{4}$/);
    await subledgerMatches('2026-04');
  });

  it('ได้รับคืน 2,000: Dr 1210 / Cr 1211 → ยอดค้าง IV2 กลับมา 2,000 → รับชำระด้วยใบเสร็จตามปกติ', async () => {
    const r = await ok(owner, 'POST', `/companies/${co}/bad-debts/recoveries`, { writeoffId: id.w2, date: '2026-05-05', amount: '2000' });
    id.r1 = r.id;
    expect(await lines(r.entryId)).toEqual({ 1210: ['2000.00', '0.00'], 1211: ['0.00', '2000.00'] });
    let s = await subledgerMatches('2026-05');
    expect(s.open.find((o: { id: string }) => o.id === id.iv2)?.open).toBe('2000.00');
    expect((await as(owner, 'POST', `/companies/${co}/bad-debts/writeoff/${id.w2}/void`, { date: '2026-05-05', reason: 'ผิด' })).statusCode).toBe(409);
    expect((await as(owner, 'POST', `/companies/${co}/bad-debts/recoveries`, { writeoffId: id.w2, date: '2026-05-05', amount: '3350.01' })).statusCode).toBe(422);
    await ok(owner, 'POST', `/companies/${co}/receipts`, { date: '2026-05-06', partyCode: 'C2', cashAccount: '1110', allocations: [{ documentId: id.iv2, amount: '2000' }] });
    s = await subledgerMatches('2026-05');
    expect(s.open.map((o: { id: string }) => o.id)).not.toContain(id.iv2);
    // รับชำระแล้ว ยกเลิกการรับคืนไม่ได้ (ยอดค้างจะติดลบ)
    expect((await as(owner, 'POST', `/companies/${co}/bad-debts/recovery/${id.r1}/void`, { date: '2026-05-07', reason: 'ผิด' })).statusCode).toBe(409);
  });

  it('รับคืนแบบเครดิต 4340 หนี้สูญได้รับคืน', async () => {
    const r = await ok(owner, 'POST', `/companies/${co}/bad-debts/recoveries`, { writeoffId: id.w2, date: '2026-05-20', amount: '350', credit: '4340' });
    expect(await lines(r.entryId)).toEqual({ 1210: ['350.00', '0.00'], 4340: ['0.00', '350.00'] });
    await subledgerMatches('2026-05');
  });

  it('ลดค่าเผื่อ (ร้อยละของลูกหนี้ มิ.ย. 0.5%): Dr 1211 / Cr 5270', async () => {
    // 1210 = 12,840 + 350 = 13,190 → ต้องมี 65.95 · 1211 = 781.10 − 5,350 + 2,000 = −2,568.90 → ตั้งเพิ่ม 2,634.85 (เกินที่ตัดไป)
    const a = await ok(owner, 'POST', `/companies/${co}/bad-debts/allowance`, { month: '2026-06', method: 'receivables', rate: '0.5' });
    expect(a.amount).toBe('2634.85');
    const b = await ok(owner, 'POST', `/companies/${co}/bad-debts/allowance`, { month: '2026-07', method: 'receivables', rate: '0.2' });
    expect(b.amount).toBe('-39.57'); // ต้องมี 26.38 มีอยู่ 65.95
    expect(await lines(await entryOf('allowance_entries', b.id))).toEqual({ 1211: ['39.57', '0.00'], 5270: ['0.00', '39.57'] });
  });

  it('บริการ: ตัดครึ่งใบ 535 ล้างภาษียังไม่ถึงกำหนด 35 (Dr 1211 500 Dr 2211 35 / Cr 1210 535)', async () => {
    const iv = await ok(owner, 'POST', `/companies/${co}/sales/invoice`, { date: '2026-08-01', partyCode: 'C1', lines: [{ itemCode: 'S', qty: '1', unitPrice: '1000' }] });
    const w = await ok(owner, 'POST', `/companies/${co}/bad-debts/writeoffs`, { documentId: iv.id, date: '2026-08-15', amount: '535', reason: 'เจรจาลดหนี้ไม่ได้' });
    expect(await lines(w.entryId)).toEqual({ 1210: ['0.00', '535.00'], 1211: ['500.00', '0.00'], 2211: ['35.00', '0.00'] });
    // รับชำระส่วนที่เหลือ: ภาษียังไม่ถึงกำหนดที่เหลือ 35 ถึงกำหนดพอดี 2211 ของใบนี้เป็นศูนย์
    const re = await ok(owner, 'POST', `/companies/${co}/receipts`, { date: '2026-08-20', partyCode: 'C1', cashAccount: '1110', allocations: [{ documentId: iv.id, amount: '535' }] });
    const reEntry = (await db.query('select entry_id from acc.documents where id = $1', [re.id])).rows[0].entry_id;
    expect((await lines(reEntry))['2211']).toEqual(['35.00', '0.00']);
    await subledgerMatches('2026-08');
  });

  it('ทะเบียนย่อย = บัญชีคุมทุกเดือน · นักเรียนอื่นอ่าน/ตัดหนี้ไม่ได้', async () => {
    for (const m of ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08']) await subledgerMatches(m);
    expect([403, 404]).toContain((await as(other, 'GET', `/companies/${co}/bad-debts`)).statusCode);
    expect([403, 404]).toContain((await as(other, 'POST', `/companies/${co}/bad-debts/writeoffs`,
      { documentId: id.iv1, date: '2026-09-01', amount: '1', reason: 'x' })).statusCode);
    const direct = await db.query(`select count(*)::int n from acc.bad_debt_writeoffs where company_id = $1`, [co]);
    expect(direct.rows[0].n).toBeGreaterThan(0);
  });
});
