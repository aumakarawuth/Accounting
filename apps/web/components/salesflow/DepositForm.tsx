'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/Button';
import { DateInput, PlainInput } from '@/components/ConfirmPanel';
import { api, postJson, type ApiError, type SalesFormData, type SalesOrderRow } from '@/lib/api';
import { isoToThai, thaiToIso, todayIso } from '@/lib/date';
import { formatMoney, fromCents, toCents } from '@/lib/money';
import { vatCalc } from '@/lib/vat';
import { th } from '@/i18n/th';

const field = 'h-11 w-full border-b border-rule-input bg-transparent text-base';

// รับเงินมัดจำ (DP): ภาษีขายถึงกำหนดตอนรับเงิน ยอดคิดสูตรเดียวกับ DB (lib/vat.ts) DB ตรวจซ้ำตอนผ่านรายการ
export function DepositForm({ companyId, form, order }: { companyId: string; form: SalesFormData; order: SalesOrderRow | null }) {
  const router = useRouter();
  const t = th.deposits;
  const co = form.company;
  const [partyCode, setPartyCode] = useState(order?.partyCode ?? '');
  const [orders, setOrders] = useState<SalesOrderRow[]>(order ? [order] : []);
  const [orderId, setOrderId] = useState(order?.id ?? '');
  const [date, setDate] = useState(isoToThai(todayIso()));
  const [amount, setAmount] = useState('');
  const [service, setService] = useState(order?.isService ?? false);
  const [mode, setMode] = useState<'exclusive' | 'inclusive'>(order?.priceMode === 'inclusive' ? 'inclusive' : 'exclusive');
  const [cash, setCash] = useState(form.cashAccounts[0]?.code ?? '1110');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [key] = useState(() => crypto.randomUUID());

  useEffect(() => {
    if (!partyCode || order) return;
    let live = true;
    api<SalesOrderRow[]>(`/companies/${companyId}/sales-orders?kind=sales_order&party=${encodeURIComponent(partyCode)}`).then(
      (rows) => { if (live) setOrders(rows.filter((r) => r.status === 'open' || r.status === 'partial')); }, () => {});
    return () => { live = false; };
  }, [companyId, partyCode, order]);

  const amt = toCents(amount);
  const calc = amt !== null && amt > 0n ? vatCalc(amt, 0n, co.vatRegistered ? co.vatRate : '0', co.vatRegistered ? mode : 'none') : null;
  const iso = thaiToIso(date);
  const ready = co.canWrite && !co.locked && partyCode && iso && calc && !busy;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const r = await postJson<{ id: string; docNo: string }>(`/companies/${companyId}/sales/deposit`, {
        date: iso, partyCode, amount: fromCents(amt!), isService: service, cashAccount: cash,
        ...(co.vatRegistered ? { priceMode: mode } : {}), ...(orderId ? { orderId } : {}),
      }, { 'idempotency-key': key });
      router.push(`/c/${companyId}/sales/documents/${r.id}`);
    } catch (e) {
      const err = e as ApiError;
      setError(err.code === 'server' ? th.error.server(err.ref ?? '-') : err.message);
      setBusy(false);
    }
  }

  return (
    <form className="flex max-w-xl flex-col gap-4" onSubmit={(e) => { e.preventDefault(); if (ready) void save(); }}>
      <label className="flex flex-col text-sm">
        {th.sales.customer}
        <select className={field} value={partyCode} disabled={Boolean(order)} onChange={(e) => { setPartyCode(e.target.value); setOrderId(''); }}>
          <option value="">-</option>
          {form.customers.map((c) => <option key={c.code} value={c.code}>{c.code} {c.name}</option>)}
        </select>
      </label>
      <label className="flex flex-col text-sm">
        {t.order}
        <select className={field} value={orderId} disabled={Boolean(order)} onChange={(e) => setOrderId(e.target.value)}>
          <option value="">{t.orderNone}</option>
          {orders.map((o) => <option key={o.id} value={o.id}>{o.docNo} · {formatMoney(o.total)}</option>)}
        </select>
      </label>
      <DateInput label={th.sales.date} value={date} onChange={setDate} invalid={!iso} />
      <fieldset className="flex flex-wrap items-center gap-x-5 text-sm">
        <legend className="sr-only">{th.sales.kind}</legend>
        <span aria-hidden>{th.sales.kind}</span>
        {([[false, th.sales.goods], [true, th.sales.service]] as const).map(([v, label]) => (
          <label key={label} className="flex min-h-11 items-center gap-2 text-base">
            <input type="radio" name="svc" className="size-5 accent-ink" checked={service === v} onChange={() => setService(v)} />{label}
          </label>
        ))}
      </fieldset>
      <PlainInput label={t.amount} value={amount} onChange={setAmount} inputMode="decimal" invalid={amount !== '' && (amt === null || amt <= 0n)} />
      {co.vatRegistered && (
        <fieldset className="flex flex-col text-sm">
          <legend>{th.sales.priceMode}</legend>
          {(['exclusive', 'inclusive'] as const).map((m) => (
            <label key={m} className="flex min-h-11 items-center gap-2 text-base">
              <input type="radio" name="mode" className="size-5 accent-ink" checked={mode === m} onChange={() => setMode(m)} />{th.sales[m]}
            </label>
          ))}
        </fieldset>
      )}
      <label className="flex flex-col text-sm">
        {th.sales.cashAccount}
        <select className={field} value={cash} onChange={(e) => setCash(e.target.value)}>
          {form.cashAccounts.map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}
        </select>
      </label>
      {calc && (
        <dl className="grid grid-cols-[minmax(0,1fr)_auto] text-[15px]">
          {co.vatRegistered && <><dt className="py-1">{th.sales.base}</dt><dd className="num py-1">{formatMoney(fromCents(calc.base))}</dd>
            <dt className="py-1">{th.sales.vat(String(Number(co.vatRate)))}</dt><dd className="num py-1">{formatMoney(fromCents(calc.vat))}</dd></>}
          <dt className="border-t border-ink py-1 font-semibold">{th.sales.total}</dt>
          <dd className="num border-t border-ink py-1 font-semibold">{formatMoney(fromCents(calc.total))}</dd>
        </dl>
      )}
      {error && <p role="alert" className="neg text-[15px]">{error}</p>}
      <Button type="submit" disabled={!ready} className="self-start max-sm:w-full">{t.save}</Button>
    </form>
  );
}
