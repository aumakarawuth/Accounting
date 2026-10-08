'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/Button';
import { postJson, type ApiError, type PurchaseDocument, type PurchaseFormData, type WhtKind } from '@/lib/api';
import { formatMoney, fromCents, toCents } from '@/lib/money';
import { isoToThai, thaiToIso, todayIso } from '@/lib/date';
import { lineAmount, rateHundredths, vatCalc, type PriceMode } from '@/lib/vat';
import { purchaseEntry, whtFor } from '@/lib/entry-preview';
import { EntryPreview, ItemField, PartyPicker } from '@/components/docs/parts';
import { th } from '@/i18n/th';

// ฟอร์มบันทึกเอกสารซื้อ (ซื้อเชื่อ ซื้อสด ใบลดหนี้จากผู้ขาย) โครงเดียวกับฟอร์มขาย
// มือถือ: 4 ขั้น · iPad/คอม: ฟอร์มซ้าย รายการบัญชีที่จะเกิดอยู่ขวา (เราไม่ได้ออกใบเอง จึงแสดงการลงบัญชีแทนกระดาษ)
export type PurchaseFormKind = 'invoice' | 'cash-purchase' | 'credit-note';
type Line = { key: number; itemCode: string; description: string; qty: string; unit: string; unitPrice: string; account: string | null };

let seq = 0;
const blank = (): Line => ({ key: ++seq, itemCode: '', description: '', qty: '1', unit: '', unitPrice: '', account: null });
const QTY = /^\d{1,11}(\.\d{1,3})?$/;
const RATE = /^\d{1,2}(\.\d{1,2})?$/;
const money = (c: bigint) => formatMoney(fromCents(c));
const STANDARD: Record<string, string> = { transport: '1', advertising: '2', service: '3', professional: '3', rent: '5' };
const KIND_SQL = { invoice: 'purchase_invoice', 'cash-purchase': 'cash_purchase', 'credit-note': 'purchase_credit_note' } as const;

export function PurchaseForm({ companyId, kind, form, refDoc }: {
  companyId: string; kind: PurchaseFormKind; form: PurchaseFormData; refDoc?: PurchaseDocument | null;
}) {
  const router = useRouter();
  const isNote = kind === 'credit-note';
  const co = form.company;
  const writable = co.canWrite && !co.locked;
  const itemsByCode = useMemo(() => new Map(form.items.map((i) => [i.code, i])), [form.items]);
  const names = useMemo(() => new Map([...form.expenseAccounts, ...form.cashAccounts, ...form.systemAccounts].map((a) => [a.code, a.name])), [form]);

  const [step, setStep] = useState(0);
  const [entryOpen, setEntryOpen] = useState(false); // มือถือ: ดูรายการบัญชีแทนฟอร์ม
  const [date, setDate] = useState(isoToThai(todayIso()));
  const [partyCode, setPartyCode] = useState('');
  const [vendorDocNo, setVendorDocNo] = useState('');
  const [service, setService] = useState<boolean | null>(null);
  const [priceMode, setPriceMode] = useState<'exclusive' | 'inclusive'>('exclusive');
  const [creditDays, setCreditDays] = useState<string | null>(null);
  const [cashAccount, setCashAccount] = useState(form.cashAccounts[0]?.code ?? '1110');
  const [whtKind, setWhtKind] = useState<WhtKind | '' | null>(null); // null = ตามที่ตั้งไว้ที่ผู้ขาย
  const [whtRate, setWhtRate] = useState<string | null>(null);
  const [discount, setDiscount] = useState('');
  const [description, setDescription] = useState('');
  const [reason, setReason] = useState('');
  const [lines, setLines] = useState<Line[]>(() => [blank()]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idem = useRef(crypto.randomUUID());

  const target = isNote ? refDoc! : null;
  const vendor = isNote ? null : form.vendors.find((v) => v.code === partyCode) ?? null;
  const update = (key: number, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const addLine = useCallback(() => setLines((ls) => [...ls, blank()]), []);

  // ผู้ขายไม่จด VAT เก็บภาษีไม่ได้ · ใบลดหนี้ใช้แบบราคา/อัตรา/บริการตามใบเดิม
  const mode: PriceMode = target ? target.priceMode : vendor && !vendor.vatRegistered ? 'none' : priceMode;
  const rate = target ? target.vatRate : mode === 'none' ? '0' : co.vatRate;
  const firstItem = lines.map((l) => itemsByCode.get(l.itemCode)).find(Boolean);
  const isService = target ? target.isService : service ?? firstItem?.isService ?? false;
  const defaultAccount = (l: Line) => {
    const it = itemsByCode.get(l.itemCode);
    if (isNote) return isService ? target!.lines[0]?.accountCode ?? '5260' : '5140';
    return it?.purchaseAccount ?? (isService ? '5260' : '5110');
  };
  const accountOf = (l: Line) => l.account ?? defaultAccount(l);

  const calc = useMemo(() => {
    let gross = 0n, filled = 0;
    const problems = new Map<number, string>();
    const amounts = new Map<number, bigint>();
    lines.forEach((l, i) => {
      if (!l.description.trim() && !l.unitPrice.trim() && !l.itemCode) return;
      const price = toCents(l.unitPrice);
      const amt = price === null ? null : lineAmount(l.qty, price);
      const it = itemsByCode.get(l.itemCode);
      if (!l.description.trim() || amt === null || !QTY.test(l.qty.trim()) || Number(l.qty) <= 0 || !l.unitPrice.trim()) {
        problems.set(l.key, th.sales.lineInvalid(i + 1));
      } else if (it && it.isService !== isService) {
        problems.set(l.key, th.sales.lineMixed(i + 1));
      }
      if (amt !== null) { gross += amt; amounts.set(l.key, amt); }
      filled++;
    });
    const disc = toCents(discount);
    const discBad = disc === null || (disc > 0n && disc >= gross);
    const t = vatCalc(gross, discBad ? 0n : disc!, rate, mode);
    return { gross, disc: discBad ? 0n : disc!, discBad, ...t, problems, amounts, filled };
  }, [lines, itemsByCode, isService, discount, rate, mode]);

  // หัก ณ ที่จ่าย (ซื้อสดเท่านั้น): ประเภท/อัตราตั้งต้นจากผู้ขาย ฐาน = มูลค่าก่อน VAT
  const wKind = kind !== 'cash-purchase' ? '' : whtKind ?? vendor?.whtKind ?? '';
  const wRate = whtRate ?? (wKind && wKind === vendor?.whtKind && vendor.whtRate ? String(Number(vendor.whtRate)) : STANDARD[wKind] ?? '');
  const wRateOk = !wKind || (RATE.test(wRate) && Number(wRate) > 0 && Number(wRate) <= 15);
  const wht = wKind && wRateOk ? whtFor([{ amount: calc.total, base: calc.base, total: calc.total || 1n }], rateHundredths(wRate)) : { base: 0n, amount: 0n };

  const claimable = target ? target.vatClaimable : co.vatRegistered;
  const entry = purchaseEntry({
    kind: KIND_SQL[kind], lines: lines.filter((l) => calc.amounts.has(l.key)).map((l) => ({ code: accountOf(l), amount: calc.amounts.get(l.key)! })),
    base: calc.base, vat: calc.vat, total: calc.total, service: isService, claimable, cashAccount, wht: wht.amount,
  });

  const isoDate = thaiToIso(date);
  const days = creditDays === null ? vendor?.creditDays ?? 0 : Number(creditDays);
  const daysBad = (creditDays !== null && !/^\d{1,3}$/.test(creditDays)) || days > 365;
  const overOpen = isNote && calc.total > (toCents(target!.open ?? '0') ?? 0n);

  const stepProblem = [
    isoDate === null ? th.sales.dateInvalid
      : isNote ? (!reason.trim() ? th.purchases.reasonRequired : !vendorDocNo.trim() ? th.purchases.vendorDocNoRequired : null)
      : !vendor ? th.purchases.vendorRequired
      : !vendorDocNo.trim() ? th.purchases.vendorDocNoRequired : null,
    [...calc.problems.values()][0] ?? (calc.filled === 0 || calc.gross === 0n ? th.sales.noLines : null),
    calc.discBad ? th.sales.discountInvalid
      : daysBad ? th.sales.creditDaysInvalid
      : overOpen ? th.purchases.overOpen(formatMoney(target!.open ?? '0'))
      : wKind && !vendor?.taxId ? th.purchases.whtNeedsTaxId
      : !wRateOk ? th.purchases.whtRateInvalid
      : wKind && wht.amount === 0n ? th.purchases.whtTooSmall : null,
  ];
  const blocked = stepProblem.find(Boolean) ?? null;
  const canPost = writable && !busy && !blocked;

  const submit = useCallback(async () => {
    if (!canPost || !isoDate) return;
    if (!navigator.onLine) { setError(th.error.offline); return; }
    setBusy(true);
    setError(null);
    try {
      const body = {
        date: isoDate, vendorDocNo: vendorDocNo.trim(),
        ...(isNote ? { refDocumentId: target!.id, reason: reason.trim() } : { partyCode, isService }),
        ...(!isNote && mode !== 'none' ? { priceMode } : {}),
        ...(calc.disc > 0n ? { discount: fromCents(calc.disc) } : {}),
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(kind === 'invoice' && creditDays !== null ? { creditDays: days } : {}),
        ...(kind === 'cash-purchase' ? { cashAccount, ...(wKind ? { whtKind: wKind, whtRate: wRate } : {}) } : {}),
        lines: lines.filter((l) => calc.amounts.has(l.key)).map((l) => ({
          ...(l.itemCode ? { itemCode: l.itemCode } : {}),
          description: l.description.trim(), qty: l.qty.trim(), unitPrice: fromCents(toCents(l.unitPrice)!), accountCode: accountOf(l),
          ...(l.unit.trim() ? { unit: l.unit.trim() } : {}),
        })),
      };
      const r = await postJson<{ id: string }>(`/companies/${companyId}/purchases/${kind}`, body, { 'idempotency-key': idem.current });
      router.push(`/c/${companyId}/purchases/documents/${r.id}`);
    } catch (e) {
      const err = e as ApiError;
      setError(err.code === 'server' ? th.error.server(err.ref ?? '-') : err.message);
      setBusy(false);
    }
    // accountOf อ่านจาก lines/isService ที่อยู่ใน deps แล้ว
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canPost, isoDate, vendorDocNo, isNote, target, reason, partyCode, isService, mode, priceMode, calc, description, kind, creditDays, days, cashAccount, wKind, wRate, lines, companyId, router]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F9') { e.preventDefault(); void submit(); }
      if (e.key === 'Insert') { e.preventDefault(); addLine(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [submit, addLine]);

  const steps = isNote ? [th.sales.ref, ...th.purchases.steps.slice(1)] : th.purchases.steps;
  const sec = (n: number) => `flex flex-col gap-4 ${step === n ? '' : 'max-sm:hidden'}`;
  const h2 = 'border-b border-rule-strong pb-1.5 font-doc text-[17px] font-bold';
  const inputCls = 'h-11 w-full border-b border-rule-input bg-transparent px-0.5 text-base';
  const accountOptions = isNote && !form.expenseAccounts.some((a) => a.code === '5140')
    ? [...form.systemAccounts.filter((a) => a.code === '5140'), ...form.expenseAccounts] : form.expenseAccounts;
  const preview = (
    <div className="flex flex-col gap-2">
      <h2 className="font-doc text-[17px] font-bold">{th.purchases.entryPreview}</h2>
      <p className="text-sm text-ink2">{th.purchases.entryNote}</p>
      <EntryPreview lines={entry} names={names} />
    </div>
  );

  return (
    <form className="flex min-h-full flex-col" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      {co.locked && <p role="status" className="mx-3 mt-3 border border-rule-strong bg-band px-4 py-2.5 sm:mx-5">{th.submission.lockedNote}</p>}
      {!co.canWrite && <p className="mx-3 mt-3 text-sm text-ink2 sm:mx-5">{th.purchases.readOnly}</p>}

      <div className="grid gap-5 p-3 sm:grid-cols-[minmax(0,470px)_minmax(0,1fr)] sm:p-5">
        <div className={`flex flex-col gap-5 ${entryOpen ? 'max-sm:hidden' : ''}`}>
          <div className="border-b-2 border-ink pb-2.5">
            <h1 className="font-doc text-[19px] font-bold sm:text-2xl">{th.purchases.formTitle[kind]}</h1>
            <div className="mt-2.5 grid grid-cols-4 gap-1 sm:hidden" aria-hidden>
              {steps.map((s, i) => <span key={s} className={`h-1 ${i <= step ? 'bg-ink' : 'bg-rule'}`} />)}
            </div>
            <p className="mt-1.5 text-sm text-ink2 sm:hidden">{th.invoice.step(step + 1, 4, steps[step]!)}</p>
          </div>

          {/* ขั้น 1: ผู้ขาย (หรือใบที่อ้างถึง) เลขที่และวันที่ของเอกสารผู้ขาย */}
          <section className={sec(0)} aria-label={steps[0]}>
            <h2 className={h2}>{steps[0]}</h2>
            {target ? (
              <>
                <p className="border border-rule-input px-3 py-2">
                  {th.purchases.refInfo(target.docNo, target.vendorDocNo ?? '', formatMoney(target.total), formatMoney(target.open ?? '0'))}
                  <br /><span className="text-ink2">{target.partyName}</span>
                </p>
                <label className="flex flex-col text-sm">
                  {th.sales.reason}
                  <input className={inputCls} value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} aria-invalid={!reason.trim()} />
                </label>
              </>
            ) : (
              <PartyPicker parties={form.vendors} selected={vendor} label={th.purchases.vendor} hint={th.purchases.vendorSearch} none={th.purchases.vendorNone}
                extra={(v) => (v.vatRegistered ? null : th.purchases.vendorNoVat)}
                onPick={(v) => { setPartyCode(v.code); setCreditDays(null); setWhtKind(null); setWhtRate(null); }}
                onClear={() => setPartyCode('')} />
            )}
            <div className="flex flex-col text-sm">
              <label htmlFor="vendor-doc">{isNote ? th.purchases.vendorCnNo : th.purchases.vendorDocNo}</label>
              <input id="vendor-doc" className={`${inputCls} font-num`} value={vendorDocNo} maxLength={40} aria-describedby="vendor-doc-n"
                onChange={(e) => setVendorDocNo(e.target.value)} aria-invalid={!vendorDocNo.trim()} />
              <span id="vendor-doc-n" className="pt-1 text-[13px] text-ink2">{th.purchases.vendorDocNoHint}</span>
            </div>
            <div className="flex flex-col text-sm">
              <label htmlFor="doc-date">{th.purchases.date}</label>
              <input id="doc-date" className={`${inputCls} font-num`} inputMode="numeric" value={date} aria-describedby="doc-date-n"
                onChange={(e) => setDate(e.target.value)} aria-invalid={isoDate === null} />
              <span id="doc-date-n" className="pt-1 text-[13px] text-ink2">{th.purchases.dateHint}</span>
            </div>
          </section>

          {/* ขั้น 2: รายการ + บัญชีที่ลง */}
          <section className={sec(1)} aria-label={steps[1]}>
            <h2 className={h2}>{th.sales.items}</h2>
            {!isNote && (
              <fieldset className="flex flex-wrap items-center gap-x-5 text-sm">
                <legend className="sr-only">{th.sales.kind}</legend>
                <span aria-hidden>{th.sales.kind}</span>
                {([[false, th.sales.goods], [true, th.sales.service]] as const).map(([v, label]) => (
                  <label key={label} className="flex min-h-11 items-center gap-2 text-base">
                    <input type="radio" name="svc" className="size-5 accent-ink" checked={isService === v} onChange={() => setService(v)} />{label}
                  </label>
                ))}
              </fieldset>
            )}
            {kind === 'invoice' && isService && claimable && mode !== 'none' && <p className="text-sm text-ink2">{th.purchases.serviceNote}</p>}
            <ol className="flex flex-col gap-3">
              {lines.map((l, i) => {
                const amt = calc.amounts.get(l.key);
                const problem = calc.problems.get(l.key);
                return (
                  <li key={l.key} className="flex flex-col gap-2 border border-rule px-3 pt-1 pb-3">
                    <ItemField items={form.items} value={l.description} picked={Boolean(l.itemCode)} label={`${th.sales.description} ${i + 1}`} price={(it) => it.purchasePrice}
                      onText={(text) => update(l.key, { description: text, itemCode: l.itemCode && itemsByCode.get(l.itemCode)?.name === text ? l.itemCode : '' })}
                      onPick={(it) => update(l.key, { itemCode: it.code, description: it.name, unit: it.unit, unitPrice: it.purchasePrice ?? l.unitPrice, account: null })} />
                    <div className="grid grid-cols-[minmax(0,0.8fr)_minmax(0,1fr)_minmax(0,1fr)] gap-3">
                      <label className="flex flex-col text-[13px] text-ink2">
                        {th.sales.qty}{l.unit ? ` (${l.unit})` : ''}
                        <input inputMode="decimal" className={`${inputCls} num text-ink`} value={l.qty} onChange={(e) => update(l.key, { qty: e.target.value })} />
                      </label>
                      <label className="flex flex-col text-[13px] text-ink2">
                        {th.sales.unitPrice}
                        <input inputMode="decimal" className={`${inputCls} num text-ink`} value={l.unitPrice} onChange={(e) => update(l.key, { unitPrice: e.target.value })} />
                      </label>
                      <div className="flex flex-col text-[13px] text-ink2">
                        {th.sales.amount}
                        <output className="num flex h-11 items-center justify-end text-base text-ink">{amt === undefined ? '—' : money(amt)}</output>
                      </div>
                    </div>
                    <label className="flex flex-col text-[13px] text-ink2">
                      {th.purchases.account}
                      <select className={`${inputCls} text-ink`} value={accountOf(l)} aria-label={`${th.purchases.account} ${i + 1}`}
                        onChange={(e) => update(l.key, { account: e.target.value })}>
                        {accountOptions.map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}
                      </select>
                    </label>
                    {problem && <p className="neg text-sm">{problem}</p>}
                    {lines.length > 1 && (
                      <button type="button" className="min-h-11 self-start text-sm text-ink2 underline" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>
                        {th.sales.removeLine} {i + 1}
                      </button>
                    )}
                  </li>
                );
              })}
            </ol>
            <Button type="button" variant="secondary" shortcut="Ins" onClick={addLine} className="max-sm:w-full">{th.sales.addLine}</Button>
          </section>

          {/* ขั้น 3: ยอด ภาษี หัก ณ ที่จ่าย */}
          <section className={sec(2)} aria-label={steps[2]}>
            <h2 className={h2}>{steps[2]}</h2>
            {!claimable && <p className="text-sm text-ink2">{th.purchases.companyNoVat}</p>}
            {vendor && !vendor.vatRegistered && <p className="text-sm text-ink2">{th.purchases.vendorNoVat}</p>}
            {!isNote && mode !== 'none' && (
              <fieldset className="flex flex-col text-sm">
                <legend>{th.sales.priceMode}</legend>
                {(['exclusive', 'inclusive'] as const).map((m) => (
                  <label key={m} className="flex min-h-11 items-center gap-2 text-base">
                    <input type="radio" name="mode" className="size-5 accent-ink" checked={priceMode === m} onChange={() => setPriceMode(m)} />{th.sales[m]}
                  </label>
                ))}
              </fieldset>
            )}
            <div className="grid grid-cols-2 gap-3">
              <label className="flex flex-col text-sm">
                {th.sales.discount}
                <input inputMode="decimal" className={`${inputCls} num`} value={discount} onChange={(e) => setDiscount(e.target.value)} aria-invalid={calc.discBad} />
              </label>
              {kind === 'invoice' && (
                <label className="flex flex-col text-sm">
                  {th.sales.creditDays}
                  <input inputMode="numeric" className={`${inputCls} num`} value={creditDays ?? String(vendor?.creditDays ?? 0)} onChange={(e) => setCreditDays(e.target.value)} aria-invalid={daysBad} />
                </label>
              )}
              {kind === 'cash-purchase' && (
                <>
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
                </>
              )}
            </div>
            <label className="flex flex-col text-sm">
              {th.sales.note}
              <input className={inputCls} value={description} maxLength={300} onChange={(e) => setDescription(e.target.value)} />
            </label>
            <dl className="grid grid-cols-[minmax(0,1fr)_auto] text-[15px]">
              <dt className="py-1">{th.sales.subtotal}</dt><dd className="num py-1">{money(calc.gross)}</dd>
              {calc.disc > 0n && <><dt className="py-1">{th.sales.afterDiscount}</dt><dd className="num py-1">{money(calc.gross - calc.disc)}</dd></>}
              {mode !== 'none' && <><dt className="py-1">{th.sales.base}</dt><dd className="num py-1">{money(calc.base)}</dd></>}
              {mode !== 'none' && <><dt className="py-1">{th.sales.vat(String(Number(rate)))}</dt><dd className="num py-1">{money(calc.vat)}</dd></>}
              <dt className="border-t border-ink py-1 font-semibold">{th.sales.total}</dt>
              <dd className="num border-t border-ink py-1 font-semibold">{money(calc.total)}</dd>
              {wht.amount > 0n && (
                <>
                  <dt className="py-1">{th.purchases.whtAmount}</dt>
                  <dd className="num py-1">{money(wht.amount)}</dd>
                  <dt className="py-1 text-[13px] text-ink2">{th.purchases.whtBase}</dt>
                  <dd className="num py-1 text-[13px] text-ink2">{th.purchases.whtCalc(money(wht.base), wRate, money(wht.amount))}</dd>
                  <dt className="py-1 font-semibold">{th.purchases.netPaid}</dt>
                  <dd className="num py-1 font-semibold">{money(calc.total - wht.amount)}</dd>
                </>
              )}
            </dl>
            {wKind && calc.total > 0n && calc.total < 100000n && <p className="text-sm text-ink2">{th.purchases.whtSmall}</p>}
          </section>

          {/* ขั้น 4 (มือถือ): ตรวจรายการบัญชีแล้วบันทึก */}
          <section className={`${sec(3)} sm:hidden`} aria-label={steps[3]}>
            <h2 className={h2}>{steps[3]}</h2>
            <p className="text-sm">{th.purchases.review}</p>
            {preview}
          </section>

          {step < 3 && (
            <button type="button" className="min-h-12 border border-dashed border-ink2 text-ink2 sm:hidden" onClick={() => setEntryOpen(true)}>
              {th.purchases.entryPreview}
            </button>
          )}
        </div>

        <div className={`flex flex-col gap-2 sm:sticky sm:top-4 sm:self-start ${entryOpen ? '' : 'max-sm:hidden'}`}>
          {preview}
          <Button type="button" variant="secondary" className="sm:hidden" onClick={() => setEntryOpen(false)}>{th.sales.backToForm}</Button>
        </div>
      </div>

      <footer className="sticky bottom-0 mt-auto flex flex-col gap-2.5 border-t border-rule-strong bg-paper px-4 py-2.5 sm:flex-row sm:items-center sm:gap-6 sm:px-6">
        <dl className="flex justify-between gap-3 text-[15px] sm:gap-5">
          <dt>{th.sales.total}</dt>
          <dd className="num font-semibold">{money(calc.total)}</dd>
        </dl>
        <p role="alert" className={`text-sm sm:hidden ${error ? 'neg' : 'text-ink2'}`}>{error ?? (busy ? th.purchases.posting : step < 3 ? stepProblem[step] : blocked)}</p>
        <p role="alert" className={`text-sm max-sm:hidden ${error ? 'neg' : 'text-ink2'}`}>{error ?? (busy ? th.purchases.posting : blocked)}</p>
        <div className="grid grid-cols-2 gap-3 sm:hidden">
          <Button type="button" variant="secondary" disabled={step === 0} onClick={() => setStep((s) => s - 1)}>{th.sales.prev}</Button>
          {/* key ต่างกัน: ปุ่มเดิมกลายเป็น submit กลางคลิก เบราว์เซอร์จะส่งฟอร์มเอง (เจอใน e2e ของฝั่งขาย) */}
          {step < 3
            ? <Button key="next" type="button" disabled={Boolean(stepProblem[step])} onClick={() => { setStep((s) => s + 1); setEntryOpen(false); window.scrollTo(0, 0); }}>{th.sales.next(steps[step + 1]!)}</Button>
            : <Button key="post" type="submit" disabled={!canPost}>{th.purchases.post}</Button>}
        </div>
        <Button type="submit" shortcut="F9" disabled={!canPost} className="max-sm:hidden sm:ml-auto">{th.purchases.post}</Button>
      </footer>
    </form>
  );
}
