'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Button } from '@/components/Button';
import { Money } from '@/components/Money';
import { SelectField, TextField } from '@/components/Fields';
import { ConfirmPanel, DateInput, PlainInput, useAction } from '@/components/ConfirmPanel';
import { postJson, type AllowancePreview, type ApiError, type BadDebtPage } from '@/lib/api';
import { isoToThai, maskDate, monthLabel, thaiToIso, todayIso } from '@/lib/date';
import { formatMoney, fromCents, isNegative, toCents } from '@/lib/money';
import { th } from '@/i18n/th';

const t = th.badDebts;
const errText = (e: unknown) => {
  const err = e as ApiError;
  return err.code === 'server' ? th.error.server(err.ref ?? '-') : err.message;
};
const BUCKETS = ['current', 'd30', 'd60', 'd90', 'over90'] as const;
const pct = /^\d{1,3}(\.\d{1,2})?$/;

/** ค่าเผื่อหนี้สงสัยจะสูญ ตัดหนี้สูญรายใบ หนี้สูญได้รับคืน (docs/phase6-spec.md ข้อ 4) */
export function BadDebts({ companyId, data, month }: { companyId: string; data: BadDebtPage; month: string }) {
  const writable = data.canWrite && !data.locked;
  return (
    <div className="flex flex-col gap-6">
      <section aria-label={t.summary} className="grid gap-3 border border-rule-strong bg-paper p-4 sm:grid-cols-3 sm:p-5">
        <Figure label={t.receivables(isoToThai(data.asOf))} value={data.receivables} />
        <Figure label={t.allowance} value={data.allowance} />
        <Figure label={t.subledger} value={data.subledger} />
        <p role="status" className={`text-sm sm:col-span-3 ${data.matches ? '' : 'neg font-semibold'}`}>
          {data.matches ? t.matches(formatMoney(data.subledger)) : t.mismatch(formatMoney(data.subledger), formatMoney(data.receivables))}
        </p>
      </section>
      {!data.canWrite && <p className="text-sm text-ink2">{th.cheques.readOnly}</p>}
      {data.locked && <p role="status" className="border border-rule-strong bg-band px-4 py-2.5">{th.submission.lockedNote}</p>}
      {writable && <AllowanceForm companyId={companyId} month={month} />}
      <AllowanceList companyId={companyId} data={data} writable={writable} />
      {writable && <WriteOffForm companyId={companyId} data={data} />}
      <WriteOffList companyId={companyId} data={data} writable={writable} />
    </div>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-[13px] text-ink2">{label}</span>
      <Money value={value} className="text-[18px] font-semibold" />
    </div>
  );
}

function AllowanceForm({ companyId, month }: { companyId: string; month: string }) {
  const [method, setMethod] = useState<'sales' | 'receivables' | 'aging'>('receivables');
  const [rate, setRate] = useState('');
  const [scope, setScope] = useState<'month' | 'ytd'>('month');
  const [rates, setRates] = useState<Record<string, string>>({ current: '1', d30: '2', d60: '5', d90: '10', over90: '50' });
  const [preview, setPreview] = useState<AllowancePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const a = useAction();
  const okMonth = /^\d{4}-(0[1-9]|1[0-2])$/.test(month);
  const valid = okMonth && (method === 'aging' ? BUCKETS.every((b) => pct.test(rates[b] ?? '')) : pct.test(rate));
  const body = { month, method, ...(method === 'aging' ? { rates } : { rate, ...(method === 'sales' ? { scope } : {}) }) };
  const [done, setDone] = useState<string | null>(null);
  const change = <T,>(f: (v: T) => void) => (v: T) => { f(v); setPreview(null); setDone(null); };

  async function show() {
    setError(null);
    if (!valid) { setError(t.invalid); return; }
    try { setPreview(await postJson<AllowancePreview>(`/companies/${companyId}/bad-debts/allowance/preview`, body)); }
    catch (e) { setError(errText(e)); }
  }
  const amt = preview ? toCents(preview.amount) ?? 0n : 0n;
  return (
    <form aria-label={t.allowanceForm} className="flex flex-col gap-4 border border-rule-strong bg-paper p-4 sm:p-6" onSubmit={(e) => { e.preventDefault(); void show(); }}>
      <h2 className="text-[17px] font-semibold">{t.allowanceForm} · {t.monthHint(monthLabel(month))}</h2>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <SelectField label={t.method} value={method} onChange={change((v: string) => setMethod(v as typeof method))}>
          {(['sales', 'receivables', 'aging'] as const).map((m) => <option key={m} value={m}>{t.methods[m]}</option>)}
        </SelectField>
        {method !== 'aging' && <TextField label={t.rate} value={rate} onChange={change(setRate)} inputMode="decimal" mono />}
        {method === 'sales' && (
          <SelectField label={t.scope} value={scope} onChange={change((v: string) => setScope(v as typeof scope))}>
            <option value="month">{th.statements.scopeMonth}</option>
            <option value="ytd">{th.statements.scopeYtd}</option>
          </SelectField>
        )}
      </div>
      {method === 'aging' && (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
          {BUCKETS.map((b) => (
            <TextField key={b} label={`${t.buckets[b]} (%)`} value={rates[b] ?? ''} onChange={change((v: string) => setRates((r) => ({ ...r, [b]: v })))} inputMode="decimal" mono />
          ))}
        </div>
      )}
      <p className="text-[13px] text-ink2">{t.methodNote[method]}</p>
      {error && <p role="alert" className="neg text-[15px]">{error}</p>}
      <div><Button type="submit" variant="secondary" className="max-sm:w-full">{t.showPreview}</Button></div>
      {preview && (
        <ConfirmPanel title={t.previewTitle} explain={amt === 0n ? t.nothing : t.entry(amt > 0n, formatMoney(fromCents(amt > 0n ? amt : -amt)))}
          ready={amt !== 0n} busy={a.busy} error={a.error} confirm={t.post}
          onCancel={() => setPreview(null)}
          onConfirm={async () => {
            const r = await a.run<{ docNo: string }>(`/companies/${companyId}/bad-debts/allowance`, body);
            if (r) { setPreview(null); setDone(t.posted(r.docNo)); }
          }}>
          <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 text-[15px]">
            {preview.buckets.length > 0 && preview.buckets.map((b) => (
              <div key={b.bucket} className="contents">
                <dt>{t.bucketLine(t.buckets[b.bucket] ?? b.bucket, b.count, formatMoney(b.open), b.rate)}</dt><dd className="text-right"><Money value={b.required} /></dd>
              </div>
            ))}
            <dt>{t.base[preview.method]}</dt><dd className="text-right"><Money value={preview.base} /></dd>
            <dt>{preview.method === 'sales' ? t.expense : t.required}</dt><dd className="text-right"><Money value={preview.required} /></dd>
            {preview.method !== 'sales' && <><dt>{t.previous}</dt><dd className="text-right"><Money value={preview.previous} /></dd></>}
            <dt className="font-semibold">{t.amount}</dt><dd className="text-right font-semibold"><Money value={preview.amount} /></dd>
          </dl>
        </ConfirmPanel>
      )}
      {done && <p role="status" className="text-[15px]">{done}</p>}
    </form>
  );
}

function AllowanceList({ companyId, data, writable }: { companyId: string; data: BadDebtPage; writable: boolean }) {
  const [voiding, setVoiding] = useState<string | null>(null);
  if (data.allowances.length === 0) return null;
  return (
    <section aria-label={t.allowanceList} className="flex flex-col gap-2">
      <h2 className="text-[17px] font-semibold">{t.allowanceList}</h2>
      <ul className="border-t border-rule-strong bg-paper">
        {data.allowances.map((x) => (
          <li key={x.id} className={`flex flex-col gap-1 border-b border-rule px-4 py-2.5 ${x.voided ? 'text-ink2' : ''}`}>
            <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3">
              <span><Link href={`/c/${companyId}/journal`} className="font-num underline decoration-rule-input">{x.docNo}</Link> · {t.methods[x.method]} · {x.month}</span>
              <Money value={x.amount} />
            </div>
            {x.voided && <span className="text-[13px]">{t.voided(x.voidDocNo ?? '')}</span>}
            {writable && !x.voided && <div><Button type="button" variant="secondary" className="min-h-11 px-3 text-sm" onClick={() => setVoiding(x.id)}>{t.void}</Button></div>}
            {voiding === x.id && <VoidPanel companyId={companyId} kind="allowance" id={x.id} docNo={x.docNo} onDone={() => setVoiding(null)} />}
          </li>
        ))}
      </ul>
    </section>
  );
}

function WriteOffForm({ companyId, data }: { companyId: string; data: BadDebtPage }) {
  const [doc, setDoc] = useState(data.open[0]?.id ?? '');
  const sel = data.open.find((o) => o.id === doc);
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(isoToThai(todayIso()));
  const [reason, setReason] = useState('');
  const a = useAction();
  const [done, setDone] = useState<string | null>(null);
  const iso = thaiToIso(date);
  const cents = toCents((amount || sel?.open || '').trim());
  if (data.open.length === 0) return <p className="text-ink2">{t.noOpen}</p>;
  return (
    <section aria-label={t.writeOffForm} className="flex flex-col gap-4 border border-rule-strong bg-paper p-4 sm:p-6">
      <h2 className="text-[17px] font-semibold">{t.writeOffForm}</h2>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <SelectField label={t.invoice} value={doc} onChange={(v) => { setDoc(v); setAmount(''); }}>
          {data.open.map((o) => <option key={o.id} value={o.id}>{o.docNo} {o.partyName} · {t.openLabel(formatMoney(o.open))}</option>)}
        </SelectField>
        <TextField label={t.writeOffAmount} value={amount} onChange={setAmount} inputMode="decimal" mono hint={sel ? t.openLabel(formatMoney(sel.open)) : undefined} />
        <TextField label={t.date} value={date} onChange={(v) => setDate(maskDate(v))} inputMode="numeric" mono />
        <TextField label={t.reason} value={reason} onChange={setReason} maxLength={300} />
      </div>
      <p className="text-sm">{t.writeOffEntry}</p>
      {a.error && <p role="alert" className="neg text-[15px]">{a.error}</p>}
      {done && <p role="status" className="text-[15px]">{done}</p>}
      <div>
        <Button type="button" disabled={a.busy || !sel || !iso || cents === null || cents <= 0n || !reason.trim()} className="max-sm:w-full"
          onClick={async () => {
            const r = await a.run<{ docNo: string }>(`/companies/${companyId}/bad-debts/writeoffs`, { documentId: doc, date: iso, amount: fromCents(cents!), reason: reason.trim() });
            if (r) { setDone(t.writtenOff(r.docNo)); setAmount(''); setReason(''); }
          }}>{t.writeOff}</Button>
      </div>
    </section>
  );
}

function WriteOffList({ companyId, data, writable }: { companyId: string; data: BadDebtPage; writable: boolean }) {
  const [open, setOpen] = useState<{ id: string; kind: 'recover' | 'writeoff' | 'recovery' } | null>(null);
  return (
    <section aria-label={t.writeOffList} className="flex flex-col gap-2">
      <h2 className="text-[17px] font-semibold">{t.writeOffList}</h2>
      {data.writeoffs.length === 0 ? <p className="text-ink2">{t.noWriteOffs}</p> : (
        <ul className="border-t border-rule-strong bg-paper">
          {data.writeoffs.map((w) => (
            <li key={w.id} className={`flex flex-col gap-1.5 border-b border-rule px-4 py-3 ${w.voided ? 'text-ink2' : ''}`}>
              <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3">
                <span><span className="font-num">{w.docNo}</span> · {w.invoiceNo} {w.partyName}</span>
                <Money value={w.amount} />
                <span className="text-[13px] text-ink2">{isoToThai(w.date)} · {w.reason}</span>
                {!w.voided && <span className="text-right text-[13px] text-ink2">{t.unrecovered(formatMoney(w.unrecovered))}</span>}
              </div>
              {w.voided && <span className="text-[13px]">{t.voided(w.voidDocNo ?? '')}</span>}
              {w.recoveries.map((r) => (
                <div key={r.id} className={`flex flex-wrap items-center gap-x-3 pl-4 text-[14px] ${r.voided ? 'text-ink2 line-through' : ''}`}>
                  <span>{t.recoveredLine(r.docNo, isoToThai(r.date), r.credit)}</span><Money value={r.amount} />
                  {writable && !r.voided && <Button type="button" variant="secondary" className="min-h-11 px-3 text-sm" onClick={() => setOpen({ id: r.id, kind: 'recovery' })}>{t.void}</Button>}
                  {open?.id === r.id && open.kind === 'recovery' && <VoidPanel companyId={companyId} kind="recovery" id={r.id} docNo={r.docNo} onDone={() => setOpen(null)} />}
                </div>
              ))}
              {writable && !w.voided && (
                <div className="flex flex-wrap gap-2">
                  {!isNegative(w.unrecovered) && w.unrecovered !== '0.00' && (
                    <Button type="button" variant="secondary" className="min-h-11 px-3 text-sm" onClick={() => setOpen({ id: w.id, kind: 'recover' })}>{t.recover}</Button>
                  )}
                  <Button type="button" variant="secondary" className="min-h-11 px-3 text-sm" onClick={() => setOpen({ id: w.id, kind: 'writeoff' })}>{t.void}</Button>
                </div>
              )}
              {open?.id === w.id && open.kind === 'recover' && <RecoverPanel companyId={companyId} w={w} onDone={() => setOpen(null)} />}
              {open?.id === w.id && open.kind === 'writeoff' && <VoidPanel companyId={companyId} kind="writeoff" id={w.id} docNo={w.docNo} onDone={() => setOpen(null)} />}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RecoverPanel({ companyId, w, onDone }: { companyId: string; w: BadDebtPage['writeoffs'][number]; onDone: () => void }) {
  const [amount, setAmount] = useState(w.unrecovered);
  const [date, setDate] = useState(isoToThai(todayIso() > w.date ? todayIso() : w.date));
  const [credit, setCredit] = useState<'1211' | '4340'>('1211');
  const a = useAction();
  const iso = thaiToIso(date);
  const cents = toCents(amount.trim());
  return (
    <ConfirmPanel title={t.recoverTitle(w.invoiceNo)} explain={t.recoverExplain(credit)} confirm={t.recover}
      ready={iso !== null && cents !== null && cents > 0n} busy={a.busy} error={a.error} onCancel={onDone}
      onConfirm={async () => {
        const r = await a.run(`/companies/${companyId}/bad-debts/recoveries`, { writeoffId: w.id, date: iso, amount: fromCents(cents!), credit });
        if (r) onDone();
      }}>
      <div className="grid gap-3 @md:grid-cols-3">
        <PlainInput label={t.recoverAmount} value={amount} onChange={setAmount} />
        <DateInput label={t.date} value={date} onChange={setDate} invalid={iso === null} />
        <SelectField label={t.creditAccount} value={credit} onChange={(v) => setCredit(v as '1211' | '4340')}>
          <option value="1211">{t.credit1211}</option>
          <option value="4340">{t.credit4340}</option>
        </SelectField>
      </div>
    </ConfirmPanel>
  );
}

function VoidPanel({ companyId, kind, id, docNo, onDone }: { companyId: string; kind: 'allowance' | 'writeoff' | 'recovery'; id: string; docNo: string; onDone: () => void }) {
  const [date, setDate] = useState(isoToThai(todayIso()));
  const [reason, setReason] = useState('');
  const a = useAction();
  const iso = thaiToIso(date);
  return (
    <ConfirmPanel title={t.voidTitle(docNo)} explain={t.voidExplain} ready={iso !== null && reason.trim() !== ''} busy={a.busy} error={a.error} onCancel={onDone}
      onConfirm={async () => {
        const r = await a.run(`/companies/${companyId}/bad-debts/${kind}/${id}/void`, { date: iso, reason: reason.trim() });
        if (r) onDone();
      }}>
      <div className="grid gap-3 @md:grid-cols-2">
        <DateInput label={t.voidDate} value={date} onChange={setDate} invalid={iso === null} />
        <PlainInput label={t.reason} value={reason} onChange={setReason} maxLength={300} />
      </div>
    </ConfirmPanel>
  );
}
