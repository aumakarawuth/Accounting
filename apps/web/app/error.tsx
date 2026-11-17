'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { th } from '@/i18n/th';

// หน้า error ของทั้งเว็บ: เดิมไม่มี → API ตอบผิดพลาดระหว่างแสดงหน้า (เช่น ส่งคำขอถี่เกิน 429) ได้หน้า "Application error" ภาษาอังกฤษ
// (ทดสอบห้องเรียน 50 คน docs/load-test-class50.md) · ลองใหม่ = ดึงข้อมูลฝั่งเซิร์ฟเวอร์ใหม่แล้วแสดงหน้าเดิม
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <main className="mx-auto flex max-w-xl flex-col gap-3 p-6" role="alert">
      <h1 className="font-doc text-[22px] font-bold">{th.error.pageTitle}</h1>
      <p>{th.error.pageBody}</p>
      {error.digest && <p className="font-num text-sm text-ink2">{th.error.pageRef(error.digest)}</p>}
      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          disabled={pending}
          className="min-h-11 rounded-doc bg-ink px-4 font-medium text-paper disabled:bg-disabled disabled:text-ink2"
          onClick={() => start(() => { router.refresh(); reset(); })}
        >
          {th.error.pageRetry}
        </button>
        <a href="/" className="flex min-h-11 items-center underline">{th.error.pageHome}</a>
      </div>
    </main>
  );
}
