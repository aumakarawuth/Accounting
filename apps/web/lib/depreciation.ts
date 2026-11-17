// ค่าเสื่อมราคาเส้นตรงรายเดือน คิดเป็นสตางค์ด้วย BigInt (สูตรเดียวกับ app.depreciation_cum ใน db/migrations/20261103000027)
// ต่อเดือน = ปัดครึ่งขึ้น((ราคาทุน − ราคาซาก) / อายุ) · ยอดสะสมไม่เกินมูลค่าเสื่อมได้ · เดือนสุดท้ายรับส่วนต่างให้ครบพอดี

/** ค่าเสื่อมต่อเดือน (สตางค์) */
export function monthlyDepreciation(cost: bigint, salvage: bigint, life: number): bigint {
  const base = cost - salvage;
  const n = BigInt(life);
  return (2n * base + n) / (2n * n);
}

/** ค่าเสื่อมราคาสะสมหลังเดือนที่ n (สตางค์) */
export function cumulativeDepreciation(cost: bigint, salvage: bigint, life: number, n: number): bigint {
  const base = cost - salvage;
  if (n <= 0) return 0n;
  if (n >= life) return base;
  const v = monthlyDepreciation(cost, salvage, life) * BigInt(n);
  return v < base ? v : base;
}

/** ค่าเสื่อมของเดือนที่ n (1 = เดือนแรก) */
export function depreciationFor(cost: bigint, salvage: bigint, life: number, n: number): bigint {
  return cumulativeDepreciation(cost, salvage, life, n) - cumulativeDepreciation(cost, salvage, life, n - 1);
}

/** ตารางค่าเสื่อมทั้งอายุ (ใช้แสดงตัวอย่างบนฟอร์ม) */
export function schedule(cost: bigint, salvage: bigint, life: number): bigint[] {
  return Array.from({ length: life }, (_, i) => depreciationFor(cost, salvage, life, i + 1));
}

// ---- ตามจำนวนวัน (สูตรเดียวกับ app.daily_depreciation_cum ใน db/migrations/20261114000114) ----
const day = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / 86_400_000;
const isoOf = (d: number) => new Date(d * 86_400_000).toISOString().slice(0, 10);

/** จำนวนวันทั้งอายุ: วันที่ได้มา ถึงก่อนวันเดียวกันของเดือนที่ครบอายุ (ปลายเดือนที่ไม่มีวันนั้นใช้วันสุดท้าย) */
export function lifeDays(acquired: string, life: number): number {
  const y = Number(acquired.slice(0, 4)); const m = Number(acquired.slice(5, 7)) - 1 + life; const d = Number(acquired.slice(8, 10));
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return Date.UTC(y, m, Math.min(d, last)) / 86_400_000 - day(acquired);
}

/** ค่าเสื่อมสะสมถึงสิ้นวัน through (สตางค์) นับวันที่ได้มาเป็นวันแรก ปัดครึ่งขึ้น */
export function dailyCumulative(cost: bigint, salvage: bigint, acquired: string, life: number, through: string): bigint {
  const total = BigInt(lifeDays(acquired, life));
  const days = BigInt(Math.max(0, day(through) - day(acquired) + 1));
  const base = cost - salvage;
  if (days >= total) return base;
  return (2n * base * days + total) / (2n * total);
}

/** วันก่อนหน้า (YYYY-MM-DD) */
export const dayBefore = (iso: string) => isoOf(day(iso) - 1);
/** วันสุดท้ายของเดือนที่มีวันที่นี้ */
export const monthEnd = (iso: string) => isoOf(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)), 0) / 86_400_000);
