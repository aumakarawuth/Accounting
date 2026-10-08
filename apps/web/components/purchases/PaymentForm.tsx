'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/Button';
import { api, postJson, type ApiError, type PurchaseFormData, type PurchaseRow, type WhtKind } from '@/lib/api';
import { formatMoney, fromCents, toCents } from '@/lib/money';
import { isoToThai, thaiToIso, todayIso } from '@/lib/date';
import { rateHundredths } from '@/lib/vat';
import { whtFor, type EntryLine } from '@/lib/entry-preview';
import { EntryPreview, PartyPicker } from '@/components/docs/parts';
import { th } from '@/i18n/th';

// จ่ายชำระ: เลือกผู้ขาย → ใบซื้อเชื่อที่ค้าง ใส่ยอดจ่ายแต่ละใบ → หัก ณ ที่จ่าย (ระบบคิดจากมูลค่าก่อน VAT ของส่วนที่จ่าย) → บัญชีจ่ายเงิน
// ภาษีซื้อบริการที่ถึงกำหนดและยอดหักคิดบนจอด้วยสูตรเดียวกับ acc.post_payment (มีเทสต์เทียบ)
const RATE = /^\d{1,2}(\.\d{1,2})?$/;
const STANDARD: Record<string, string> = { transport: '1', advertising: '2', service: '3', professional: '3', rent: '5' };
const divRound = (a: bigint, b: bigint) => (2n * a + b) / (2n * b);
const money = (c: bigint) => formatMoney(fromCents(c));

export function PaymentForm({ companyId, form, initialParty, initialDoc }: {
  companyId: string; form: PurchaseFormData; initialParty?: string; initialDoc?: string;
}) {
  const router = useRouter();
  const co = form.company;
  const writable = co.canWrite && !co.locked;
  const names = useMemo(() => new Map([...form.cashAccounts, ...form.systemAccounts].map((a) => [a.code, a.name])), [form]);
  const [partyCode, setPartyCode] = useState(form.vendors.some((v) => v.code === initialParty) ? initialParty! : '');
  const [open, setOpen] = useState<(PurchaseRow & { undue: bigint })[] | null>(null);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [date, setDate] = useState(isoToThai(todayIso()));
  const [cashAccount, setCashAccount] = useState(form.cashAccounts[0]?.code ?? '1110');
  const [whtKind, setWhtKind] = useState<WhtKind | '' | null>(null); // null = ตามที่ตั้งไว้ที่ผู้ขาย
  const [whtRate, setWhtRate] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idem = useRef(crypto.randomUUID());
  const vendor = form.vendors.find((v) => v.code === partyCode) ?? null;

  // ใบค้างของผู้ขาย (เก่าสุดก่อน) พร้อมภาษีซื้อบริการที่ยังไม่ถึงกำหนด · ใบที่ส่งมาจากหน้าเอกสารเลือกไว้ให้เต็มยอด
  useEffect(() => {
    if (!partyCode) return;
    let alive = true;
    void api<PurchaseRow[]>(`/companies/${companyId}/purchases?party=${encodeURIComponent(partyCode)}&kind=purchase_invoice`).then((rows) => {
      if (!alive) return;
      const items = rows.filter((r) => r.open !== null && Number(r.open) > 0).reverse().map((r) => ({ ...r, undue: toCents(r.undueVat ?? '0') ?? 0n }));
      setOpen(items);
      const pre = items.find((r) => r.id === initialDoc);
      setAmounts(pre ? { [pre.id]: pre.open! } : {});
    }, (e: ApiError) => alive && setError(e.message));
    return () => { alive = false; };
  }, [companyId, partyCode, initialDoc]);

  const wKind = whtKind ?? vendor?.whtKind ?? '';
  const wRate = whtRate ?? (wKind && wKind === vendor?.whtKind && vendor.whtRate ? String(Number(vendor.whtRate)) : STANDARD[wKind] ?? '');
  const wRateOk = !wKind || (RATE.test(wRate) && Number(wRate) > 0 && Number(wRate) <= 15);

  const calc = useMemo(() => {
    let total = 0n, vat = 0n, bad: string | null = null;
    const parts: { amount: bigint; base: bigint; total: bigint }[] = [];
    for (const r of open ?? []) {
      if (!(r.id in amounts)) continue;
      const a = toCents(amounts[r.id]!);
      const max = toCents(r.open!)!;
      if (a === null || a <= 0n || a > max) { bad ??= th.purchases.payInvalid(r.docNo); continue; }
      total += a;
      if (r.undue > 0n) vat += a === max ? r.undue : divRound(a * r.undue, max);
      parts.push({ amount: a, base: toCents(r.base)!, total: toCents(r.total)! });
    }
    const wht = wKind && wRateOk ? whtFor(parts, rateHundredths(wRate)) : { base: 0n, amount: 0n };
    return { total, vat, bad, wht };
  }, [open, amounts, wKind, wRate, wRateOk]);

  const entry: EntryLine[] = [
    { code: '2110', debit: calc.total, credit: 0n },
    ...(calc.vat > 0n ? [{ code: '1410', debit: calc.vat, credit: 0n }] : []),
    { code: cashAccount, debit: 0n, credit: calc.total - calc.wht.amount },
    ...(calc.wht.amount > 0n ? [{ code: '2230', debit: 0n, credit: calc.wht.amount }] : []),
    ...(calc.vat > 0n ? [{ code: '1411', debit: 0n, credit: calc.vat }] : []),
  ];

  const isoDate = thaiToIso(date);
  const blocked = !vendor ? th.purchases.vendorRequired
    : calc.bad ?? (calc.total === 0n ? th.purchases.selectOne : isoDate === null ? th.sales.dateInvalid
      : wKind && !vendor.taxId ? th.purchases.whtNeedsTaxId
      : !wRateOk ? th.purchases.whtRateInvalid
      : wKind && calc.wht.amount === 0n ? th.purchases.whtTooSmall : null);
  const canPost = writable && !busy && !blocked;

  const submit = useCallback(async () => {
    if (!canPost || !isoDate || !open) return;
    if (!navigator.onLine) { setError(th.error.offline); return; }
    setBusy(true);
    setError(null);
    try {
      const r = await postJson<{ id: string }>(`/companies/${companyId}/payments`, {
        date: isoDate, partyCode, cashAccount, ...(wKind ? { whtKind: wKind, whtRate: wRate } : {}),
        allocations: open.filter((x) => x.id in amounts).map((x) => ({ documentId: x.id, amount: fromCents(toCents(amounts[x.id]!)!) })),
      }, { 'idempotency-key': idem.current });
      router.push(`/c/${companyId}/purchases/documents/${r.id}`);
    } catch (e) {
      const err = e as ApiError;
      setError(err.code === 'server' ? th.error.server(err.ref ?? '-') : err.message);
      setBusy(false);
    }
  }, [canPost, isoDate, open, companyId, partyCode, cashAccount, wKind, wRate, amounts, router]);

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
      {!co.canWrite && <p className="mx-3 mt-3 text-sm text-ink2 sm:mx-5">{th.purchases.readOnly}</p>}
      <div className="grid gap-5 p-3 sm:p-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,420px)]">
        <div className="flex flex-col gap-5">
          <h1 className="border-b-2 border-ink pb-2.5 font-doc text-[19px] font-bold sm:text-2xl">{th.purchases.paymentTitle}</h1>

          <section className="flex flex-col gap-4" aria-label={th.purchases.vendor}>
            <h2 className={h2}>{th.purchases.vendor}</h2>
            <PartyPicker parties={form.vendors} selected={vendor} label={th.purchases.vendor} hint={th.purchases.vendorSearch} none={th.purchases.vendorNone}
              extra={(v) => (v.whtKind ? th.parties.whtKinds[v.whtKind] ?? null : null)}
              onPick={(v) => { setOpen(null); setAmounts({}); setPartyCode(v.code); setWhtKind(null); setWhtRate(null); }}
              onClear={() => { setPartyCode(''); setOpen(null); setAmounts({}); }} />
          </section>

          {vendor && (
            <section className="flex flex-col gap-3" aria-label={th.purchases.openItems}>
              <h2 className={h2}>{th.purchases.openItems}</h2>
              {open === null ? <p className="text-ink2">…</p> : open.length === 0 ? <p className="text-ink2">{th.purchases.noOpenItems}</p> : (
                <ul className="flex flex-col border-t border-rule">
                  {open.map((r) => {
                    const on = r.id in amounts;
                    return (
                      <li key={r.id} className="grid grid-cols-[auto_minmax(0,1fr)_minmax(0,9rem)] items-center gap-x-3 border-b border-rule py-2">
                        <input type="checkbox" className="size-5 accent-ink" checked={on} aria-label={`${th.purchases.payAmount} ${r.docNo}`}
                          onChange={(e) => setAmounts((a) => {
                            const rest = { ...a };
                            delete rest[r.id];
                            return e.target.checked ? { ...a, [r.id]: r.open! } : rest;
                          })} />
                        <div className="min-w-0">
                          <div><span className="font-num">{r.docNo}</span> <span className="text-sm text-ink2">{r.vendorDocNo} · {isoToThai(r.date)}</span></div>
                          <div className="text-sm text-ink2">{th.sales.open} <span className="num">{formatMoney(r.open!)}</span>{r.dueDate ? ` · ${th.sales.dueDate} ${isoToThai(r.dueDate)}` : ''}</div>
                        </div>
                        <input inputMode="decimal" aria-label={`${th.purchases.payAmount} ${r.docNo}`} disabled={!on}
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
                {th.purchases.cashAccount}
                <select className={inputCls} value={cashAccount} onChange={(e) => setCashAccount(e.target.value)}>
                  {form.cashAccounts.map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}
                </select>
              </label>
              <label className="flex flex-col text-sm">
                {th.purchases.wht}
                <select className={inputCls} value={wKind} onChange={(e) => { setWhtKind(e.target.value as WhtKind | ''); setWhtRate(null); }}>
                  <option value="">{th.purchases.whtNone}</option>
                  {Object.entries(th.parties.whtKinds).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                </select>
              </label>
              {wKind && (
                <label className="flex flex-col text-sm">
                  {th.purchases.whtRate}
                  <input inputMode="decimal" className={`${inputCls} num`} value={wRate} onChange={(e) => setWhtRate(e.target.value)} aria-invalid={!wRateOk} />
                </label>
              )}
            </div>
            <dl className="grid grid-cols-[minmax(0,1fr)_auto] text-[15px]">
              <dt className="py-1">{th.purchases.paymentTotal}</dt><dd className="num py-1">{money(calc.total)}</dd>
              {calc.wht.amount > 0n && (
                <>
                  <dt className="py-1">{th.purchases.whtAmount}</dt><dd className="num py-1">{money(calc.wht.amount)}</dd>
                  <dt className="py-1 text-[13px] text-ink2">{th.purchases.whtBase}</dt>
                  <dd className="num py-1 text-[13px] text-ink2">{th.purchases.whtCalc(money(calc.wht.base), wRate, money(calc.wht.amount))}</dd>
                </>
              )}
              <dt className="border-t border-ink py-1 font-semibold">{th.purchases.netPaid}</dt>
              <dd className="num border-t border-ink py-1 font-semibold">{money(calc.total - calc.wht.amount)}</dd>
            </dl>
            {wKind && calc.total > 0n && calc.total < 100000n && <p className="text-sm text-ink2">{th.purchases.whtSmall}</p>}
          </section>
        </div>

        <div className="flex flex-col gap-2 lg:sticky lg:top-4 lg:self-start">
          <h2 className="font-doc text-[17px] font-bold">{th.purchases.entryPreview}</h2>
          <p className="text-sm text-ink2">{th.purchases.entryNote}</p>
          <EntryPreview lines={calc.total > 0n ? entry : []} names={names} />
        </div>
      </div>

      <footer className="sticky bottom-0 mt-auto flex flex-col gap-2.5 border-t border-rule-strong bg-paper px-4 py-2.5 sm:flex-row sm:items-center sm:gap-6 sm:px-6">
        <p role="alert" className={`text-sm ${error ? 'neg' : 'text-ink2'}`}>{error ?? (busy ? th.purchases.posting : blocked)}</p>
        <Button type="submit" shortcut="F9" disabled={!canPost} className="max-sm:w-full sm:ml-auto">{th.purchases.post}</Button>
      </footer>
    </form>
  );
}
