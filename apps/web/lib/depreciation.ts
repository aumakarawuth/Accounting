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
