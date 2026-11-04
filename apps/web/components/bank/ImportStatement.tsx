'use client';
import { useState } from 'react';
import { postJson, type ApiError } from '@/lib/api';
import { th } from '@/i18n/th';

const t = th.bankRec;
const input = 'h-11 w-full rounded-doc border border-rule-input bg-paper px-3 text-base';

export function ImportStatement({ companyId }: { companyId: string }) {
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(form: FormData) {
    setBusy(true);
    setMessage('');
    try {
      const lines = String(form.get('lines')).trim().split('\n').filter((r) => r.trim()).map((row) => {
        const [date = '', description = '', amount = '', reference = ''] = row.split(',');
        return { date: date.trim(), description: description.trim(), amount: amount.trim(), reference: reference.trim() };
      });
      await postJson(`/companies/${companyId}/bank-reconciliation/statements`, {
        accountCode: form.get('accountCode'), periodStart: form.get('periodStart'), periodEnd: form.get('periodEnd'),
        openingBalance: form.get('openingBalance'), closingBalance: form.get('closingBalance'), lines,
      });
      location.reload();
    } catch (e) {
      setMessage((e as ApiError).message || t.importFailed);
      setBusy(false);
    }
  }
  const field = (name: string, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <label className="flex flex-col gap-1 text-sm">{label}<input name={name} required className={input} {...props} /></label>
  );
  return (
    <details className="border border-rule-strong bg-paper">
      <summary className="flex min-h-12 cursor-pointer items-center px-4 font-semibold">{t.importTitle}</summary>
      <form action={submit} className="grid gap-3 p-4 sm:grid-cols-2">
        {field('accountCode', t.accountCode, { placeholder: t.accountHint, inputMode: 'numeric' })}
        <span className="max-sm:hidden" />
        {field('periodStart', t.periodStart, { type: 'date' })}
        {field('periodEnd', t.periodEnd, { type: 'date' })}
        {field('openingBalance', t.opening, { inputMode: 'decimal', className: `${input} font-num` })}
        {field('closingBalance', t.closing, { inputMode: 'decimal', className: `${input} font-num` })}
        <label className="flex flex-col gap-1 text-sm sm:col-span-2">{t.lines}
          <textarea name="lines" required rows={5} placeholder={t.linesHint} className="rounded-doc border border-rule-input bg-paper p-3 font-num text-base" />
        </label>
        <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
          <button disabled={busy} className="min-h-12 rounded-doc bg-ink px-5 font-medium text-paper disabled:bg-disabled disabled:text-ink2">{busy ? t.importing : t.import}</button>
          {message && <p role="alert" className="neg text-sm">{message}</p>}
        </div>
      </form>
    </details>
  );
}
