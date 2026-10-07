'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/Button';
import { postJson, type ApiError } from '@/lib/api';
import { th } from '@/i18n/th';

const CODE = /^[A-HJ-NP-Z2-9]{6}$/;
const clean = (s: string) => s.replace(/\s+/g, '').toUpperCase();

// นักเรียนเข้าห้องด้วยรหัส: มาจาก QR (รหัสเติมให้แล้ว กดปุ่มเดียว) หรือพิมพ์เอง
export function JoinRoom({ initial = '' }: { initial?: string }) {
  const router = useRouter();
  const [code, setCode] = useState(clean(initial));
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const valid = CODE.test(code);

  async function submit() {
    if (!valid || busy) return;
    setBusy(true);
    setResult(null);
    try {
      const r = await postJson<{ name: string; already: boolean }>('/classrooms/join', { code });
      setResult({ ok: true, text: r.already ? th.join.already(r.name) : th.join.joined(r.name) });
      router.refresh();
    } catch (e) {
      const err = e as ApiError;
      setResult({ ok: false, text: err.code === 'server' ? th.error.server(err.ref ?? '-') : err.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="flex w-full flex-col gap-4 px-5 py-6 sm:w-[420px] sm:border sm:border-rule-strong sm:bg-paper sm:px-8 sm:py-7"
      onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <div className="border-b-2 border-ink pb-2.5">
        <h1 className="font-doc text-[22px] font-bold">{th.join.title}</h1>
        <p className="text-sm text-ink2">{th.join.hint}</p>
      </div>
      <label className="flex flex-col gap-1 text-sm">
        {th.join.code}
        <input
          className={`h-13 w-full rounded-doc border bg-paper px-3 font-num text-[22px] tracking-[0.2em] uppercase ${code && !valid ? 'border-red' : 'border-rule-input'}`}
          autoCapitalize="characters" autoComplete="off" spellCheck={false} maxLength={8}
          value={code} onChange={(e) => setCode(clean(e.target.value))}
          aria-invalid={code !== '' && !valid} aria-describedby="join-hint"
        />
        <span id="join-hint" className={`text-[13px] ${code && !valid ? 'neg' : 'text-ink2'}`}>{code && !valid ? th.join.invalid : ''}</span>
      </label>
      {result && <p role={result.ok ? 'status' : 'alert'} className={result.ok ? 'font-medium' : 'neg'}>{result.text}</p>}
      {result?.ok ? (
        <>
          <p className="text-sm text-ink2">{th.join.nextStep}</p>
          <Link href="/" className="inline-flex min-h-13 items-center justify-center rounded-doc bg-ink font-medium text-paper">{th.join.home}</Link>
        </>
      ) : (
        <Button type="submit" disabled={!valid || busy}>{valid ? th.join.submitCode(code) : th.join.submit}</Button>
      )}
    </form>
  );
}
