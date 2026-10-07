// จัดรูปแบบเงินจากสตริงทศนิยม (ค่าจาก NUMERIC ของ Postgres) โดยไม่ผ่าน float เลย
// "12500.5" → "12,500.50"   "-1250" → "(1,250.00)"

const DECIMAL = /^(-)?(\d+)(?:\.(\d{1,2}))?$/;

export type MoneyStyle = 'plain' | 'parens';

export function formatMoney(value: string, style: MoneyStyle = 'parens'): string {
  const m = DECIMAL.exec(value.trim());
  if (!m) throw new Error(`จำนวนเงินไม่ถูกต้อง: ${value}`);
  const [, sign, intRaw, frac = ''] = m;
  const int = intRaw.replace(/^0+(?=\d)/, '').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const body = `${int}.${frac.padEnd(2, '0')}`;
  const isZero = /^0\.00$/.test(body);
  if (!sign || isZero) return body;
  return style === 'parens' ? `(${body})` : `-${body}`;
}

export function isNegative(value: string): boolean {
  return value.trim().startsWith('-') && !/^-0*(\.0*)?$/.test(value.trim());
}

// คำนวณบน UI เป็นสตางค์ด้วย BigInt (แถบผลต่างในสมุดรายวัน)
const INPUT = /^\d{1,16}(\.\d{0,2})?$/;

/** ค่าที่ผู้ใช้พิมพ์ → สตางค์; ว่าง = 0; รูปแบบผิด = null */
export function toCents(input: string): bigint | null {
  const s = input.trim().replace(/,/g, '');
  if (s === '') return 0n;
  if (!INPUT.test(s)) return null;
  const [int = '0', frac = ''] = s.split('.');
  return BigInt(int) * 100n + BigInt(frac.padEnd(2, '0'));
}

/** สตางค์ → สตริงทศนิยมสำหรับส่ง API ("1250.00") */
export function fromCents(cents: bigint): string {
  const neg = cents < 0n;
  const abs = neg ? -cents : cents;
  const s = `${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`;
  return neg ? `-${s}` : s;
}
