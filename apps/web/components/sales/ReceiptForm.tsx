'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/Button';
import { api, postJson, type ApiError, type SalesFormData, type SalesRow } from '@/lib/api';
import { formatMoney, fromCents, toCents } from '@/lib/money';
import { isoToThai, thaiToIso, todayIso } from '@/lib/date';
import { rateHundredths } from '@/lib/vat';
import { th } from '@/i18n/th';

// รับชำระ: เลือกลูกค้า → ใบที่ค้าง (ขายเชื่อ/เพิ่มหนี้) ใส่ยอดรับแต่ละใบ → ภาษีที่ลูกค้าหัก ณ ที่จ่าย → บัญชีรับเงิน
// ภาษีหัก ณ ที่จ่ายคิดจากมูลค่าก่อน VAT ของส่วนที่รับ (ระบบเสนอ ผู้เรียนแก้ได้ตามหนังสือรับรองที่ได้จริง)
const WHT_RATES = ['1', '2', '3', '5'];
const divRound = (a: bigint, b: bigint) => (2n * a + b) / (2n * b);
const money = (c: bigint) => formatMoney(fromCents(c));

export function ReceiptForm({ companyId, form, initialParty, initialDoc }: {
  companyId: string; form: SalesFormData; initialParty?: string; initialDoc?: string;
}) {
  const router = useRouter();
  const co = form.company;
  const writable = co.canWrite && !co.locked;
  const [partyCode, setPartyCode] = useState(form.customers.some((c) => c.code === initialParty) ? initialParty! : '');
  const [partyQ, setPartyQ] = useState('');
  const [open, setOpen] = useState<SalesRow[] | null>(null);
  const [amounts, setAmounts] = useState<Record<string, string>>({}); // documentId → ยอดรับ (ไม่มี key = ไม่เลือก)
  const [date, setDate] = useState(isoToThai(todayIso()));
  const [cashAccount, setCashAccount] = useState(form.cashAccounts[0]?.code ?? '1110');
  const [whtRate, setWhtRate] = useState(''); // '' = ไม่หัก
  const [whtAmount, setWhtAmount] = useState<string | null>(null); // null = ตามที่ระบบเสนอ
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idem = useRef(crypto.randomUUID());
  const party = form.customers.find((c) => c.code === partyCode) ?? null;

  // ใบค้างของลูกค้าที่เลือก (เก่าสุดก่อน) — ใบที่ส่งมาจากหน้าเอกสารเลือกไว้ให้เต็มยอด
  useEffect(() => {
    if (!partyCode) return;
    let alive = true;
    void api<SalesRow[]>(`/companies/${companyId}/sales?party=${encodeURIComponent(partyCode)}`).then((rows) => {
      if (!alive) return;
      const items = rows.filter((r) => r.open !== null && Number(r.open) > 0).reverse();
      setOpen(items);
      const pre = items.find((r) => r.id === initialDoc);
      setAmounts(pre ? { [pre.id]: pre.open! } : {});
    }, (e: ApiError) => alive && setError(e.message));
    return () => { alive = false; };
  }, [companyId, partyCode, initialDoc]);

  const partyMatches = useMemo(() => {
    const s = partyQ.trim().toUpperCase();
    return (s ? form.customers.filter((c) => c.code.startsWith(s) || c.name.toUpperCase().includes(s)) : form.customers).slice(0, 8);
  }, [form.customers, partyQ]);

  const calc = useMemo(() => {
    let total = 0n, base = 0n, bad: string | null = null;
    for (const r of open ?? []) {
      if (!(r.id in amounts)) continue;
      const a = toCents(amounts[r.id]!);
      const max = toCents(r.open!)!;
      if (a === null || a <= 0n || a > max) { bad ??= th.sales.receiveInvalid(r.docNo); continue; }
      total += a;
      base += divRound(a * toCents(r.base)!, toCents(r.total)!); // ส่วนของมูลค่าก่อน VAT ในยอดที่รับ
    }
    const suggested = whtRate ? divRound(base * rateHundredths(whtRate), 10000n) : 0n;
    const wht = whtAmount === null ? suggested : toCents(whtAmount);
    return { total, base, bad, suggested, wht };
  }, [open, amounts, whtRate, whtAmount]);

  const isoDate = thaiToIso(date);
  const whtBad = calc.wht === null || (calc.wht > 0n && calc.wht >= calc.total);
  const blocked = !party ? th.sales.customerRequired
    : calc.bad ?? (calc.total === 0n ? th.sales.selectOne : isoDate === null ? th.sales.dateInvalid : whtBad ? th.sales.whtInvalid : null);
  const canPost = writable && !busy && !blocked;

  const submit = useCallback(async () => {
    if (!canPost || !isoDate || !open) return;
    if (!navigator.onLine) { setError(th.error.offline); return; }
    setBusy(true);
    setError(null);
    try {
      const r = await postJson<{ id: string }>(`/companies/${companyId}/receipts`, {
        date: isoDate, partyCode, cashAccount,
        ...(calc.wht! > 0n ? { whtAmount: fromCents(calc.wht!) } : {}),
        allocations: open.filter((x) => x.id in amounts).map((x) => ({ documentId: x.id, amount: fromCents(toCents(amounts[x.id]!)!) })),
      }, { 'idempotency-key': idem.current });
      router.push(`/c/${companyId}/sales/documents/${r.id}`);
    } catch (e) {
      const err = e as ApiError;
      setError(err.code === 'server' ? th.error.server(err.ref ?? '-') : err.message);
      setBusy(false);
    }
  }, [canPost, isoDate, open, companyId, partyCode, cashAccount, calc.wht, amounts, router]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'F9') { e.preventDefault(); void submit(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [submit]);

  const inputCls = 'h-11 w-full border-b border-rule-input bg-transparent px-0.5 text-base';
  const h2 = 'border-b border-rule-strong pb-1.5 font-doc text-[17px] font-bold';

  return (
    <form className="flex min-h-full flex-col" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      {co.locked && <p role="status" className="mx-3 mt-3 border border-rule-strong bg-band px-4 py-2.5 sm:mx-5">{th.submission.lockedNote}</p>}
      {!co.canWrite && <p className="mx-3 mt-3 text-sm text-ink2 sm:mx-5">{th.sales.readOnly}</p>}
      <div className="flex max-w-3xl flex-col gap-5 p-3 sm:p-5">
        <h1 className="border-b-2 border-ink pb-2.5 font-doc text-[19px] font-bold sm:text-2xl">{th.sales.receiptTitle}</h1>

        <section className="flex flex-col gap-4" aria-label={th.sales.customer}>
          <h2 className={h2}>{th.sales.customer}</h2>
          {party ? (
            <div className="flex items-start justify-between gap-3 border border-rule-input px-3 py-2">
              <div><span className="font-num">{party.code}</span> {party.name}</div>
              <button type="button" className="min-h-11 shrink-0 text-sm underline" onClick={() => { setPartyCode(''); setOpen(null); setAmounts({}); }}>{th.sales.change}</button>
            </div>
          ) : (
            <div className="flex flex-col">
              <label className="flex flex-col text-sm">
                {th.sales.customer}
                <input className={inputCls} value={partyQ} placeholder={th.sales.customerSearch} onChange={(e) => setPartyQ(e.target.value)} />
              </label>
              {form.customers.length === 0 && <p className="pt-2 text-sm text-ink2">{th.sales.customerNone}</p>}
              <ul>
                {partyMatches.map((c) => (
                  <li key={c.code}>
                    <button type="button" className="flex min-h-12 w-full items-center gap-3 border-b border-rule px-1 text-left" onClick={() => { setOpen(null); setPartyCode(c.code); }}>
                      <span className="font-num">{c.code}</span><span className="min-w-0 flex-1 truncate">{c.name}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

        {party && (
          <section className="flex flex-col gap-3" aria-label={th.sales.openItems}>
            <h2 className={h2}>{th.sales.openItems}</h2>
            {open === null ? <p className="text-ink2">…</p> : open.length === 0 ? <p className="text-ink2">{th.sales.noOpenItems}</p> : (
              <ul className="flex flex-col border-t border-rule">
                {open.map((r) => {
                  const on = r.id in amounts;
                  return (
                    <li key={r.id} className="grid grid-cols-[auto_minmax(0,1fr)_minmax(0,9rem)] items-center gap-x-3 border-b border-rule py-2">
                      <input type="checkbox" className="size-5 accent-ink" checked={on} aria-label={`${th.sales.receiveAmount} ${r.docNo}`}
                        onChange={(e) => setAmounts((a) => {
                          const { [r.id]: _, ...rest } = a;
                          return e.target.checked ? { ...a, [r.id]: r.open! } : rest;
                        })} />
                      <div className="min-w-0">
                        <div><span className="font-num">{r.docNo}</span> <span className="text-sm text-ink2">{isoToThai(r.date)}</span></div>
                        <div className="text-sm text-ink2">{th.sales.open} <span className="num">{formatMoney(r.open!)}</span>{r.dueDate ? ` · ${th.sales.dueDate} ${isoToThai(r.dueDate)}` : ''}</div>
                      </div>
                      <input inputMode="decimal" aria-label={`${th.sales.receiveAmount} ${r.docNo}`} disabled={!on}
                        className={`${inputCls} num disabled:text-ink2`} value={on ? amounts[r.id] : ''}
                        onChange={(e) => setAmounts((a) => ({ ...a, [r.id]: e.target.value }))} />
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        )}

        <section className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col text-sm">
              {th.sales.date}
              <input className={`${inputCls} font-num`} inputMode="numeric" value={date} onChange={(e) => setDate(e.target.value)} aria-invalid={isoDate === null} />
            </label>
            <label className="flex flex-col text-sm">
              {th.sales.cashAccount}
              <select className={inputCls} value={cashAccount} onChange={(e) => setCashAccount(e.target.value)}>
                {form.cashAccounts.map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}
              </select>
            </label>
            <label className="flex flex-col text-sm">
              {th.sales.whtRate}
              <select className={inputCls} value={whtRate} onChange={(e) => { setWhtRate(e.target.value); setWhtAmount(null); }}>
                <option value="">{th.sales.whtNone}</option>
                {WHT_RATES.map((r) => <option key={r} value={r}>{r}%</option>)}
              </select>
            </label>
            <div className="flex flex-col text-sm">
              <label htmlFor="wht-amount">{th.sales.whtByCustomer}</label>
              <input id="wht-amount" inputMode="decimal" className={`${inputCls} num`} aria-invalid={whtBad} aria-describedby="wht-note"
                value={whtAmount ?? (calc.suggested > 0n ? fromCents(calc.suggested) : '')} onChange={(e) => setWhtAmount(e.target.value)} />
              <span id="wht-note" className="pt-1 text-[13px] text-ink2">{whtRate ? th.sales.whtSuggest(money(calc.base)) : ''}</span>
            </div>
          </div>
          <dl className="grid grid-cols-[minmax(0,1fr)_auto] text-[15px]">
            <dt className="py-1">{th.sales.receiptTotal}</dt><dd className="num py-1">{money(calc.total)}</dd>
            <dt className="py-1">{th.sales.whtByCustomer}</dt><dd className="num py-1">{money(calc.wht ?? 0n)}</dd>
            <dt className="border-t border-ink py-1 font-semibold">{th.sales.netReceived}</dt>
            <dd className="num border-t border-ink py-1 font-semibold">{money(calc.total - (calc.wht ?? 0n))}</dd>
          </dl>
        </section>
      </div>

      <footer className="sticky bottom-0 mt-auto flex flex-col gap-2.5 border-t border-rule-strong bg-paper px-4 py-2.5 sm:flex-row sm:items-center sm:gap-6 sm:px-6">
        <p role="alert" className={`text-sm ${error ? 'neg' : 'text-ink2'}`}>{error ?? (busy ? th.sales.posting : blocked)}</p>
        <Button type="submit" shortcut="F9" disabled={!canPost} className="max-sm:w-full sm:ml-auto">{th.sales.post}</Button>
      </footer>
    </form>
  );
}
