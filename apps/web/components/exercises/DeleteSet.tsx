'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { postJson, type ApiError } from '@/lib/api';
import { th } from '@/i18n/th';

export function DeleteSet({ setId }: { setId: string }) {
  const router = useRouter();
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-2 border-t border-rule pt-3">
      <button type="button" className="min-h-11 self-start rounded-doc border border-ink px-4 text-sm"
        onClick={async () => {
          if (!confirm) { setConfirm(true); return; }
          try { await postJson(`/teacher/exercises/${setId}/delete`, {}); router.push('/teacher/exercises'); }
          catch (e) { setError((e as ApiError).message); }
        }}>
        {confirm ? th.exercises.confirmDelete : th.exercises.delete}
      </button>
      {error && <p role="alert" className="neg text-sm">{error}</p>}
    </div>
  );
}
