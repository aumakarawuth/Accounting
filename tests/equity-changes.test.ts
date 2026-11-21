import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { curriculumApp } from './curriculum-helpers';
import { equityChangesReport } from '../apps/web/lib/export/reports';
import { toPdf } from '../apps/web/lib/export/pdf';
import { toXlsx } from '../apps/web/lib/export/xlsx';
import type { EquityChanges } from '../apps/web/lib/api';

// เฟส 6 โมดูล 3: งบแสดงการเปลี่ยนแปลงส่วนของเจ้าของ (docs/phase6-spec.md ข้อ 3) เทียบเฉลยคิดมือ
// รวมปลายงวด = รวมส่วนของเจ้าของในงบแสดงฐานะการเงินทุกกรณี
const { ok, as, close, setup } = curriculumApp();
afterAll(close);

let owner: string, other: string, co: string;
type Eq = { columns: { key: string }[]; rows: { key: string; values: Record<string, string>; total: string }[]; netIncome: string; positionEquity: string; matches: boolean };
const eq = (month: string, scope = 'month'): Promise<Eq> => ok(owner, 'GET', `/companies/${co}/equity-changes?month=${month}&scope=${scope}`);
const jv = (date: string, dr: string, cr: string, amount: string) =>
  ok(owner, 'POST', `/companies/${co}/journal`, { date, description: 'ทดสอบ', lines: [{ account_code: dr, debit: amount }, { account_code: cr, credit: amount }] });
const table = (e: Eq) => Object.fromEntries(e.rows.map((r) => [r.key, [...e.columns.map((c) => r.values[c.key]), r.total]]));

beforeAll(async () => {
  ({ owner, other, co } = await setup({ vat: false }));
  await jv('2026-01-02', '1110', '3110', '100000');
  await jv('2026-01-10', '1110', '4120', '30000');
  await jv('2026-01-20', '5220', '1110', '12000');
  await jv('2026-01-25', '3310', '1110', '2000');
  await jv('2026-02-03', '1120', '3110', '20000');
  await jv('2026-02-10', '3110', '1110', '5000');
  await jv('2026-02-20', '5230', '1110', '4000');
});

describe('งบแสดงการเปลี่ยนแปลงส่วนของเจ้าของ: ตรงเฉลยคิดมือ', () => {
  it('ม.ค.: ลงทุน 100,000 กำไร 18,000 ถอนใช้ 2,000 → 116,000', async () => {
    const e = await eq('2026-01');
    expect(e.columns.map((c) => c.key)).toEqual(['capital', 'retained', 'drawings']);
    expect(table(e)).toEqual({
      opening: ['0.00', '0.00', '0.00', '0.00'],
      contribution: ['100000.00', '0.00', '0.00', '100000.00'],
      drawings: ['0.00', '0.00', '-2000.00', '-2000.00'],
      netIncome: ['0.00', '18000.00', '0.00', '18000.00'],
      closing: ['100000.00', '18000.00', '-2000.00', '116000.00'],
    });
    expect([e.positionEquity, e.matches]).toEqual(['116000.00', true]);
  });

  it('ก.พ.: ยกมา 116,000 ลงทุนเพิ่ม 20,000 ถอนทุน 5,000 ขาดทุน 4,000 → 127,000', async () => {
    const e = await eq('2026-02');
    expect(table(e)).toEqual({
      opening: ['100000.00', '18000.00', '-2000.00', '116000.00'],
      contribution: ['20000.00', '0.00', '0.00', '20000.00'],
      withdrawal: ['-5000.00', '0.00', '0.00', '-5000.00'],
      netIncome: ['0.00', '-4000.00', '0.00', '-4000.00'],
      closing: ['115000.00', '14000.00', '-2000.00', '127000.00'],
    });
    expect(e.matches).toBe(true);
    const ytd = await eq('2026-02', 'ytd');
    expect(table(ytd).closing).toEqual(['115000.00', '14000.00', '-2000.00', '127000.00']);
    expect(table(ytd).netIncome).toEqual(['0.00', '14000.00', '0.00', '14000.00']);
    const st = await ok(owner, 'GET', `/companies/${co}/statements?month=2026-02&scope=ytd`);
    expect(ytd.netIncome).toBe(st.netIncome);
  });

  it('ข้ามปีหลังปิดบัญชี: กำไรปีก่อนอยู่ 3210 ยอดยกมาเท่าเดิม · เดือนที่มี CL ยังตรงงบฐานะ', async () => {
    await ok(owner, 'POST', `/companies/${co}/fiscal-years/2026-12-31/close`);
    const dec = await eq('2026-12', 'ytd');
    expect(table(dec).closing).toEqual(['115000.00', '14000.00', '-2000.00', '127000.00']);
    expect(dec.matches).toBe(true);
    await jv('2027-01-15', '1110', '4120', '5000');
    const jan = await eq('2027-01');
    expect(table(jan).opening).toEqual(['115000.00', '14000.00', '-2000.00', '127000.00']);
    expect(table(jan).closing).toEqual(['115000.00', '19000.00', '-2000.00', '132000.00']);
    expect([jan.positionEquity, jan.matches]).toEqual(['132000.00', true]);
  });

  it('สุ่ม 150 รายการบัญชีทุน/รายได้/ค่าใช้จ่าย: ตรงงบฐานะทุกเดือน', async () => {
    const s = await setup({ vat: false });
    const codes = ['1110', '1120', '2110', '3110', '3210', '3310', '4110', '4310', '5220', '5250'];
    let seed = 5;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    for (let i = 0; i < 150; i++) {
      const a = codes[rnd(codes.length)]!; let b = codes[rnd(codes.length)]!;
      if (a === b) b = a === '1110' ? '3110' : '1110';
      const amt = `${1 + rnd(50000)}.${String(rnd(100)).padStart(2, '0')}`;
      await ok(s.owner, 'POST', `/companies/${s.co}/journal`, { date: `2028-0${1 + rnd(3)}-${String(1 + rnd(28)).padStart(2, '0')}`, description: 'สุ่ม',
        lines: [{ account_code: a, debit: amt }, { account_code: b, credit: amt }] });
    }
    let prev: string | null = null;
    for (const m of ['2028-01', '2028-02', '2028-03']) {
      const e: Eq = await ok(s.owner, 'GET', `/companies/${s.co}/equity-changes?month=${m}&scope=month`);
      expect(e.matches).toBe(true);
      if (prev) expect(e.rows.find((r) => r.key === 'opening')!.total).toBe(prev);
      prev = e.rows.find((r) => r.key === 'closing')!.total;
    }
  });

  it('นักเรียนอื่นอ่านไม่ได้ · ส่งออก PDF/Excel ได้', async () => {
    expect([403, 404]).toContain((await as(other, 'GET', `/companies/${co}/equity-changes?month=2026-01`)).statusCode);
    const e = (await eq('2026-02')) as unknown as EquityChanges;
    const rep = equityChangesReport('บริษัท ก. จำกัด', e);
    for (const sec of rep.sections) for (const r of sec.rows) expect(r.cells.length).toBe(sec.columns.length);
    expect(rep.sections[0]!.rows.at(-1)!.cells.slice(-1)).toEqual(['127000.00']);
    expect((await toPdf(rep)).length).toBeGreaterThan(1000);
    expect((await toXlsx(rep)).length).toBeGreaterThan(1000);
  });
});
