'use client';
import { maskDate } from '@/lib/date';

import { useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/Button';
import { postJson, type ApiError } from '@/lib/api';
import { th } from '@/i18n/th';

export const errText = (e: unknown) => {
  const err = e as ApiError;
  return err.code === 'server' ? th.error.server(err.ref ?? '-') : err.message;
};

/** คำขอเขียนพร้อมคีย์กันกดซ้ำ: คีย์เดิมจนสำเร็จ (เน็ตหลุดแล้วกดใหม่ไม่เกิดรายการซ้ำ) แล้วโหลดหน้าใหม่ */
export function useAction() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [key, setKey] = useState(() => crypto.randomUUID());
  const run = async <T,>(path: string, body: unknown): Promise<T | null> => {
    if (!navigator.onLine) { setError(th.error.offline); return null; }
    setBusy(true);
    setError(null);
    try {
      const r = await postJson<T>(path, body, { 'idempotency-key': key });
      setKey(crypto.randomUUID());
      router.refresh();
      return r;
    } catch (e) {
      setError(errText(e));
      return null;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, setError, run };
}

/** กรอบยืนยันคำสั่งที่ลงบัญชี: ชื่อ คำอธิบายว่าระบบจะลงอะไร ช่องที่ต้องกรอก ปุ่มยืนยัน/ยกเลิก (ไม่ใช่ popup ลอย) */
export function ConfirmPanel({ title, explain, children, ready, busy, error, confirm = th.tax.confirm, onConfirm, onCancel }: {
  title: string; explain: string; children?: ReactNode; ready: boolean; busy: boolean; error: string | null;
  confirm?: string; onConfirm: () => void; onCancel: () => void;
}) {
  return (
    <section aria-label={title} className="@container flex w-full flex-col gap-3 border border-ink bg-paper p-4 print:hidden">
      <h3 className="font-doc text-[17px] font-bold">{title}</h3>
      <p className="text-sm">{explain}</p>
      {children}
      {error && <p role="alert" className="neg text-sm">{error}</p>}
      <div className="flex gap-3 max-sm:grid max-sm:grid-cols-2">
        <Button type="button" disabled={busy || !ready} onClick={onConfirm}>{confirm}</Button>
        <Button type="button" variant="secondary" onClick={onCancel}>{th.tax.cancel}</Button>
      </div>
    </section>
  );
}

const field = 'h-11 w-full border-b border-rule-input bg-transparent text-base';

/** ช่องวันที่ วว/ดด/ปปปป (พ.ศ.) */
export function DateInput({ label, value, onChange, invalid }: { label: string; value: string; onChange: (v: string) => void; invalid: boolean }) {
  return (
    <label className="flex min-w-0 flex-col text-sm">
      {label}
      <input className={`${field} font-num`} inputMode="numeric" value={value} onChange={(e) => onChange(maskDate(e.target.value))} aria-invalid={invalid} />
    </label>
  );
}

export function AccountSelect({ label, value, onChange, accounts, none }: {
  label: string; value: string; onChange: (v: string) => void; accounts: { code: string; name: string }[]; none?: string;
}) {
  return (
    <label className="flex min-w-0 flex-col text-sm">
      {label}
      <select className={field} value={value} onChange={(e) => onChange(e.target.value)}>
        {none !== undefined && <option value="">{none}</option>}
        {accounts.map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}
      </select>
    </label>
  );
}

export function PlainInput({ label, value, onChange, invalid, inputMode, mono, maxLength }: {
  label: string; value: string; onChange: (v: string) => void; invalid?: boolean; inputMode?: 'decimal' | 'numeric' | 'text'; mono?: boolean; maxLength?: number;
}) {
  return (
    <label className="flex min-w-0 flex-col text-sm">
      {label}
      <input className={`${field} ${mono ? 'font-num' : ''} ${inputMode === 'decimal' ? 'num' : ''}`} inputMode={inputMode} value={value}
        maxLength={maxLength} onChange={(e) => onChange(e.target.value)} aria-invalid={invalid ?? false} />
    </label>
  );
}
