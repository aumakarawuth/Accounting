'use client';

import { useRouter } from 'next/navigation';
import { postJson } from '@/lib/api';
import { clearAllDrafts } from '@/lib/drafts';
import { th } from '@/i18n/th';

export function LogoutButton({ className = '' }: { className?: string }) {
  const router = useRouter();
  return (
    <button
      type="button"
      className={`min-h-11 text-sm underline ${className}`}
      onClick={async () => {
        await postJson('/auth/logout', {}).catch(() => {});
        await clearAllDrafts(); // เครื่องห้องคอมใช้ร่วมกัน: ไม่ทิ้งร่างไว้ให้คนถัดไป
        router.replace('/login');
        router.refresh();
      }}
    >
      {th.login.logout}
    </button>
  );
}
