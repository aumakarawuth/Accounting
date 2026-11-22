import { toCents } from './money';

/** เงินสมทบประกันสังคม (สตางค์) ตรงกับ acc.sso_contribution: 5% ของค่าจ้าง ฐาน 1,650–เพดาน เศษ ≥ 50 สตางค์ปัดขึ้นเป็นบาท */
export function ssoCents(wageCents: bigint, ceiling: string): bigint {
  if (wageCents <= 0n) return 0n;
  const max = toCents(ceiling) ?? 1500000n;
  const base = wageCents < 165000n ? 165000n : wageCents > max ? max : wageCents;
  const fiveBaht = base * 5n; // หน่วย 1/100 สตางค์ (ร้อยละ 5 ของสตางค์)
  return ((fiveBaht + 5000n) / 10000n) * 100n;
}
