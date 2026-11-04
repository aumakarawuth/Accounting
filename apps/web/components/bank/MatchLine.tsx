'use client';
import { useState } from 'react';
import { postJson, type ApiError } from '@/lib/api';
import { th } from '@/i18n/th';

const t = th.bankRec;

export function MatchLine({ companyId, lineId, amount, entries }: { companyId: string; lineId: string; amount: string; entries: { id: string; docNo: string; amount: string }[] }) {
  const [error, setError] = useState('');
  const candidates = entries.filter((e) => Number(e.amount) === Number(amount));
  if (candidates.length === 0) return <span className="text-sm text-ink2">{t.noCandidates}</span>;
  async function match(form: FormData) {
    const entryId = String(form.get('entryId'));
    if (!entryId) return;
    try {
      await postJson(`/companies/${companyId}/bank-reconciliation/matches`, { statementLineId: lineId, entryId, amount });
      location.reload();
    } catch (e) {
      setError((e as ApiError).message || t.matchFailed);
    }
  }
  return (
    <form action={match} className="flex flex-wrap items-center gap-2">
      <select name="entryId" defaultValue="" aria-label={t.chooseEntry} className="h-11 rounded-doc border border-rule-input bg-paper px-2 text-sm">
        <option value="">{t.chooseEntry}</option>
        {candidates.map((e) => <option key={e.id} value={e.id}>{e.docNo}</option>)}
      </select>
      <button className="min-h-11 rounded-doc border border-ink px-3 text-sm">{t.match}</button>
      {error && <p role="alert" className="neg basis-full text-sm">{error}</p>}
    </form>
  );
}
