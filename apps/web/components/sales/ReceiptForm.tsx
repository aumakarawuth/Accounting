'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/Button';
import { api, postJson, type ApiError, type ChequeRow, type SalesFormData, type SalesRow } from '@/lib/api';
import { formatMoney, fromCents, toCents } from '@/lib/money';
import { isoToThai, thaiToIso, todayIso, maskDate } from '@/lib/date';
import { rateHundredths } from '@/lib/vat';
import type { EntryLine } from '@/lib/entry-preview';
import { DraftBanner, PartyPicker, liveLines } from '@/components/docs/parts';
import { useDocDraft } from '@/components/docs/useDocDraft';
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
  const [open, setOpen] = useState<SalesRow[] | null>(null);
  const [amounts, setAmounts] = useState<Record<string, string>>({}); // documentId → ยอดรับ (ไม่มี key = ไม่เลือก)
  const [discounts, setDiscounts] = useState<Record<string, string>>({}); // documentId → ส่วนลดเงินสด (ว่าง = ไม่มี)
  const [date, setDate] = useState(isoToThai(todayIso()));
  const [cashAccount, setCashAccount] = useState(form.cashAccounts[0]?.code ?? '1110');
  const [whtRate, setWhtRate] = useState(''); // '' = ไม่หัก
  const [whtAmount, setWhtAmount] = useState<string | null>(null); // null = ตามที่ระบบเสนอ
  // รับเป็นเช็ค: ใบเสร็จลงบัญชีพักเช็ค (1220/1221) แล้วลงทะเบียนเช็คพร้อมกัน (acc.register_cheque)
  const [byCheque, setByCheque] = useState(false);
  const [chequeNo, setChequeNo] = useState('');
  const [chequeBank, setChequeBank] = useState('');
  const [chequeDate, setChequeDate] = useState(isoToThai(todayIso()));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [idemKey, setIdemKey] = useState(() => crypto.randomUUID()); // คีย์เดิมจนบันทึกสำเร็จ กดซ้ำ/เน็ตหลุดไม่ออกใบซ้ำ
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
      // ยอดที่กู้จากร่างเก็บไว้เฉพาะใบที่ยังค้าง ไม่มีก็เลือกใบที่ส่งมาจากหน้าเอกสาร
      setAmounts((a) => {
        const kept = Object.fromEntries(Object.entries(a).filter(([id]) => items.some((r) => r.id === id)));
        return Object.keys(kept).length ? kept : pre ? { [pre.id]: pre.open! } : {};
      });
    }, (e: ApiError) => alive && setError(e.message));
    return () => { alive = false; };
  }, [companyId, partyCode, initialDoc]);

  const calc = useMemo(() => {
    let total = 0n, base = 0n, vat = 0n, disc = 0n, dvat = 0n, gross = 0n, bad: string | null = null;
    for (const r of open ?? []) {
      if (!(r.id in amounts)) continue;
      const a = toCents(amounts[r.id]!);
      const d = (discounts[r.id] ?? '').trim() ? toCents(discounts[r.id]!) : 0n;
      const max = toCents(r.open!)!;
      if (a === null || d === null || a <= 0n || d < 0n || a + d > max) { bad ??= th.sales.receiveInvalid(r.docNo); continue; }
      const settle = a + d;
      total += a; disc += d; gross += settle;
      base += divRound(a * toCents(r.base)!, toCents(r.total)!); // ส่วนของมูลค่าก่อน VAT ในยอดที่รับ
      // ภาษีขายบริการ (สูตรเดียวกับ acc.post_receipt): ส่วนที่ตัด แบ่งเป็นส่วนที่รับเงิน (ถึงกำหนด) กับส่วนลด (ล้างออก)
      const undue = toCents(r.undueVat ?? '0') ?? 0n;
      if (undue > 0n) {
        const tr = settle === max ? undue : divRound(settle * undue, max);
        const dv = divRound(d * undue, max);
        vat += tr - dv; dvat += dv;
      }
    }
    const suggested = whtRate ? divRound(base * rateHundredths(whtRate), 10000n) : 0n;
    const wht = whtAmount === null ? suggested : toCents(whtAmount);
    return { total, base, vat, disc, dvat, gross, bad, suggested, wht };
  }, [open, amounts, discounts, whtRate, whtAmount]);
  // ใส่ส่วนลดตอนยอดรับยังเต็มยอดค้าง: ลดยอดรับให้เท่าส่วนที่เหลือ
  const setDiscount = (r: { id: string; open: string | null }, v: string) => {
    const max = toCents(r.open!)!, prev = toCents(discounts[r.id] || '0') ?? 0n, next = toCents(v || '0');
    setDiscounts((x) => ({ ...x, [r.id]: v }));
    if (next !== null && next >= 0n && next < max && toCents(amounts[r.id] ?? '') === max - prev) setAmounts((x) => ({ ...x, [r.id]: fromCents(max - next) }));
  };

  const isoDate = thaiToIso(date);
  const isoChequeDate = thaiToIso(chequeDate);
  const chequeBad = !byCheque ? null : !/^[0-9A-Za-z-]{1,20}$/.test(chequeNo) ? th.cheques.invalid.chequeNo
    : chequeBank.trim() === '' ? th.cheques.invalid.bank : isoChequeDate === null ? th.cheques.invalid.date : null;
  const receiveCode = byCheque ? (isoChequeDate && isoDate && isoChequeDate > isoDate ? '1221' : '1220') : cashAccount;
  const whtBad = calc.wht === null || (calc.wht > 0n && calc.wht >= calc.total);
  const blocked = !party ? th.sales.customerRequired
    : calc.bad ?? (calc.total === 0n ? th.sales.selectOne : isoDate === null ? th.sales.dateInvalid : whtBad ? th.sales.whtInvalid : chequeBad);
  const canPost = writable && !busy && !blocked;

  // ร่างในเครื่อง + ครูดูสด
  const w = calc.wht ?? 0n;
  const entry: EntryLine[] = [
    { code: receiveCode, debit: calc.total - w, credit: 0n },
    ...(w > 0n ? [{ code: '1420', debit: w, credit: 0n }] : []),
    ...(calc.disc - calc.dvat > 0n ? [{ code: '4210', debit: calc.disc - calc.dvat, credit: 0n }] : []),
    ...(calc.vat + calc.dvat > 0n ? [{ code: '2211', debit: calc.vat + calc.dvat, credit: 0n }] : []),
    { code: '1210', debit: 0n, credit: calc.gross },
    ...(calc.vat > 0n ? [{ code: '2210', debit: 0n, credit: calc.vat }] : []),
  ];
  const draft = useDocDraft(writable ? 'receipt' : null, companyId, { partyCode, amounts, discounts, date, cashAccount, whtRate, whtAmount, idemKey, byCheque, chequeNo, chequeBank, chequeDate }, {
    isEmpty: (d) => !d.partyCode,
    restore: (d) => {
      if (initialParty && d.partyCode !== initialParty) return false; // เปิดจากหน้าเอกสารของลูกค้ารายอื่น: ไม่ทับด้วยร่างเก่า
      setPartyCode(d.partyCode); setAmounts(d.amounts); setDiscounts(d.discounts ?? {}); setDate(d.date); setCashAccount(d.cashAccount);
      setWhtRate(d.whtRate); setWhtAmount(d.whtAmount); setIdemKey(d.idemKey);
      setByCheque(d.byCheque ?? false); setChequeNo(d.chequeNo ?? ''); setChequeBank(d.chequeBank ?? ''); if (d.chequeDate) setChequeDate(d.chequeDate);
    },
    live: calc.total > 0n ? { title: th.sales.receiptTitle, date: isoDate ?? date, description: party?.name ?? '', lines: liveLines(entry) } : null,
  });
  const discardDraft = () => {
    setPartyCode(''); setOpen(null); setAmounts({}); setDiscounts({}); setWhtRate(''); setWhtAmount(null);
    setIdemKey(crypto.randomUUID());
    draft.discard();
  };

  const submit = useCallback(async () => {
    if (!canPost || !isoDate || !open) return;
    if (!navigator.onLine) { setError(th.error.offline); return; }
    setBusy(true);
    setError(null);
    try {
      const receipt = {
        partyCode, ...(calc.wht! > 0n ? { whtAmount: fromCents(calc.wht!) } : {}),
        allocations: open.filter((x) => x.id in amounts).map((x) => ({
          documentId: x.id, amount: fromCents(toCents(amounts[x.id]!)!),
          ...((discounts[x.id] ?? '').trim() && toCents(discounts[x.id]!)! > 0n ? { discount: fromCents(toCents(discounts[x.id]!)!) } : {}),
        })),
      };
      const id = byCheque
        ? (await postJson<ChequeRow>(`/companies/${companyId}/cheques`, {
            direction: 'received', chequeNo, bankName: chequeBank.trim(), chequeDate: isoChequeDate, date: isoDate, receipt,
          }, { 'idempotency-key': idemKey })).documentId!
        : (await postJson<{ id: string }>(`/companies/${companyId}/receipts`, { date: isoDate, cashAccount, ...receipt }, { 'idempotency-key': idemKey })).id;
      draft.finish();
      router.push(`/c/${companyId}/sales/documents/${id}`);
    } catch (e) {
      const err = e as ApiError;
      setError(err.code === 'server' ? th.error.server(err.ref ?? '-') : err.message);
      setBusy(false);
    }
  }, [canPost, isoDate, open, companyId, partyCode, cashAccount, calc.wht, amounts, discounts, router, draft, idemKey, byCheque, chequeNo, chequeBank, isoChequeDate]);

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
      <DraftBanner restoredAt={draft.restoredAt} onDiscard={discardDraft} />
      <div className="flex max-w-3xl flex-col gap-5 p-3 sm:p-5">
        <h1 className="border-b-2 border-ink pb-2.5 font-doc text-[19px] font-bold sm:text-2xl">{th.sales.receiptTitle}</h1>

        <section className="flex flex-col gap-4" aria-label={th.sales.customer}>
          <h2 className={h2}>{th.sales.customer}</h2>
          <PartyPicker parties={form.customers} selected={party} label={th.sales.customer} hint={th.sales.customerSearch} none={th.sales.customerNone}
            onPick={(c) => { setOpen(null); setAmounts({}); setDiscounts({}); setPartyCode(c.code); }} onClear={() => { setPartyCode(''); setOpen(null); setAmounts({}); setDiscounts({}); }} />
        </section>

        {party && (
          <section className="flex flex-col gap-3" aria-label={th.sales.openItems}>
            <h2 className={h2}>{th.sales.openItems}</h2>
            <p className="text-sm text-ink2">{th.sales.cashDiscountNote}</p>
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
                    {on && (
                        <label className="col-span-3 grid grid-cols-[minmax(0,1fr)_minmax(0,9rem)] items-center gap-x-3 pl-8 text-sm text-ink2">
                          {th.sales.cashDiscount(r.docNo)}
                          <input inputMode="decimal" className={`${inputCls} num text-ink`} value={discounts[r.id] ?? ''} placeholder="0.00"
                            onChange={(e) => setDiscount(r, e.target.value)} />
                        </label>
                      )}
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
              <input className={`${inputCls} font-num`} inputMode="numeric" value={date} onChange={(e) => setDate(maskDate(e.target.value))} aria-invalid={isoDate === null} />
            </label>
            {byCheque ? (
              <label className="flex flex-col text-sm">
                {th.cheques.chequeDate}
                <input className={`${inputCls} font-num`} inputMode="numeric" value={chequeDate} onChange={(e) => setChequeDate(maskDate(e.target.value))} aria-invalid={isoChequeDate === null} />
              </label>
            ) : (
              <label className="flex flex-col text-sm">
                {th.sales.cashAccount}
                <select className={inputCls} value={cashAccount} onChange={(e) => setCashAccount(e.target.value)}>
                  {form.cashAccounts.map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}
                </select>
              </label>
            )}
            <label className="col-span-2 flex min-h-11 items-center gap-3 text-[15px]">
              <input type="checkbox" className="size-5 shrink-0 text-base accent-ink" checked={byCheque} onChange={(e) => setByCheque(e.target.checked)} />
              {th.cheques.byCheque.received}
            </label>
            {byCheque && (
              <>
                <label className="flex flex-col text-sm">
                  {th.cheques.chequeNo}
                  <input className={`${inputCls} font-num`} value={chequeNo} maxLength={20} onChange={(e) => setChequeNo(e.target.value.trim())} />
                </label>
                <label className="flex flex-col text-sm">
                  {th.cheques.bankName}
                  <input className={inputCls} value={chequeBank} maxLength={100} onChange={(e) => setChequeBank(e.target.value)} />
                </label>
                <p className="col-span-2 text-[13px] text-ink2">{th.cheques.byChequeNote.received} · {th.cheques.entryHint(receiveCode, '1210')}</p>
              </>
            )}
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
            {calc.disc > 0n && <><dt className="py-1">{th.sales.settledTotal}</dt><dd className="num py-1">{money(calc.gross)}</dd>
              <dt className="py-1">{th.sales.cashDiscountTotal}</dt><dd className="num py-1">{money(calc.disc)}</dd></>}
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
