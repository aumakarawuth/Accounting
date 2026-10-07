'use client';

import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { postJson, type ApiError } from '@/lib/api';
import { th } from '@/i18n/th';

// เปิดบริษัทจำลองให้นักเรียนทุกคนในห้อง (กดซ้ำได้ คนที่มีบริษัทชื่อนี้แล้วไม่ถูกสร้างซ้ำ)
export function OpenCompanies({ classroomId }: { classroomId: string }) {
  const router = useRouter();
  const id = useId();
  const [name, setName] = useState<string>(th.teacher.companyNameDefault);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <form
      className="flex flex-wrap items-end gap-3 border border-rule-strong bg-paper p-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setMsg(null);
        try {
          const r = await postJson<{ created: number; existing: number }>(`/classrooms/${classroomId}/companies`, { name });
          setMsg({ ok: true, text: th.teacher.opened(r.created, r.existing) });
          router.refresh();
        } catch (err) {
          setMsg({ ok: false, text: (err as ApiError).message });
        } finally {
          setBusy(false);
        }
      }}
    >
      <label htmlFor={id} className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
        {th.teacher.openCompanies} · {th.teacher.companyName}
        <input id={id} required maxLength={120} className="h-11 rounded-doc border border-rule-input bg-paper px-3 text-base" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <button type="submit" disabled={busy} className="min-h-11 rounded-doc bg-ink px-4 font-medium text-paper disabled:bg-disabled disabled:text-ink2">
        {th.teacher.openSubmit}
      </button>
      {msg && <p role={msg.ok ? 'status' : 'alert'} className={`basis-full text-sm ${msg.ok ? '' : 'neg'}`}>{msg.text}</p>}
    </form>
  );
}
