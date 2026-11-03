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
      className="flex min-h-11 min-w-11 shrink-0 items-center justify-center text-xl sm:hidden"
      onClick={() => (window.history.length > 1 ? router.back() : router.push(fallback))}
    >
      ‹
    </button>
  );
}
