import Link from 'next/link';
import { addMonths, monthLabel } from '@/lib/date';
import { th } from '@/i18n/th';

// เลื่อนงวดทีละเดือน (ลิงก์ธรรมดา ใช้ได้ทั้งสัมผัสและคีย์บอร์ด)
export function MonthNav({ month, href }: { month: string; href: (m: string) => string }) {
  const prev = addMonths(month, -1);
  const next = addMonths(month, 1);
  const btn = 'flex min-h-11 min-w-11 items-center justify-center border border-rule-strong bg-paper px-3';
  return (
    <nav aria-label={th.month.current(monthLabel(month))} className="flex items-stretch">
      <Link href={href(prev)} className={btn} aria-label={th.month.prev(monthLabel(prev))}>‹</Link>
      <span className="flex min-h-11 items-center border-y border-rule-strong bg-paper px-4 font-medium">{th.month.current(monthLabel(month))}</span>
      <Link href={href(next)} className={btn} aria-label={th.month.next(monthLabel(next))}>›</Link>
    </nav>
  );
}
