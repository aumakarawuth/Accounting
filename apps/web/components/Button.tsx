import type { ButtonHTMLAttributes } from 'react';

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary';
  /** ปุ่มลัดบนคอม เช่น F9 (ซ่อนบนจอสัมผัส) */
  shortcut?: string;
};

// ปุ่มสี่เหลี่ยมแบน ตัวหนังสือล้วน ไม่มีเงา มุม 2px (docs/design.md ข้อ 4)
export function Button({ variant = 'primary', shortcut, className = '', children, ...rest }: Props) {
  const look =
    variant === 'primary'
      ? 'bg-ink text-paper disabled:bg-disabled disabled:text-ink2'
      : 'border border-ink bg-transparent text-ink disabled:border-disabled disabled:text-ink2';
  return (
    <button
      {...rest}
      className={`inline-flex min-h-11 items-center justify-center gap-3.5 rounded-doc px-4 font-medium max-sm:min-h-13 disabled:cursor-not-allowed ${look} ${className}`}
    >
      {children}
      {shortcut && <span className="hidden font-num text-xs opacity-80 lg:inline">{shortcut}</span>}
    </button>
  );
}
