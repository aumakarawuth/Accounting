'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { postJson, type ApiError } from '@/lib/api';
import { th } from '@/i18n/th';

// เริ่มสอบ (กดสองจังหวะ) เวลาเริ่มนับที่ DB ทันที เครื่องอื่นของนักเรียนถูกออกจากระบบ
export function StartExam({ companyId }: { companyId: string }) {
  const router = useRouter();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-2">
      <button type="button" disabled={busy}
        className="min-h-13 self-start rounded-doc bg-ink px-5 font-medium text-paper disabled:bg-disabled disabled:text-ink2 max-sm:self-stretch"
        onClick={async () => {
          if (!confirm) { setConfirm(true); return; }
          setBusy(true);
          setError(null);
          try {
            await postJson(`/companies/${companyId}/assignment/start`, {});
            router.refresh();
          } catch (e) {
            setError((e as ApiError).message);
          } finally {
            setBusy(false);
          }
        }}>
        {confirm ? th.myAssignment.confirmStart : th.myAssignment.startExam}
      </button>
      {error && <p role="alert" className="neg text-sm">{error}</p>}
    </div>
  );
}
