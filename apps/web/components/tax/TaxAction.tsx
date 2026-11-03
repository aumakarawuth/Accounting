'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/Button';
import { postJson, type ApiError } from '@/lib/api';
import { isoToThai, thaiToIso } from '@/lib/date';
import { th } from '@/i18n/th';

// คำสั่งภาษีที่ต้องยืนยันก่อน (ปิดภาษี ชำระ นำส่ง ยกเลิกการปิด): กดแล้วกางกรอบอธิบาย + ช่องที่ต้องกรอก แล้วจึงยืนยัน
// ช่อง: วันที่ + บัญชีจ่ายเงิน (ชำระ/นำส่ง) หรือเหตุผล (ยกเลิก) หรือไม่มี (ปิดภาษี)
export function TaxAction({ label, title, explain, path, input, cashAccounts = [], defaultDate, variant = 'primary' }: {
  label: string; title: string; explain: string; path: string; input: 'payment' | 'reason' | 'none';
  cashAccounts?: { code: string; name: string }[]; defaultDate?: string; variant?: 'primary' | 'secondary';
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(defaultDate ? isoToThai(defaultDate) : '');
  const [cash, setCash] = useState(cashAccounts[0]?.code ?? '1110');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [idemKey, setIdemKey] = useState(() => crypto.randomUUID());
  const isoDate = thaiToIso(date);
  const ready = input === 'none' || (input === 'reason' ? reason.trim().length > 0 : isoDate !== null);

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const body = input === 'payment' ? { date: isoDate, cashAccount: cash } : input === 'reason' ? { reason: reason.trim() } : undefined;
      await postJson(path, body ?? {}, { 'idempotency-key': idemKey });
      setOpen(false);
      setIdemKey(crypto.randomUUID());
      router.refresh();
    } catch (e) {
      const err = e as ApiError;
      setError(err.code === 'server' ? th.error.server(err.ref ?? '-') : err.message);
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return <Button type="button" variant={variant} onClick={() => setOpen(true)}>{label}</Button>;
  }
  const field = 'h-11 border-b border-rule-input bg-transparent text-base';
  return (
    <section aria-label={title} className="flex w-full flex-col gap-3 border border-ink bg-paper p-4 print:hidden">
      <h3 className="font-doc text-[17px] font-bold">{title}</h3>
      <p className="text-sm">{explain}</p>
      {input === 'payment' && (
        <div className="grid gap-3 @md:grid-cols-2">
          <label className="flex flex-col text-sm">
            {th.tax.payDate}
            <input className={`${field} font-num`} inputMode="numeric" value={date} onChange={(e) => setDate(e.target.value)} aria-invalid={isoDate === null} />
          </label>
          <label className="flex flex-col text-sm">
            {th.tax.cashAccount}
            <select className={field} value={cash} onChange={(e) => setCash(e.target.value)}>
              {cashAccounts.map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}
            </select>
          </label>
        </div>
      )}
      {input === 'reason' && (
        <label className="flex flex-col text-sm">
          {th.tax.voidReason}
          <input className={field} value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />
        </label>
      )}
      {error && <p role="alert" className="neg text-sm">{error}</p>}
      <div className="flex gap-3 max-sm:grid max-sm:grid-cols-2">
        <Button type="button" disabled={busy || !ready} onClick={() => void submit()}>{input === 'none' ? th.tax.confirmClose : th.tax.confirm}</Button>
        <Button type="button" variant="secondary" onClick={() => { setOpen(false); setError(null); }}>{th.tax.cancel}</Button>
      </div>
    </section>
  );
}
