import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { curriculumApp, cents, fromCents } from './curriculum-helpers';
import { cashFlowReport } from '../apps/web/lib/export/reports';
import { toPdf } from '../apps/web/lib/export/pdf';
import { toXlsx } from '../apps/web/lib/export/xlsx';
import type { CashFlow } from '../apps/web/lib/api';

// เฟส 6 โมดูล 2: งบกระแสเงินสด (docs/phase6-spec.md ข้อ 2) เทียบเฉลยคิดมือ
// ทางอ้อม = ทางตรง · เงินสดปลายงวด = ยอดบัญชี 11xx · กำไรสุทธิ = งบกำไรขาดทุน
const { ok, as, close, setup } = curriculumApp();
afterAll(close);

let owner: string, other: string, co: string;
const M = '2027-01';
type CF = {
  operating: { netIncome: string; adjustments: { code: string; amount: string }[]; workingCapital: { code: string; amount: string; kind: string }[];
    direct: { key: string; amount: string }[]; total: string };
  investing: { lines: { code: string; amount: string; kind: string }[]; total: string };
  financing: { lines: { code: string; amount: string; kind: string }[]; total: string };
  netChange: string; openingCash: string; closingCash: string; ledgerCash: string; matches: boolean;
  cashAccounts: { code: string; opening: string; closing: string }[];
  nonCash: { docNo: string; amount: string }[];
};
const cf = (month = M, scope = 'month', co_ = co): Promise<CF> => ok(owner, 'GET', `/companies/${co_}/cash-flow?month=${month}&scope=${scope}`);
const jv = (date: string, description: string, lines: [string, string, string][], company = co) =>
  ok(owner, 'POST', `/companies/${company}/journal`, { date, description,
    lines: lines.map(([code, dr, cr]) => ({ account_code: code, ...(dr ? { debit: dr } : { credit: cr }) })) });

beforeAll(async () => {
  ({ owner, other, co } = await setup({ vat: false }));
  await jv(`${M}-02`, 'ลงทุน', [['1110', '200000', ''], ['3110', '', '200000']]);
  await jv(`${M}-02`, 'ฝากธนาคาร', [['1120', '100000', ''], ['1110', '', '100000']]);
  await jv(`${M}-03`, 'ซื้ออุปกรณ์เงินสด', [['1630', '36000', ''], ['1120', '', '36000']]);
  await jv(`${M}-04`, 'ซื้ออุปกรณ์เงินเชื่อ', [['1630', '12000', ''], ['2110', '', '12000']]);
  await jv(`${M}-05`, 'ขายเชื่อ', [['1210', '50000', ''], ['4110', '', '50000']]);
  await jv(`${M}-10`, 'รับชำระหนี้', [['1110', '30000', ''], ['1210', '', '30000']]);
  await jv(`${M}-11`, 'ขายสด', [['1110', '20000', ''], ['4110', '', '20000']]);
  await jv(`${M}-12`, 'ซื้อเชื่อ', [['5110', '25000', ''], ['2110', '', '25000']]);
  await jv(`${M}-15`, 'จ่ายชำระหนี้', [['2110', '15000', ''], ['1120', '', '15000']]);
  await jv(`${M}-16`, 'จ่ายค่าเช่า', [['5220', '8000', ''], ['1110', '', '8000']]);
  await jv(`${M}-20`, 'ขายอุปกรณ์ขาดทุน', [['1110', '9000', ''], ['1631', '1000', ''], ['5260', '2000', ''], ['1630', '', '12000']]);
  await jv(`${M}-21`, 'กู้ยืมระยะยาว', [['1110', '50000', ''], ['2610', '', '50000']]);
  await jv(`${M}-25`, 'ชำระเงินกู้', [['2610', '10000', ''], ['1120', '', '10000']]);
  await jv(`${M}-25`, 'ดอกเบี้ยจ่าย', [['5310', '500', ''], ['1120', '', '500']]);
  await jv(`${M}-28`, 'ถอนใช้ส่วนตัว', [['3310', '3000', ''], ['1110', '', '3000']]);
  await ok(owner, 'POST', `/companies/${co}/journal`, { date: `${M}-31`, description: 'ค่าเสื่อมราคา', adjusting: true,
    lines: [{ account_code: '5250', debit: '1000' }, { account_code: '1631', credit: '1000' }] });
  await jv(`${M}-31`, 'ค่าไฟค้างจ่าย', [['5230', '700', ''], ['2310', '', '700']]);
});

describe('งบกระแสเงินสด: ตรงเฉลยคิดมือ', () => {
  it('กิจกรรมดำเนินงาน วิธีทางอ้อม: กำไรสุทธิ + ค่าเสื่อม + ขาดทุนจากขาย + เงินทุนหมุนเวียน', async () => {
    const r = await cf();
    // รายได้ 70,000 − ค่าใช้จ่าย (25,000 + 8,000 + 1,000 + 2,000 + 500 + 700) = 32,800
    expect(r.operating.netIncome).toBe('32800.00');
    expect(r.operating.adjustments).toEqual([
      { code: '5250', name: 'ค่าเสื่อมราคา', amount: '1000.00' },
      { code: '5260', name: 'ค่าใช้จ่ายเบ็ดเตล็ด', amount: '2000.00' },
    ]);
    // 1210: −50,000 + 30,000 · 2110: +25,000 − 15,000 (ไม่นับซื้ออุปกรณ์เงินเชื่อ) · 2310: +700
    expect(r.operating.workingCapital.map((w) => [w.code, w.amount, w.kind])).toEqual([
      ['1210', '-20000.00', 'asset'], ['2110', '10000.00', 'liability'], ['2310', '700.00', 'liability']]);
    expect(r.operating.total).toBe('26500.00');
  });

  it('กิจกรรมดำเนินงาน วิธีทางตรง = ทางอ้อม', async () => {
    const r = await cf();
    expect(r.operating.direct).toEqual([
      { key: 'customers', amount: '50000.00' }, { key: 'suppliers', amount: '-15000.00' },
      { key: 'expenses', amount: '-8000.00' }, { key: 'interest', amount: '-500.00' }]);
    expect(r.operating.direct.reduce((a, d) => a + cents(d.amount), 0n)).toBe(cents(r.operating.total));
  });

  it('ลงทุน: ซื้ออุปกรณ์ (36,000) ขายอุปกรณ์ 9,000 · จัดหาเงิน: ทุน กู้ ชำระคืน ถอนใช้', async () => {
    const r = await cf();
    expect(r.investing.lines.map((l) => [l.code, l.kind, l.amount])).toEqual([['1630', 'in', '9000.00'], ['1630', 'out', '-36000.00']]);
    expect(r.investing.total).toBe('-27000.00');
    expect(r.financing.lines.map((l) => [l.code, l.kind, l.amount])).toEqual([
      ['2610', 'in', '50000.00'], ['2610', 'out', '-10000.00'], ['3110', 'in', '200000.00'], ['3310', 'out', '-3000.00']]);
    expect(r.financing.total).toBe('237000.00');
    expect(r.nonCash.map((n) => n.amount)).toEqual(['12000.00']);
  });

  it('เงินสดปลายงวด = ต้นงวด + เพิ่มสุทธิ = ยอดบัญชี 11xx ในงบทดลอง', async () => {
    const r = await cf();
    expect([r.openingCash, r.netChange, r.closingCash, r.ledgerCash, r.matches]).toEqual(['0.00', '236500.00', '236500.00', '236500.00', true]);
    expect(r.cashAccounts).toEqual([
      { code: '1110', name: 'เงินสด', opening: '0.00', closing: '198000.00' },
      { code: '1120', name: 'เงินฝากธนาคาร - กระแสรายวัน', opening: '0.00', closing: '38500.00' }]);
    const tb = await ok(owner, 'GET', `/companies/${co}/trial-balance?month=${M}`);
    const cash = (tb.rows as { code: string; debit: string; credit: string }[]).filter((x) => x.code.startsWith('11'))
      .reduce((a, x) => a + cents(x.debit) - cents(x.credit), 0n);
    expect(fromCents(cash)).toBe(r.closingCash);
    const st = await ok(owner, 'GET', `/companies/${co}/statements?month=${M}&scope=month`);
    expect(st.netIncome).toBe(r.operating.netIncome);
  });

  it('เดือนถัดไป: ต้นงวด = ปลายงวดเดือนก่อน · ตั้งแต่ต้นปีรวมสองเดือน', async () => {
    await jv('2027-02-03', 'รับชำระหนี้', [['1110', '20000', ''], ['1210', '', '20000']]);
    await jv('2027-02-04', 'ค่าไฟค้างจ่ายจ่ายแล้ว', [['2310', '700', ''], ['1110', '', '700']]);
    const feb = await cf('2027-02');
    expect([feb.openingCash, feb.netChange, feb.closingCash, feb.matches]).toEqual(['236500.00', '19300.00', '255800.00', true]);
    expect(feb.operating.workingCapital.map((w) => [w.code, w.amount])).toEqual([['1210', '20000.00'], ['2310', '-700.00']]);
    const ytd = await cf('2027-02', 'ytd');
    expect([ytd.openingCash, ytd.netChange, ytd.closingCash, ytd.matches]).toEqual(['0.00', '255800.00', '255800.00', true]);
    expect(ytd.operating.total).toBe('45800.00');
  });
});

describe('งบกระแสเงินสด: สมการตรงทุกกรณี', () => {
  it('สุ่ม 200 รายการทุกหมวดบัญชี: ทางตรง = ทางอ้อม · ปลายงวด = 11xx · กำไรสุทธิ = งบกำไรขาดทุน', async () => {
    const s = await setup({ vat: false });
    const codes = ['1110', '1120', '1140', '1210', '1310', '1410', '1510', '1630', '1631', '2110', '2310', '2410', '2510', '2610', '3110', '3210', '3310',
      '4110', '4310', '5110', '5220', '5250', '5310'];
    let seed = 11;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    for (let i = 0; i < 200; i++) {
      const n = 2 + rnd(3);
      const picks = Array.from({ length: n }, () => codes[rnd(codes.length)]!);
      const amts = picks.slice(1).map(() => BigInt(1 + rnd(900000)));
      const total = amts.reduce((a, x) => a + x, 0n);
      const lines = [{ account_code: picks[0]!, debit: fromCents(total) },
        ...picks.slice(1).map((c, k) => ({ account_code: c, credit: fromCents(amts[k]!) }))];
      if (rnd(2)) for (const l of lines) { const x = l as { debit?: string; credit?: string }; [x.debit, x.credit] = [x.credit, x.debit]; }
      await ok(s.owner, 'POST', `/companies/${s.co}/journal`, { date: `2027-0${1 + rnd(3)}-${String(1 + rnd(28)).padStart(2, '0')}`, description: `สุ่ม ${i}`,
        lines: lines.map((l) => Object.fromEntries(Object.entries(l).filter(([, v]) => v !== undefined))) });
    }
    let prevClosing = '0.00';
    for (const m of ['2027-01', '2027-02', '2027-03']) {
      const r: CF = await ok(s.owner, 'GET', `/companies/${s.co}/cash-flow?month=${m}&scope=month`);
      expect(r.matches).toBe(true);
      expect(r.openingCash).toBe(prevClosing);
      expect(r.operating.direct.reduce((a, d) => a + cents(d.amount), 0n)).toBe(cents(r.operating.total));
      expect(cents(r.operating.total) + cents(r.investing.total) + cents(r.financing.total)).toBe(cents(r.netChange));
      const st = await ok(s.owner, 'GET', `/companies/${s.co}/statements?month=${m}&scope=month`);
      expect(r.operating.netIncome).toBe(st.netIncome);
      prevClosing = r.closingCash;
    }
    const ytd: CF = await ok(s.owner, 'GET', `/companies/${s.co}/cash-flow?month=2027-03&scope=ytd`);
    expect([ytd.openingCash, ytd.closingCash, ytd.matches]).toEqual(['0.00', prevClosing, true]);
  });

  it('นักเรียนอื่นอ่านไม่ได้ · ขอบเขตผิด = 400', async () => {
    expect([403, 404]).toContain((await as(other, 'GET', `/companies/${co}/cash-flow?month=${M}`)).statusCode);
    expect((await as(owner, 'GET', `/companies/${co}/cash-flow?month=${M}&scope=week`)).statusCode).toBe(400);
  });
});

describe('งบกระแสเงินสด: ส่งออก', () => {
  it('ทั้งสองวิธี: บรรทัดสุดท้ายเป็นเงินสดปลายงวด · PDF/Excel สร้างได้', async () => {
    const r = (await cf()) as unknown as CashFlow;
    for (const m of ['indirect', 'direct'] as const) {
      const rep = cashFlowReport('บริษัท ก. จำกัด', r, m);
      expect(rep.sections[0]!.rows.at(-1)!.cells).toEqual([null, 'เงินสดและรายการเทียบเท่าเงินสดปลายงวด', '236500.00']);
      for (const sec of rep.sections) for (const row of sec.rows) expect(row.cells.length).toBe(sec.columns.length);
      expect((await toPdf(rep)).length).toBeGreaterThan(1000);
      expect((await toXlsx(rep)).length).toBeGreaterThan(1000);
    }
  });
});
