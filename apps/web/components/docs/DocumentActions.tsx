'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/Button';
import { postJson, type ApiError } from '@/lib/api';
import { isoToThai, thaiToIso, todayIso } from '@/lib/date';
import { th } from '@/i18n/th';

// แถบคำสั่งของเอกสารขาย/ซื้อที่ผ่านรายการแล้ว: ลิงก์ตามชนิดเอกสาร (ลด/เพิ่มหนี้ รับ/จ่ายชำระ) ดูรายการบัญชี พิมพ์
// และยกเลิก (กลับรายการ RV พร้อมเหตุผล) ที่ API ปลายทาง voidPath
export type ActionLink = { href: string; label: string; primary?: boolean };
export function DocumentActions({ companyId, doc, voidPath, links, writable }: {
  companyId: string; doc: { docNo: string; entryId: string; entryDocNo: string; voidedAt: string | null };
  voidPath: string; links: ActionLink[]; writable: boolean;
}) {
  const router = useRouter();
  const [voiding, setVoiding] = useState(false);
  const [date, setDate] = useState(isoToThai(todayIso()));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idem = useRef(crypto.randomUUID());
  const c = (p: string) => `/c/${companyId}${p}`;
  const live = !doc.voidedAt;
  const link = 'inline-flex min-h-11 items-center justify-center rounded-doc border border-ink px-4 font-medium max-sm:min-h-13';
  const isoDate = thaiToIso(date);

  const submitVoid = async () => {
    if (!isoDate || !reason.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await postJson(voidPath, { date: isoDate, reason: reason.trim() }, { 'idempotency-key': idem.current });
      setVoiding(false);
      router.refresh();
    } catch (e) {
      const err = e as ApiError;
      setError(err.code === 'server' ? th.error.server(err.ref ?? '-') : err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 print:hidden">
      <div className="flex flex-wrap gap-2.5 max-sm:grid max-sm:grid-cols-2">
        {writable && live && links.map((l) => (
          <Link key={l.href} className={`${link} ${l.primary ? 'bg-ink text-paper' : ''}`} href={l.href}>{l.label}</Link>
        ))}
        <Link className={link} href={c(`/journal/${doc.entryId}`)}>{th.sales.viewEntry(doc.entryDocNo)}</Link>
        <Button type="button" variant="secondary" shortcut="Ctrl+P" onClick={() => window.print()}>{th.sales.print}</Button>
        {writable && live && !voiding && (
          <Button type="button" variant="secondary" onClick={() => setVoiding(true)}>{th.sales.void}</Button>
        )}
      </div>

      {voiding && (
        <section aria-label={th.sales.voidTitle(doc.docNo)} className="flex max-w-xl flex-col gap-3 border border-ink bg-paper p-4">
          <h2 className="font-doc text-[17px] font-bold">{th.sales.voidTitle(doc.docNo)}</h2>
          <p className="text-sm">{th.sales.voidExplain}</p>
          <label className="flex flex-col text-sm">
            {th.sales.voidReason}
            <input className="h-11 border-b border-rule-input bg-transparent text-base" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />
          </label>
          <label className="flex flex-col text-sm">
            {th.sales.voidDate}
            <input className="h-11 border-b border-rule-input bg-transparent font-num text-base" inputMode="numeric" value={date} onChange={(e) => setDate(e.target.value)} aria-invalid={isoDate === null} />
          </label>
          {error && <p role="alert" className="neg text-sm">{error}</p>}
          <div className="flex gap-3 max-sm:grid max-sm:grid-cols-2">
            <Button type="button" disabled={busy || !reason.trim() || !isoDate} onClick={() => void submitVoid()}>{th.sales.voidConfirm}</Button>
            <Button type="button" variant="secondary" onClick={() => { setVoiding(false); setError(null); }}>{th.sales.cancel}</Button>
          </div>
        </section>
      )}
    </div>
  );
}
