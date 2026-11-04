'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { postJson, type ApiError } from '@/lib/api';
import { th } from '@/i18n/th';

const field = 'h-11 w-full rounded-doc border border-rule-input bg-paper px-2 text-base';

export function DemoCreate({ sets }: { sets: { id: string; title: string; companyName: string }[] }) {
  const router = useRouter();
  const [setId, setSetId] = useState(sets[0]?.id ?? '');
  const [name, setName] = useState<string>(th.demo.companyDefault);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form className="flex flex-wrap items-end gap-3 border border-rule-strong bg-paper p-4" onSubmit={async (e) => {
      e.preventDefault();
      setBusy(true);
      setError(null);
      try {
        const r = setId
          ? await postJson<{ companyId: string }>(`/teacher/exercises/${setId}/assign`, { mode: 'demo', companyName: name })
          : await postJson<{ companyId: string }>('/teacher/demo', { companyName: name });
        router.push(`/c/${r.companyId}/work`);
      } catch (err) {
        setError((err as ApiError).message);
        setBusy(false);
      }
    }}>
      <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm max-sm:basis-full">{th.demo.chooseSet}
        <select className={field} value={setId} onChange={(e) => setSetId(e.target.value)}>
          {sets.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
          <option value="">{th.demo.noSet}</option>
        </select>
      </label>
      <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm max-sm:basis-full">{th.demo.companyName}
        <input className={field} required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <button type="submit" disabled={busy} className="min-h-11 rounded-doc bg-ink px-4 font-medium text-paper disabled:bg-disabled disabled:text-ink2 max-sm:min-h-13 max-sm:basis-full">{th.demo.create}</button>
      {error && <p role="alert" className="neg basis-full text-sm">{error}</p>}
    </form>
  );
}
