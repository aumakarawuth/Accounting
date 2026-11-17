'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/Button';
import { DateInput } from '@/components/ConfirmPanel';
import { api, postJson, type ApiError, type Receivables, type SalesFormData } from '@/lib/api';
import { isoToThai, thaiToIso, todayIso } from '@/lib/date';
import { formatMoney, fromCents, toCents } from '@/lib/money';
import { th } from '@/i18n/th';

const field = 'h-11 w-full border-b border-rule-input bg-transparent text-base';
type Item = Receivables['items'][number];

// ออกใบวางบิล: เลือกลูกค้า → ใบที่ค้าง (เลือกทุกใบเป็นค่าเริ่มต้น) → บันทึก ยอดตามยอดค้าง ณ วันวางบิล (DB คิดซ้ำ)
export function BillingNoteForm({ companyId, form }: { companyId: string; form: SalesFormData }) {
  const router = useRouter();
  const t = th.billing;
  const [partyCode, setPartyCode] = useState('');
  const [items, setItems] = useState<Item[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [date, setDate] = useState(isoToThai(todayIso()));
  const [due, setDue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [key] = useState(() => crypto.randomUUID());

  useEffect(() => {
    if (!partyCode) return;
    let live = true;
    api<Receivables>(`/companies/${companyId}/receivables`).then((r) => {
      if (!live) return;
      const mine = r.items.filter((x) => x.partyCode === partyCode);
      setItems(mine);
      setPicked(new Set(mine.map((x) => x.id)));
    }, () => {});
    return () => { live = false; };
  }, [companyId, partyCode]);

  const iso = thaiToIso(date);
  const dueIso = due.trim() ? thaiToIso(due) : null;
  const total = items.filter((x) => picked.has(x.id)).reduce((a, x) => a + (toCents(x.open) ?? 0n), 0n);
  const ready = form.company.canWrite && !form.company.locked && partyCode && iso && picked.size > 0 && (!due.trim() || dueIso) && !busy;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const r = await postJson<{ id: string }>(`/companies/${companyId}/billing-notes`, {
        date: iso, partyCode, ...(dueIso ? { dueDate: dueIso } : {}), documentIds: [...picked],
      }, { 'idempotency-key': key });
      router.push(`/c/${companyId}/sales/billing/${r.id}`);
    } catch (e) {
      const err = e as ApiError;
      setError(err.code === 'server' ? th.error.server(err.ref ?? '-') : err.message);
      setBusy(false);
    }
  }

  const toggle = (id: string) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  return (
    <form className="flex max-w-2xl flex-col gap-4" onSubmit={(e) => { e.preventDefault(); if (ready) void save(); }}>
      <label className="flex flex-col text-sm">
        {t.customer}
        <select className={field} value={partyCode} onChange={(e) => { setPartyCode(e.target.value); setItems([]); setPicked(new Set()); }}>
          <option value="">-</option>
          {form.customers.map((c) => <option key={c.code} value={c.code}>{c.code} {c.name}</option>)}
        </select>
      </label>
      <div className="grid gap-4 sm:grid-cols-2">
        <DateInput label={th.sales.date} value={date} onChange={setDate} invalid={!iso} />
        <DateInput label={t.dueDate} value={due} onChange={setDue} invalid={due.trim() !== '' && !dueIso} />
      </div>
      {partyCode && (
        <fieldset className="flex flex-col gap-1">
          <legend className="font-medium">{t.pick}</legend>
          {items.length === 0 ? <p className="text-ink2">{t.noOpen}</p> : items.map((x) => (
            <label key={x.id} className="grid min-h-11 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-b border-rule text-base">
              <input type="checkbox" className="size-5 accent-ink" checked={picked.has(x.id)} onChange={() => toggle(x.id)} />
              <span><span className="font-num">{x.docNo}</span> <span className="text-sm text-ink2">{t.due} {isoToThai(x.dueDate)}</span></span>
              <span className="num">{formatMoney(x.open)}</span>
            </label>
          ))}
          <p className="flex justify-between pt-2 font-semibold"><span>{t.total}</span><span className="num">{formatMoney(fromCents(total))}</span></p>
        </fieldset>
      )}
      {error && <p role="alert" className="neg text-[15px]">{error}</p>}
      <Button type="submit" disabled={!ready} className="self-start max-sm:w-full">{t.save}</Button>
    </form>
  );
}
