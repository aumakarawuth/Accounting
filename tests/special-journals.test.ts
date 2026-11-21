import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { curriculumApp, cents, fromCents } from './curriculum-helpers';
import { pool as db } from './helpers';
import { specialJournalReport } from '../apps/web/lib/export/reports';
import { toPdf } from '../apps/web/lib/export/pdf';
import { toXlsx } from '../apps/web/lib/export/xlsx';
import type { SpecialJournal } from '../apps/web/lib/api';

// เฟส 6 โมดูล 1: สมุดรายวันเฉพาะ (docs/phase6-spec.md ข้อ 1) เทียบเฉลยคิดมือรายแถว
// + ทุกรายการอยู่เล่มเดียว + ผลรวมทุกเล่มต่อบัญชี = แยกประเภทเดือนเดียวกัน
const { ok, as, close, setup } = curriculumApp();
afterAll(close);

const M = '2026-10';
let owner: string, other: string, co: string;
const doc: Record<string, string> = {};

type Row = { docNo: string; party: string | null; reversal: boolean; cells: Record<string, string>; others: { code: string; debit: string; credit: string }[] };
type Book = {
  columns: { key: string; code: string; side: string; total: string }[]; rows: Row[];
  posting: { code: string; debit: string; credit: string; via: string }[]; totalDebit: string; totalCredit: string; balanced: boolean;
  counts: Record<string, number>;
};
const book = (b: string, month = M): Promise<Book> => ok(owner, 'GET', `/companies/${co}/books?month=${month}&book=${b}`);
const docNo = async (id: string) => (await db.query(
  `select j.doc_no from acc.documents d join acc.journal_entries j on j.company_id = d.company_id and j.id = d.entry_id where d.id = $1
   union all select j.doc_no from acc.purchase_documents d join acc.journal_entries j on j.company_id = d.company_id and j.id = d.entry_id where d.id = $1`, [id])).rows[0].doc_no as string;
const brief = (r: Row) => ({ docNo: r.docNo, cells: r.cells, others: r.others.map((o) => [o.code, o.debit, o.credit]) });

beforeAll(async () => {
  ({ owner, other, co } = await setup());
  const j = (date: string, description: string, lines: object[], path = 'journal') => ok(owner, 'POST', `/companies/${co}/${path}`, { date, description, lines });
  doc.invest = (await j(`${M}-01`, 'ลงทุน', [{ account_code: '1110', debit: '100000' }, { account_code: '3110', credit: '100000' }])).docNo;
  doc.deposit = (await j(`${M}-01`, 'นำเงินฝากธนาคาร', [{ account_code: '1120', debit: '50000' }, { account_code: '1110', credit: '50000' }])).docNo;
  const iv = await ok(owner, 'POST', `/companies/${co}/sales/invoice`, { date: `${M}-03`, partyCode: 'C1', lines: [{ itemCode: 'G', qty: '10', unitPrice: '100' }] });
  doc.iv = await docNo(iv.id);
  const re = await ok(owner, 'POST', `/companies/${co}/receipts`, { date: `${M}-10`, partyCode: 'C1', cashAccount: '1120', allocations: [{ documentId: iv.id, amount: '700' }] });
  doc.re = await docNo(re.id);
  const cs = await ok(owner, 'POST', `/companies/${co}/sales/cash-sale`, { date: `${M}-11`, partyCode: 'C2', cashAccount: '1110', lines: [{ itemCode: 'G', qty: '5', unitPrice: '100' }] });
  doc.cs = await docNo(cs.id);
  const pi = await ok(owner, 'POST', `/companies/${co}/purchases/invoice`, { date: `${M}-12`, partyCode: 'V1', vendorDocNo: 'V-77', lines: [{ itemCode: 'G', qty: '20', unitPrice: '100' }] });
  doc.pi = await docNo(pi.id);
  const pv = await ok(owner, 'POST', `/companies/${co}/payments`, { date: `${M}-20`, partyCode: 'V1', cashAccount: '1120', allocations: [{ documentId: pi.id, amount: '2140' }] });
  doc.pv = await docNo(pv.id);
  const cp = await ok(owner, 'POST', `/companies/${co}/purchases/cash-purchase`, { date: `${M}-21`, partyCode: 'V1', vendorDocNo: 'RC-1', cashAccount: '1110', lines: [{ itemCode: 'G', qty: '3', unitPrice: '100' }] });
  doc.cp = await docNo(cp.id);
  doc.rent = (await j(`${M}-25`, 'จ่ายค่าเช่า', [{ account_code: '5220', debit: '5000' }, { account_code: '1110', credit: '5000' }])).docNo;
  const cn = await ok(owner, 'POST', `/companies/${co}/sales/credit-note`, { date: `${M}-26`, refDocumentId: iv.id, reason: 'ชำรุด', lines: [{ itemCode: 'G', qty: '1', unitPrice: '100' }] });
  doc.cn = await docNo(cn.id);
  // ขายเชื่อใบที่สองแล้วยกเลิก: RV อยู่สมุดขาย ยอดติดลบ
  const iv2 = await ok(owner, 'POST', `/companies/${co}/sales/invoice`, { date: `${M}-27`, partyCode: 'C2', lines: [{ itemCode: 'G', qty: '2', unitPrice: '100' }] });
  doc.iv2 = await docNo(iv2.id);
  doc.iv2void = (await ok(owner, 'POST', `/companies/${co}/sales/documents/${iv2.id}/void`, { date: `${M}-28`, reason: 'ออกผิด' })).voidDocNo;
  doc.aj = (await j(`${M}-31`, 'ค่าไฟค้างจ่าย', [{ account_code: '5230', debit: '800' }, { account_code: '2310', credit: '800' }])).docNo;
  // รายการของเดือนถัดไปไม่ปน
  await j('2026-11-02', 'ลงทุนเพิ่ม', [{ account_code: '1110', debit: '1' }, { account_code: '3110', credit: '1' }]);
});

describe('สมุดรายวันเฉพาะ: ตรงเฉลยรายแถว', () => {
  it('สมุดรายวันขาย: ขายเชื่อ + ยกเลิก (ยอดติดลบ) คอลัมน์ ลูกหนี้ ขาย ภาษีขาย', async () => {
    const b = await book('sales');
    expect(b.columns.map((c) => [c.key, c.total])).toEqual([['dr1210', '1070.00'], ['cr4110', '1000.00'], ['cr2210', '70.00']]);
    expect(b.rows.map(brief)).toEqual([
      { docNo: doc.iv, cells: { dr1210: '1070.00', cr4110: '1000.00', cr2210: '70.00' }, others: [] },
      { docNo: doc.iv2, cells: { dr1210: '214.00', cr4110: '200.00', cr2210: '14.00' }, others: [] },
      { docNo: doc.iv2void, cells: { dr1210: '-214.00', cr4110: '-200.00', cr2210: '-14.00' }, others: [] },
    ]);
    expect(b.rows.map((r) => [r.party, r.reversal])).toEqual([['ร้าน ลูกค้าหนึ่ง', false], ['ร้าน ลูกค้าสอง', false], ['ร้าน ลูกค้าสอง', true]]);
    expect(b.posting).toEqual([
      { code: '1210', name: 'ลูกหนี้การค้า', debit: '1070.00', credit: '0.00', via: 'column' },
      { code: '2210', name: 'ภาษีขาย', debit: '0.00', credit: '70.00', via: 'column' },
      { code: '4110', name: 'รายได้จากการขาย', debit: '0.00', credit: '1000.00', via: 'column' },
    ]);
    expect([b.totalDebit, b.totalCredit, b.balanced]).toEqual(['1070.00', '1070.00', true]);
  });

  it('สมุดรายวันซื้อ: ซื้อเชื่อ ซื้อ ภาษีซื้อ เจ้าหนี้', async () => {
    const b = await book('purchases');
    expect(b.columns.map((c) => [c.key, c.total])).toEqual([['dr5110', '2000.00'], ['dr1410', '140.00'], ['cr2110', '2140.00']]);
    expect(b.rows.map(brief)).toEqual([{ docNo: doc.pi, cells: { dr5110: '2000.00', dr1410: '140.00', cr2110: '2140.00' }, others: [] }]);
    expect(b.rows[0]).toMatchObject({ party: 'ร้าน ขายส่ง', vendorDocNo: 'V-77' });
  });

  it('สมุดรายวันรับเงิน: ลงทุน รับชำระ ขายสด · บัญชีอื่น ๆ ทุน', async () => {
    const b = await book('receipts');
    expect(b.columns.map((c) => [c.key, c.total])).toEqual([
      ['dr1110', '100535.00'], ['dr1120', '700.00'], ['cr1210', '700.00'], ['cr4110', '500.00'], ['cr2210', '35.00']]);
    expect(b.rows.map(brief)).toEqual([
      { docNo: doc.invest, cells: { dr1110: '100000.00' }, others: [['3110', '0.00', '100000.00']] },
      { docNo: doc.re, cells: { dr1120: '700.00', cr1210: '700.00' }, others: [] },
      { docNo: doc.cs, cells: { dr1110: '535.00', cr4110: '500.00', cr2210: '35.00' }, others: [] },
    ]);
    expect(b.posting.find((p) => p.code === '3110')).toMatchObject({ credit: '100000.00', via: 'others' });
    expect(b.balanced).toBe(true);
  });

  it('สมุดรายวันจ่ายเงิน: ฝากเงิน (ยอดเงินสุทธิศูนย์) จ่ายชำระ ซื้อสด ค่าเช่า', async () => {
    const b = await book('payments');
    expect(b.columns.map((c) => [c.key, c.total])).toEqual([
      ['dr2110', '2140.00'], ['dr5110', '300.00'], ['dr1410', '21.00'], ['cr1110', '55321.00'], ['cr1120', '2140.00']]);
    expect(b.rows.map(brief)).toEqual([
      { docNo: doc.deposit, cells: { cr1110: '50000.00' }, others: [['1120', '50000.00', '0.00']] },
      { docNo: doc.pv, cells: { dr2110: '2140.00', cr1120: '2140.00' }, others: [] },
      { docNo: doc.cp, cells: { dr5110: '300.00', dr1410: '21.00', cr1110: '321.00' }, others: [] },
      { docNo: doc.rent, cells: { cr1110: '5000.00' }, others: [['5220', '5000.00', '0.00']] },
    ]);
    // 1120: เดบิตรายตัว 50,000 + เครดิตคอลัมน์ 2,140 → ผ่านสุทธิเดบิต 47,860
    expect(b.posting.find((p) => p.code === '1120')).toMatchObject({ debit: '47860.00', credit: '0.00', via: 'both' });
    expect(b.balanced).toBe(true);
  });

  it('สมุดรายวันทั่วไป: ลดหนี้ และรายการปรับปรุง (ทุกบรรทัดสองช่อง)', async () => {
    const b = await book('general');
    expect(b.columns).toEqual([]);
    const sorted = b.rows.map(brief).map((r) => ({ ...r, others: [...r.others].sort() }));
    expect(sorted).toEqual([
      { docNo: doc.cn, cells: {}, others: [['1210', '0.00', '107.00'], ['2210', '7.00', '0.00'], ['4220', '100.00', '0.00']] },
      { docNo: doc.aj, cells: {}, others: [['2310', '0.00', '800.00'], ['5230', '800.00', '0.00']] },
    ]);
  });
});

describe('สมุดรายวันเฉพาะ: ไม่ลงซ้ำ และผ่านบัญชีตรงแยกประเภท', () => {
  it('ทุกรายการของเดือนอยู่เล่มเดียว จำนวนรวม = สมุดรายวัน', async () => {
    const b = await book('sales');
    const n = (await db.query(`select count(*)::int n from acc.journal_entries where company_id = $1 and entry_date between '2026-10-01' and '2026-10-31'`, [co])).rows[0].n;
    expect(b.counts).toEqual({ sales: 3, purchases: 1, receipts: 3, payments: 4, general: 2 });
    expect(Object.values(b.counts).reduce((a, x) => a + x, 0)).toBe(n);
    const seen = new Set<string>();
    for (const k of ['sales', 'purchases', 'receipts', 'payments', 'general']) for (const r of (await book(k)).rows) {
      expect(seen.has(r.docNo)).toBe(false);
      seen.add(r.docNo);
    }
    expect(seen.size).toBe(n);
  });

  it('ผลรวมยอดผ่านทุกเล่มต่อบัญชี = ยอดเคลื่อนไหวสุทธิในแยกประเภท ทุกบัญชี', async () => {
    const net = new Map<string, bigint>();
    for (const k of ['sales', 'purchases', 'receipts', 'payments', 'general']) {
      const b = await book(k);
      expect(b.totalDebit).toBe(b.totalCredit);
      for (const p of b.posting) net.set(p.code, (net.get(p.code) ?? 0n) + cents(p.debit) - cents(p.credit));
    }
    const ledger: { code: string; debit: string; credit: string }[] = await ok(owner, 'GET', `/companies/${co}/ledger-accounts?month=${M}`);
    const fromLedger = new Map(ledger.map((l) => [l.code, cents(l.debit) - cents(l.credit)]));
    for (const code of new Set([...net.keys(), ...fromLedger.keys()])) {
      expect([code, fromCents(net.get(code) ?? 0n)]).toEqual([code, fromCents(fromLedger.get(code) ?? 0n)]);
    }
  });

  it('สุ่มรายการสมุดรายวัน 120 รายการ: ทุกเล่มดุล และรวมทุกเล่ม = แยกประเภท', async () => {
    const codes = ['1110', '1120', '1210', '2110', '3110', '4110', '5220', '5230', '2210', '1410', '2310'];
    let seed = 7;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    const ids: string[] = [];
    for (let i = 0; i < 120; i++) {
      const a = codes[rnd(codes.length)]!; let b2 = codes[rnd(codes.length)]!;
      if (b2 === a) b2 = a === '1110' ? '4110' : '1110';
      const amt = `${1 + rnd(5000)}.${String(rnd(100)).padStart(2, '0')}`;
      const e = await ok(owner, 'POST', `/companies/${co}/journal`, { date: `2026-12-${String(1 + rnd(28)).padStart(2, '0')}`, description: `สุ่ม ${i}`,
        lines: [{ account_code: a, debit: amt }, { account_code: b2, credit: amt }] });
      ids.push(e.id);
    }
    for (const id of ids.slice(0, 15)) await ok(owner, 'POST', `/companies/${co}/journal/${id}/reverse`, { date: '2026-12-29' });
    const net = new Map<string, bigint>();
    let rows = 0;
    for (const k of ['sales', 'purchases', 'receipts', 'payments', 'general']) {
      const b = await book(k, '2026-12');
      expect(b.balanced).toBe(true);
      rows += b.rows.length;
      for (const p of b.posting) net.set(p.code, (net.get(p.code) ?? 0n) + cents(p.debit) - cents(p.credit));
    }
    expect(rows).toBe(135);
    const ledger: { code: string; debit: string; credit: string }[] = await ok(owner, 'GET', `/companies/${co}/ledger-accounts?month=2026-12`);
    for (const l of ledger) expect([l.code, fromCents(net.get(l.code) ?? 0n)]).toEqual([l.code, fromCents(cents(l.debit) - cents(l.credit))]);
  });

  it('นักเรียนอื่นอ่านสมุดของบริษัทนี้ไม่ได้ · เล่ม/เดือนผิดรูปแบบ = 400', async () => {
    const r = await as(other, 'GET', `/companies/${co}/books?month=${M}&book=sales`);
    expect([403, 404]).toContain(r.statusCode);
    expect((await as(owner, 'GET', `/companies/${co}/books?month=${M}&book=cash`)).statusCode).toBe(400);
    expect((await as(owner, 'GET', `/companies/${co}/books?month=2026-13`)).statusCode).toBe(400);
  });
});

describe('สมุดรายวันเฉพาะ: ส่งออก PDF/Excel', () => {
  it('ทุกเล่ม: ทุกแถวมีจำนวนช่องเท่าหัวตาราง · ยอดรวมตรงหน้าจอ · สร้าง PDF/Excel ได้', async () => {
    for (const k of ['sales', 'purchases', 'receipts', 'payments', 'general']) {
      const j = (await book(k)) as unknown as SpecialJournal;
      const rep = specialJournalReport('บริษัท ก. จำกัด', j);
      for (const sec of rep.sections) for (const r of sec.rows) expect(r.cells.length).toBe(sec.columns.length);
      const totalRow = rep.sections[0]!.rows.at(-1)!;
      if (k !== 'general') expect(totalRow.cells.slice(3, 3 + j.columns.length)).toEqual(j.columns.map((c) => c.total));
      expect(rep.sections.at(-1)!.rows.at(-1)!.cells.slice(-2)).toEqual([j.totalDebit, j.totalCredit]);
      expect((await toPdf(rep)).length).toBeGreaterThan(1000);
      expect((await toXlsx(rep)).length).toBeGreaterThan(1000);
    }
  });
});
