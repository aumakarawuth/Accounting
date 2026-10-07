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
