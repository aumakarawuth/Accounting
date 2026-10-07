'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/Button';
import { api, type ApiError } from '@/lib/api';
import { isoToThai, thaiToIso, todayIso } from '@/lib/date';
import { th } from '@/i18n/th';

type Entry = { id: string; docNo: string; date: string; periodClosed: boolean };

// กลับรายการแบบสองจังหวะ: กดเปิดฟอร์ม (เลือกวันที่) → ยืนยัน
// คีย์ idempotency คงเดิมจนสำเร็จ กดซ้ำหรือเน็ตหลุดแล้วส่งใหม่ไม่เกิดรายการกลับซ้ำ
export function ReverseEntry({ companyId, entry, locked }: { companyId: string; entry: Entry; locked: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(isoToThai(entry.periodClosed ? todayIso() : entry.date));
  const [description, setDescription] = useState(th.journal.reversalOf(entry.docNo));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = useRef(crypto.randomUUID());
  const iso = thaiToIso(date);

  if (locked) return <p className="text-sm text-ink2">{th.submission.lockedNote}</p>;

  async function submit() {
    if (!iso || busy) return;
    if (!navigator.onLine) { setError(th.error.offline); return; }
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ id: string; docNo: string }>(`/companies/${companyId}/journal/${entry.id}/reverse`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': key.current },
        body: JSON.stringify({ date: iso, description: description.trim() || th.journal.reversalOf(entry.docNo) }),
      });
      router.push(`/c/${companyId}/journal/${r.id}`);
      router.refresh();
    } catch (e) {
      const err = e as ApiError;
      setError(err.code === 'server' ? th.error.server(err.ref ?? '-') : err.message);
      if (err.code === 'ACC03') key.current = crypto.randomUUID();
      if (err.code === 'ACC12') router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-3 border border-rule-strong bg-paper p-4" aria-label={th.journal.reverse}>
      <h2 className="text-[17px] font-semibold">{th.journal.reverse}</h2>
      <p className="text-sm text-ink2">{th.journal.reverseExplain}</p>
      {entry.periodClosed && <p className="text-sm">{th.journal.periodClosed}</p>}
      {!open ? (
        <div>
          <Button type="button" variant="secondary" onClick={() => setOpen(true)} className="max-sm:w-full">{th.journal.reverse}</Button>
        </div>
      ) : (
        <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <div className="grid gap-3 sm:grid-cols-[180px_minmax(0,1fr)] sm:gap-5">
            <label className="flex flex-col text-sm">
              {th.journal.reverseDate}
              <input
                className="h-11 border-b border-rule-input bg-transparent px-0.5 font-num text-base"
                inputMode="numeric"
                value={date}
                // เนื้อหาเปลี่ยนต้องใช้คีย์ใหม่ ไม่อย่างนั้น DB ตอบว่าคีย์ถูกใช้กับคำขออื่น (ACC03)
                onChange={(e) => { setDate(e.target.value); key.current = crypto.randomUUID(); }}
                aria-invalid={iso === null}
                aria-describedby={iso === null ? 'reverse-date-error' : undefined}
              />
              {iso === null && <span id="reverse-date-error" className="neg mt-1 text-[13px]">{th.journal.dateInvalid}</span>}
            </label>
            <label className="flex flex-col text-sm">
              {th.journal.reverseDesc}
              <input
                className="h-11 border-b border-rule-input bg-transparent px-0.5 text-base"
                value={description}
                maxLength={500}
                onChange={(e) => { setDescription(e.target.value); key.current = crypto.randomUUID(); }}
              />
            </label>
          </div>
          {error && <p role="alert" className="neg text-sm">{error}</p>}
          <div className="flex flex-wrap gap-3">
            <Button type="submit" disabled={busy || iso === null} className="max-sm:w-full">{th.journal.reverseConfirm(entry.docNo)}</Button>
            <Button type="button" variant="secondary" disabled={busy} onClick={() => { setOpen(false); setError(null); }} className="max-sm:w-full">
              {th.journal.cancel}
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
