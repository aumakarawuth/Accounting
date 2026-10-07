import { formatMoney, isNegative } from '@/lib/money';

// ตัวเลขเงิน tabular ชิดขวา ติดลบเป็นสีแดง + วงเล็บ (ไม่ใช้สีอย่างเดียว)
export function Money({ value, className = '' }: { value: string; className?: string }) {
  return (
    <span className={`num ${isNegative(value) ? 'neg' : ''} ${className}`}>{formatMoney(value)}</span>
  );
}
