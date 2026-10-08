// ตัวอย่างยอดบนหน้าจอเอกสารขาย/ซื้อ: สูตรเดียวกับ app.vat_calc ใน migration 015 (มีเทสต์เทียบทุกสตางค์)
// คิดเป็นสตางค์ด้วย BigInt ปัดครึ่งขึ้น (ยอดเป็นบวกเสมอ) ภาษีคิดจากยอดรวมทั้งใบ ไม่คิดรายบรรทัด

export type PriceMode = 'exclusive' | 'inclusive' | 'none';

/** a / b ปัดครึ่งขึ้น สำหรับจำนวนไม่ติดลบ */
const divRound = (a: bigint, b: bigint) => (2n * a + b) / (2n * b);

/** "7" / "7.00" → 700 (ร้อยส่วนของเปอร์เซ็นต์) */
export function rateHundredths(rate: string): bigint {
  const [i = '0', f = ''] = rate.trim().split('.');
  return BigInt(i) * 100n + BigInt(f.padEnd(2, '0').slice(0, 2));
}

/** จำนวน (ทศนิยม ≤ 3) × ราคา (สตางค์) → สตางค์ ปัดครึ่งขึ้น; รูปแบบผิด = null */
export function lineAmount(qty: string, priceCents: bigint): bigint | null {
  const m = /^(\d{1,11})(?:\.(\d{1,3}))?$/.exec(qty.trim());
  if (!m) return null;
  const milli = BigInt(m[1]!) * 1000n + BigInt((m[2] ?? '').padEnd(3, '0'));
  return divRound(milli * priceCents, 1000n);
}

export function vatCalc(grossCents: bigint, discountCents: bigint, rate: string, mode: PriceMode) {
  const r = rateHundredths(rate);
  if (mode === 'exclusive') {
    const base = grossCents - discountCents;
    const vat = divRound(base * r, 10000n);
    return { base, vat, total: base + vat };
  }
  if (mode === 'inclusive') {
    const total = grossCents - discountCents;
    const vat = divRound(total * r, 10000n + r);
    return { base: total - vat, vat, total };
  }
  const base = grossCents - discountCents;
  return { base, vat: 0n, total: base };
}
