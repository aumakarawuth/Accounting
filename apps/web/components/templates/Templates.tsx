'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/Button';
import { Money } from '@/components/Money';
import { CheckField, TextField } from '@/components/Fields';
import { ConfirmPanel, DateInput, errText, useAction } from '@/components/ConfirmPanel';
import { api, type TemplateLine, type TemplateRow, type TemplatesPage } from '@/lib/api';
import { isoToThai, maskDate, monthLabel, thaiToIso } from '@/lib/date';
import { formatMoney, fromCents, toCents } from '@/lib/money';
import { th } from '@/i18n/th';

const t = th.templates;
const lastDay = (month: string) => { const [y, m] = month.split('-').map(Number) as [number, number]; return new Date(y, m, 0).getDate(); };
const dueIn = (row: TemplateRow, month: string) => `${month}-${String(Math.min(row.dayOfMonth ?? 1, lastDay(month))).padStart(2, '0')}`;

export function Templates({ companyId, data }: { companyId: string; data: TemplatesPage }) {
  const writable = data.canWrite && !data.locked;
  const [open, setOpen] = useState<{ id: string; kind: 'post' | 'edit' } | null>(null);
  const name = (code: string) => data.accounts.find((a) => a.code === code)?.name ?? '';
  const due = data.due.map((d) => data.templates.find((x) => x.id === d.id)!).filter(Boolean);
  const row = (x: TemplateRow, inDue: boolean) => (
    <li key={`${inDue ? 'due' : 'all'}-${x.id}`} aria-label={x.name} className={`flex flex-col gap-1 border-b border-rule px-4 py-3 ${x.active ? '' : 'text-ink2'}`}>
      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3">
        <span className="font-medium">{x.name}</span>
        <Money value={fromCents(x.lines.reduce((s, l) => s + (toCents(l.debit) ?? 0n), 0n))} />
        <span className="text-[13px] text-ink2">
          {x.description} · {x.recurring ? `${t.recurring(x.dayOfMonth!)} ${t.since(monthLabel(x.startMonth!))}` : t.oneOff}
          {!x.active ? ` · ${t.inactive}` : ''}{inDue ? ` · ${t.dueOn(isoToThai(dueIn(x, data.month)))}` : ''}
        </span>
      </div>
      <span className="text-[13px]">
        {x.lines.map((l) => `${l.debit !== '0.00' ? 'Dr' : 'Cr'} ${l.account_code} ${name(l.account_code)}`).join(' · ')}
      </span>
      {!inDue && <span className="text-[13px] text-ink2">{t.uses(x.uses)}{x.postedThisMonth ? ` · ${t.postedThisMonth(x.postedThisMonth)}` : ''}</span>}
      {writable && x.active && (
        <div className="flex flex-wrap gap-2">
          {(!x.recurring || !x.postedThisMonth) && <Button type="button" className="min-h-11 px-3 text-sm" onClick={() => setOpen({ id: `${inDue}-${x.id}`, kind: 'post' })}>{t.post}</Button>}
          {!inDue && <Button type="button" variant="secondary" className="min-h-11 px-3 text-sm" onClick={() => setOpen({ id: `${inDue}-${x.id}`, kind: 'edit' })}>{t.edit}</Button>}
        </div>
      )}
      {open?.id === `${inDue}-${x.id}` && open.kind === 'post' && <PostPanel companyId={companyId} row={x} month={data.month} accountName={name} onDone={() => setOpen(null)} />}
      {open?.id === `${inDue}-${x.id}` && open.kind === 'edit' && <EditForm companyId={companyId} row={x} month={data.month} onDone={() => setOpen(null)} />}
    </li>
  );
  return (
    <div className="flex flex-col gap-6">
      {!data.canWrite && <p className="text-sm text-ink2">{th.cheques.readOnly}</p>}
      {data.locked && <p role="status" className="border border-rule-strong bg-band px-4 py-2.5">{th.submission.lockedNote}</p>}
      <section aria-label={t.due(monthLabel(data.month))} className="flex flex-col gap-2">
        <h2 className="text-[17px] font-semibold">{t.due(monthLabel(data.month))}</h2>
        {due.length === 0 ? <p className="text-ink2">{t.noDue}</p> : <ul className="border-t border-rule-strong bg-paper">{due.map((x) => row(x, true))}</ul>}
      </section>
      <section aria-label={t.all} className="flex flex-col gap-2">
        <h2 className="text-[17px] font-semibold">{t.all}</h2>
        {data.templates.length === 0 ? <p className="text-ink2">{t.empty}</p> : <ul className="border-t border-rule-strong bg-paper">{data.templates.map((x) => row(x, false))}</ul>}
      </section>
    </div>
  );
}

function PostPanel({ companyId, row, month, accountName, onDone }: {
  companyId: string; row: TemplateRow; month: string; accountName: (code: string) => string; onDone: () => void;
}) {
  const [date, setDate] = useState(isoToThai(row.recurring ? dueIn(row, month) : `${month}-01`));
  const [lines, setLines] = useState<TemplateLine[]>(row.lines);
  const [done, setDone] = useState<string | null>(null);
  const a = useAction();
  const iso = thaiToIso(date);
  const d = lines.reduce((s, l) => s + (toCents(l.debit) ?? 0n), 0n), c = lines.reduce((s, l) => s + (toCents(l.credit) ?? 0n), 0n);
  const valid = iso !== null && d === c && d > 0n && lines.every((l) => toCents(l.debit) !== null && toCents(l.credit) !== null);
  return (
    <ConfirmPanel title={t.postTitle(row.name)} explain={t.postExplain} ready={valid && !done} busy={a.busy} error={a.error} confirm={t.post} onCancel={onDone}
      onConfirm={async () => {
        const r = await a.run<{ docNo: string }>(`/companies/${companyId}/templates/${row.id}/post`, {
          date: iso, ...(row.recurring ? { month } : {}),
          lines: lines.map((l) => ({ account_code: l.account_code, ...(toCents(l.debit)! > 0n ? { debit: fromCents(toCents(l.debit)!) } : { credit: fromCents(toCents(l.credit)!) }), ...(l.memo ? { memo: l.memo } : {}) })),
        });
        if (r) setDone(t.posted(r.docNo));
      }}>
      <DateInput label={t.date} value={date} onChange={(v) => setDate(maskDate(v))} invalid={iso === null} />
      <ul className="flex flex-col gap-2">
        {lines.map((l, i) => {
          const side = l.debit !== '0.00' ? 'debit' : 'credit';
          return (
            <li key={i} className="grid grid-cols-[minmax(0,1fr)_9rem] items-end gap-3">
              <span className={`text-sm ${side === 'credit' ? 'pl-6' : ''}`}><span className="font-num text-ink2">{l.account_code}</span> {accountName(l.account_code)}</span>
              <label className="flex flex-col text-sm">{side === 'debit' ? t.debit : t.credit}
                <input className="h-11 w-full border-b border-rule-input bg-transparent text-right font-num text-base" inputMode="decimal" value={l[side]}
                  onChange={(e) => setLines((xs) => xs.map((x, j) => (j === i ? { ...x, [side]: e.target.value } : x)))} />
              </label>
            </li>
          );
        })}
      </ul>
      <p className={`text-sm ${d === c ? '' : 'neg'}`}>{d === c ? t.diff(formatMoney(fromCents(d)), formatMoney(fromCents(c))) : t.unbalanced(formatMoney(fromCents(d > c ? d - c : c - d)))}</p>
      {done && <p role="status" className="text-[15px]">{done}</p>}
    </ConfirmPanel>
  );
}

function TemplateFields({ name, setName, description, setDescription, recurring, setRecurring, day, setDay, start, setStart }: {
  name: string; setName: (v: string) => void; description: string; setDescription: (v: string) => void; recurring: boolean; setRecurring: (v: boolean) => void;
  day: string; setDay: (v: string) => void; start: string; setStart: (v: string) => void;
}) {
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField label={t.name} value={name} onChange={setName} maxLength={120} />
        <TextField label={t.description} value={description} onChange={setDescription} maxLength={300} />
      </div>
      <CheckField label={t.recurringCheck} checked={recurring} onChange={setRecurring} />
      {recurring && (
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField label={t.dayOfMonth} value={day} onChange={(v) => setDay(v.replace(/\D/g, '').slice(0, 2))} inputMode="numeric" mono />
          <label className="flex min-w-0 flex-col text-sm">{t.startMonth}
            <input type="month" className="h-11 w-full border-b border-rule-input bg-transparent text-base" value={start} onChange={(e) => setStart(e.target.value)} />
          </label>
        </div>
      )}
    </>
  );
}

function EditForm({ companyId, row, month, onDone }: { companyId: string; row: TemplateRow; month: string; onDone: () => void }) {
  const router = useRouter();
  const [name, setName] = useState(row.name);
  const [description, setDescription] = useState(row.description);
  const [recurring, setRecurring] = useState(row.recurring);
  const [day, setDay] = useState(String(row.dayOfMonth ?? 1));
  const [start, setStart] = useState(row.startMonth ?? month);
  const [active, setActive] = useState(row.active);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <form aria-label={t.editTitle(row.name)} className="flex flex-col gap-3 border border-ink bg-paper p-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true); setErr(null);
        try {
          await api(`/companies/${companyId}/templates/${row.id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
            name: name.trim(), description: description.trim(), recurring, active, version: row.version,
            ...(recurring ? { dayOfMonth: Number(day), startMonth: start } : {}) }) });
          router.refresh();
          onDone();
        } catch (x) { setErr(errText(x)); } finally { setBusy(false); }
      }}>
      <h3 className="font-doc text-[17px] font-bold">{t.editTitle(row.name)}</h3>
      <TemplateFields {...{ name, setName, description, setDescription, recurring, setRecurring, day, setDay, start, setStart }} />
      <CheckField label={t.active} checked={active} onChange={setActive} />
      {err && <p role="alert" className="neg text-sm">{err}</p>}
      <div className="flex gap-3 max-sm:grid max-sm:grid-cols-2">
        <Button type="submit" disabled={busy || !name.trim()}>{t.save}</Button>
        <Button type="button" variant="secondary" onClick={onDone}>{t.cancel}</Button>
      </div>
    </form>
  );
}

/** หน้ารายการในสมุดรายวัน: บันทึกเป็นแม่แบบ (รายการประจำได้) */
export function SaveAsTemplate({ companyId, entryId, description: initialDesc, month }: { companyId: string; entryId: string; description: string; month: string }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(initialDesc.slice(0, 120));
  const [description, setDescription] = useState(initialDesc.slice(0, 300));
  const [recurring, setRecurring] = useState(false);
  const [day, setDay] = useState('1');
  const [start, setStart] = useState(month);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  if (!open) return <div><Button type="button" variant="secondary" onClick={() => setOpen(true)} className="max-sm:w-full">{t.saveAs}</Button></div>;
  return (
    <form aria-label={t.saveAs} className="flex flex-col gap-3 border border-rule-strong bg-paper p-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true); setMsg(null);
        try {
          await api(`/companies/${companyId}/templates`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
            name: name.trim(), description: description.trim() || undefined, fromEntry: entryId, recurring,
            ...(recurring ? { dayOfMonth: Number(day), startMonth: start } : {}) }) });
          setMsg({ ok: true, text: t.saved(name.trim()) });
        } catch (x) { setMsg({ ok: false, text: errText(x) }); } finally { setBusy(false); }
      }}>
      <h2 className="font-doc text-[17px] font-bold">{t.saveAs}</h2>
      <p className="text-sm text-ink2">{t.saveAsNote}</p>
      <TemplateFields {...{ name, setName, description, setDescription, recurring, setRecurring, day, setDay, start, setStart }} />
      {msg && <p role={msg.ok ? 'status' : 'alert'} className={msg.ok ? 'text-[15px]' : 'neg text-[15px]'}>{msg.text}{msg.ok && <> · <Link href={`/c/${companyId}/templates?month=${month}`} className="underline">{t.open}</Link></>}</p>}
      <div className="flex gap-3 max-sm:grid max-sm:grid-cols-2">
        <Button type="submit" disabled={busy || !name.trim() || msg?.ok === true}>{t.save}</Button>
        <Button type="button" variant="secondary" onClick={() => setOpen(false)}>{t.cancel}</Button>
      </div>
    </form>
  );
}
