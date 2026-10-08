// จำนวนเงินเป็นตัวอักษรภาษาไทยบนใบกำกับภาษี/ใบเสร็จ (แบบ BAHTTEXT) รับสตริงทศนิยม 2 ตำแหน่งจาก API
// "13375.00" → "หนึ่งหมื่นสามพันสามร้อยเจ็ดสิบห้าบาทถ้วน"

const DIGIT = ['', 'หนึ่ง', 'สอง', 'สาม', 'สี่', 'ห้า', 'หก', 'เจ็ด', 'แปด', 'เก้า'];
const PLACE = ['', 'สิบ', 'ร้อย', 'พัน', 'หมื่น', 'แสน'];

/** 0–999,999 ในกลุ่มล้านเดียว; higher = มีหลักล้านขึ้นไปนำหน้า (หน่วย 1 อ่านว่า "เอ็ด") */
function group(n: bigint, higher: boolean): string {
  const s = n.toString();
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const d = Number(s[i]);
    const p = s.length - 1 - i;
    if (d === 0) continue;
    if (p === 1) out += d === 1 ? 'สิบ' : d === 2 ? 'ยี่สิบ' : `${DIGIT[d]}สิบ`;
    else if (p === 0) out += d === 1 && (n > 9n || higher) ? 'เอ็ด' : DIGIT[d];
    else out += DIGIT[d] + PLACE[p];
  }
  return out;
}

function words(n: bigint): string {
  if (n < 1_000_000n) return group(n, false);
  const millions = n / 1_000_000n;
  const rest = n % 1_000_000n;
  return `${words(millions)}ล้าน${group(rest, true)}`;
}

export function bahtText(amount: string): string {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(amount.trim());
  if (!m) throw new Error(`จำนวนเงินไม่ถูกต้อง: ${amount}`);
  const baht = BigInt(m[1]!);
  const satang = BigInt((m[2] ?? '').padEnd(2, '0'));
  if (baht === 0n && satang === 0n) return 'ศูนย์บาทถ้วน';
  const b = baht > 0n ? `${words(baht)}บาท` : '';
  return satang === 0n ? `${b}ถ้วน` : `${b}${group(satang, false)}สตางค์`;
}
