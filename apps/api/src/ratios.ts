import type pg from 'pg';
import { statements, type StatementsData } from './reports.js';

// วิเคราะห์อัตราส่วนทางการเงิน (docs/phase7-spec.md ข้อ 4) จากงบการเงินของงวด (ก่อนปิดบัญชี) เงินคิดเป็นสตางค์ (BigInt)
// ยอดถัวเฉลี่ย = (ต้นงวด + ปลายงวด) ÷ 2 · ต้นงวด = ยอดสิ้นเดือนก่อนต้นงวด · ต้นงวดเป็นศูนย์ = ใช้ปลายงวด
// ผลลัพธ์ปัด 2 ตำแหน่งครึ่งขึ้น · ตัวหารเป็นศูนย์ (หรือติดลบสำหรับส่วนของเจ้าของ) = คำนวณไม่ได้ (null)

export type RatioKey = 'current' | 'quick' | 'receivableTurnover' | 'collectionDays' | 'inventoryTurnover' | 'inventoryDays'
  | 'assetTurnover' | 'grossMargin' | 'netMargin' | 'roa' | 'roe' | 'debtToEquity';
export type RatioItem = { key: RatioKey; group: 'liquidity' | 'efficiency' | 'profitability' | 'leverage'; unit: 'times' | 'percent' | 'days'; value: string | null };
export type RatiosData = {
  month: string; scope: 'month' | 'ytd'; from: string; days: number;
  /** ตัวเลขที่ใช้ (สตริงทศนิยม) */
  figures: Record<string, string>;
  items: RatioItem[];
};

const toC = (v: string): bigint => {
  const neg = v.startsWith('-');
  const [i, f = ''] = (neg ? v.slice(1) : v).split('.');
  const c = BigInt(i || '0') * 100n + BigInt((f + '00').slice(0, 2));
  return neg ? -c : c;
};
const money = (c: bigint) => {
  const neg = c < 0n;
  const a = neg ? -c : c;
  return `${neg ? '-' : ''}${a / 100n}.${String(a % 100n).padStart(2, '0')}`;
};
/** num ÷ den × mult ปัด 2 ตำแหน่งครึ่งขึ้น (ห่างศูนย์) · den ≤ 0 = null */
export function ratio(num: bigint, den: bigint, mult = 1n): string | null {
  if (den <= 0n) return null;
  const n = num * mult * 100n;
  const neg = n < 0n;
  const a = neg ? -n : n;
  const q = (a * 2n + den) / (den * 2n); // หน่วย 0.01
  return money(neg ? -q : q);
}
const sum = (lines: { code: string; amount: string }[], re: RegExp) => lines.filter((l) => re.test(l.code)).reduce((a, l) => a + toC(l.amount), 0n);
/** ยอดถัวเฉลี่ย × 2 (ไม่หารก่อน กันเศษสตางค์หาย) · ต้นงวดเป็นศูนย์ = ปลายงวด */
const avg2 = (open: bigint, close: bigint) => (open === 0n ? close * 2n : open + close);
const half = (v: bigint) => (v >= 0n ? (v + 1n) / 2n : -((-v + 1n) / 2n));
const prevMonth = (m: string) => {
  const [y, mm] = m.split('-').map(Number) as [number, number];
  return mm === 1 ? `${y - 1}-12` : `${y}-${String(mm - 1).padStart(2, '0')}`;
};
const daysBetween = (from: string, month: string) => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const end = Date.UTC(y, m, 1);
  const [fy, fm] = from.split('-').map(Number) as [number, number];
  return Math.round((end - Date.UTC(fy, fm - 1, 1)) / 86_400_000);
};

export function computeRatios(st: StatementsData, open: StatementsData | null, days: number): Omit<RatiosData, 'month' | 'scope' | 'from' | 'days'> {
  const k = st.classified, m = st.multiStep;
  const ca = toC(k.totalCurrentAssets), cl = toC(k.totalCurrentLiabilities);
  const quickAssets = sum(st.assets, /^1[12]/);
  const ar = sum(st.assets, /^12/), arOpen = open ? sum(open.assets, /^12/) : 0n;
  const inv = sum(st.assets, /^13/), invOpen = open ? sum(open.assets, /^13/) : 0n;
  const ta = toC(st.totalAssets), taOpen = open ? toC(open.totalAssets) : 0n;
  const te = toC(st.totalEquity), teOpen = open ? toC(open.totalEquity) : 0n;
  const tl = toC(st.totalLiabilities);
  const sales = toC(m.netSales), gross = toC(m.grossProfit), ni = toC(st.netIncome);
  const cogs = m.costOfSales ? toC(m.costOfSales.total) : 0n;
  const avgAr = avg2(arOpen, ar), avgInv = avg2(invOpen, inv), avgTa = avg2(taOpen, ta), avgTe = avg2(teOpen, te);
  const d = BigInt(days);
  const figures = {
    currentAssets: money(ca), currentLiabilities: money(cl), quickAssets: money(quickAssets),
    receivablesOpening: money(arOpen), receivables: money(ar), averageReceivables: money(half(avgAr)),
    inventoryOpening: money(invOpen), inventory: money(inv), averageInventory: money(half(avgInv)),
    totalAssetsOpening: money(taOpen), totalAssets: money(ta), averageAssets: money(half(avgTa)),
    equityOpening: money(teOpen), equity: money(te), averageEquity: money(half(avgTe)), liabilities: money(tl),
    netSales: money(sales), costOfSales: money(cogs), grossProfit: money(gross), netIncome: money(ni),
  };
  const items: RatioItem[] = [
    { key: 'current', group: 'liquidity', unit: 'times', value: ratio(ca, cl) },
    { key: 'quick', group: 'liquidity', unit: 'times', value: ratio(quickAssets, cl) },
    { key: 'receivableTurnover', group: 'efficiency', unit: 'times', value: ratio(sales * 2n, avgAr) },
    { key: 'collectionDays', group: 'efficiency', unit: 'days', value: ratio(avgAr * d, sales * 2n) },
    { key: 'inventoryTurnover', group: 'efficiency', unit: 'times', value: ratio(cogs * 2n, avgInv) },
    { key: 'inventoryDays', group: 'efficiency', unit: 'days', value: ratio(avgInv * d, cogs * 2n) },
    { key: 'assetTurnover', group: 'efficiency', unit: 'times', value: ratio(sales * 2n, avgTa) },
    { key: 'grossMargin', group: 'profitability', unit: 'percent', value: ratio(gross, sales, 100n) },
    { key: 'netMargin', group: 'profitability', unit: 'percent', value: ratio(ni, sales, 100n) },
    { key: 'roa', group: 'profitability', unit: 'percent', value: ratio(ni * 2n, avgTa, 100n) },
    { key: 'roe', group: 'profitability', unit: 'percent', value: ratio(ni * 2n, avgTe, 100n) },
    { key: 'debtToEquity', group: 'leverage', unit: 'times', value: ratio(tl, te) },
  ];
  return { figures, items };
}

export async function financialRatios(c: pg.PoolClient, companyId: string, month: string, scope: 'month' | 'ytd'): Promise<RatiosData> {
  const st = await statements(c, companyId, month, scope);
  const from = st.from;
  const hasPrior = (await c.query(`select exists (select 1 from acc.journal_entries where company_id = $1 and entry_date < $2::date) x`, [companyId, `${from}-01`])).rows[0].x;
  const open = hasPrior ? await statements(c, companyId, prevMonth(from), 'month') : null;
  const days = daysBetween(from, month);
  return { month, scope, from, days, ...computeRatios(st, open, days) };
}
