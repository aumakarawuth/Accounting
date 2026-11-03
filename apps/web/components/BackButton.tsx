'use client';

import { useRouter } from 'next/navigation';
import { th } from '@/i18n/th';

// มือถือ (โดยเฉพาะแอปที่ติดตั้งบนหน้าจอ) ไม่มีปุ่มย้อนกลับของเบราว์เซอร์
export function BackButton({ fallback }: { fallback: string }) {
  const router = useRouter();
  return (
    <button
      type="button"
      aria-label={th.nav.back}
      className="mr-1 flex min-h-12 shrink-0 items-center gap-1 rounded-doc border border-rule-strong px-3 text-base font-medium sm:hidden"
      onClick={() => (window.history.length > 1 ? router.back() : router.push(fallback))}
    >
      <span aria-hidden className="text-3xl leading-none">‹</span>
      {th.nav.back}
    </button>
  );
}
