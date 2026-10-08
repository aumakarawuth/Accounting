'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/Button';
import { postJson, type ApiError, type SalesDocument, type SalesFormData } from '@/lib/api';
import { formatMoney, fromCents, toCents } from '@/lib/money';
import { addDays, isoToThai, thaiToIso, todayIso } from '@/lib/date';
import { lineAmount, vatCalc, type PriceMode } from '@/lib/vat';
import { th } from '@/i18n/th';
import { DocumentPaper, type Paper } from './DocumentPaper';
import { ItemField, PartyPicker } from '@/components/docs/parts';

// ฟอร์มออกเอกสารขาย (ใบกำกับภาษี/ใบแจ้งหนี้ ขายสด ใบลดหนี้ ใบเพิ่มหนี้) ตาม mockup ที่อนุมัติ
// มือถือ: 4 ขั้น มีปุ่มดูตัวอย่างกระดาษ · iPad/คอม: ฟอร์มซ้าย กระดาษตัวอย่างขวา
// ยอดคิดสูตรเดียวกับ DB (lib/vat.ts) เพื่อให้ตัวอย่างตรงกับใบจริงทุกสตางค์ — DB ตรวจซ้ำอีกครั้งตอนผ่านรายการ
export type SalesFormKind = 'invoice' | 'cash-sale' | 'credit-note' | 'debit-note';
type Line = { key: number; itemCode: string; description: string; qty: string; unit: string; unitPrice: string };

let seq = 0;
const blank = (): Line => ({ key: ++seq, itemCode: '', description: '', qty: '1', unit: '', unitPrice: '' });
const QTY = /^\d{1,11}(\.\d{1,3})?$/;
const money = (c: bigint) => formatMoney(fromCents(c));

export function SalesDocumentForm({ companyId, kind, form, refDoc }: {
  companyId: string; kind: SalesFormKind; form: SalesFormData; refDoc?: SalesDocument | null;
}) {
  const router = useRouter();
  const isNote = kind === 'credit-note' || kind === 'debit-note';
  const co = form.company;
  const writable = co.canWrite && !co.locked;
  const itemsByCode = useMemo(() => new Map(form.items.map((i) => [i.code, i])), [form.items]);

  const [step, setStep] = useState(0); // ขั้นบนมือถือ 0–3 (จอใหญ่เห็นทุกส่วนพร้อมกัน)
  const [paperOpen, setPaperOpen] = useState(false); // มือถือ: ดูตัวอย่างกระดาษแทนฟอร์ม
  const [date, setDate] = useState(isoToThai(todayIso()));
  const [partyCode, setPartyCode] = useState('');
  const [service, setService] = useState<boolean | null>(null); // null = ตามรายการแรกที่เลือกจากสินค้า
  const [priceMode, setPriceMode] = useState<'exclusive' | 'inclusive'>('exclusive');
  const [creditDays, setCreditDays] = useState<string | null>(null); // null = ตามลูกค้า
  const [cashAccount, setCashAccount] = useState(form.cashAccounts[0]?.code ?? '1110');
  const [discount, setDiscount] = useState('');
  const [description, setDescription] = useState('');
  const [reason, setReason] = useState('');
  const [lines, setLines] = useState<Line[]>(() => [blank()]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idem = useRef(crypto.randomUUID()); // คีย์เดิมจนผ่านรายการสำเร็จ กดซ้ำ/เน็ตหลุดไม่ออกใบซ้ำ

  const party = isNote ? null : form.customers.find((c) => c.code === partyCode) ?? null;

  const update = (key: number, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const addLine = useCallback(() => setLines((ls) => [...ls, blank()]), []);

  // ใบลด/เพิ่มหนี้ใช้แบบราคา อัตราภาษี และสินค้า/บริการตามใบที่อ้าง
  const mode: PriceMode = isNote ? refDoc!.priceMode : co.vatRegistered ? priceMode : 'none';
  const rate = isNote ? refDoc!.vatRate : co.vatRegistered ? co.vatRate : '0';
  const firstItem = lines.map((l) => itemsByCode.get(l.itemCode)).find(Boolean);
  const isService = isNote ? refDoc!.isService : service ?? firstItem?.isService ?? false;
  const isTax = co.vatRegistered && (kind === 'cash-sale' || !isService);

  // ยอดเป็นสตางค์ BigInt และเหตุที่ยังผ่านรายการไม่ได้ (บอกเสมอ ปุ่มเทาเฉย ๆ ผู้เรียนแก้ไม่ถูก)
  const calc = useMemo(() => {
    let gross = 0n, filled = 0;
    const problems = new Map<number, string>();
    const amounts = new Map<number, bigint>();
    lines.forEach((l, i) => {
      if (!l.description.trim() && !l.unitPrice.trim() && !l.itemCode) return; // บรรทัดว่างไม่นับ ไม่ส่ง
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

  const isoDate = thaiToIso(date);
  const days = creditDays === null ? party?.creditDays ?? 0 : Number(creditDays);
  const daysBad = (creditDays !== null && !/^\d{1,3}$/.test(creditDays)) || days > 365;
  const credit = kind === 'invoice' || kind === 'debit-note';
  const dueDays = isNote ? refDoc!.creditDays ?? 0 : days;
  const overOpen = kind === 'credit-note' && calc.total > (toCents(refDoc!.open ?? '0') ?? 0n);

  // เหตุแรกของแต่ละขั้น (มือถือกดถัดไปไม่ได้จนแก้ขั้นนั้นครบ)
  const stepProblem = [
    isoDate === null ? th.sales.dateInvalid
      : isNote ? (!reason.trim() ? th.sales.reasonRequired : null)
      : !party ? th.sales.customerRequired : null,
    [...calc.problems.values()][0] ?? (calc.filled === 0 || calc.gross === 0n ? th.sales.noLines : null),
    calc.discBad ? th.sales.discountInvalid
      : daysBad ? th.sales.creditDaysInvalid
      : overOpen ? th.sales.overOpen(formatMoney(refDoc!.open ?? '0'))
      : isTax && !co.taxId ? th.sales.needCompanyTaxId : null,
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
        date: isoDate,
        ...(isNote ? { refDocumentId: refDoc!.id, reason: reason.trim() } : { partyCode, isService }),
        ...(!isNote && co.vatRegistered ? { priceMode } : {}),
        ...(calc.disc > 0n ? { discount: fromCents(calc.disc) } : {}),
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(kind === 'invoice' && creditDays !== null ? { creditDays: days } : {}),
        ...(kind === 'cash-sale' ? { cashAccount } : {}),
        lines: lines.filter((l) => calc.amounts.has(l.key)).map((l) => ({
          ...(l.itemCode ? { itemCode: l.itemCode } : {}),
          description: l.description.trim(), qty: l.qty.trim(), unitPrice: fromCents(toCents(l.unitPrice)!),
          ...(l.unit.trim() ? { unit: l.unit.trim() } : {}),
        })),
      };
      const r = await postJson<{ id: string; docNo: string }>(`/companies/${companyId}/sales/${kind}`, body, { 'idempotency-key': idem.current });
      router.push(`/c/${companyId}/sales/documents/${r.id}`);
    } catch (e) {
      const err = e as ApiError;
      setError(err.code === 'server' ? th.error.server(err.ref ?? '-') : err.message);
      setBusy(false);
    }
  }, [canPost, isoDate, isNote, refDoc, reason, partyCode, isService, co.vatRegistered, priceMode, calc, description, kind, creditDays, days, cashAccount, lines, companyId, router]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F9') { e.preventDefault(); void submit(); }
      if (e.key === 'Insert') { e.preventDefault(); addLine(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [submit, addLine]);

  const target = isNote ? refDoc! : null;
  const paper: Paper = {
    kind: ({ invoice: 'sales_invoice', 'cash-sale': 'cash_sale', 'credit-note': 'credit_note', 'debit-note': 'debit_note' } as const)[kind],
    isTaxInvoice: isTax,
    seller: { name: co.name, taxId: co.taxId, branchNo: co.branchNo, address: co.address },
    party: target ? { name: target.partyName, taxId: target.partyTaxId, branchNo: target.partyBranchNo, address: target.partyAddress }
      : party ? { name: party.name, taxId: party.taxId, branchNo: party.branchNo, address: party.address } : null,
    docNo: null, date: isoDate,
    dueDate: credit && isoDate ? addDays(isoDate, dueDays) : null,
    refDocNo: target?.docNo ?? null, reason: isNote ? reason : null,
    lines: lines.filter((l) => calc.amounts.has(l.key)).map((l) => ({
      description: l.description, qty: l.qty, unit: l.unit || itemsByCode.get(l.itemCode)?.unit || '',
      unitPrice: fromCents(toCents(l.unitPrice) ?? 0n), amount: fromCents(calc.amounts.get(l.key)!),
    })),
    gross: fromCents(calc.gross), discount: fromCents(calc.disc), base: fromCents(calc.base), vat: fromCents(calc.vat),
    total: fromCents(calc.total), vatRate: rate, priceMode: mode, whtAmount: '0',
  };

  const steps = isNote ? [th.sales.ref, ...th.sales.steps.slice(1)] : th.sales.steps;
  const sec = (n: number) => `flex flex-col gap-4 ${step === n ? '' : 'max-sm:hidden'}`;
  const h2 = 'border-b border-rule-strong pb-1.5 font-doc text-[17px] font-bold';
  const inputCls = 'h-11 w-full border-b border-rule-input bg-transparent px-0.5 text-base';

  return (
    <form className="flex min-h-full flex-col" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      {co.locked && <p role="status" className="mx-3 mt-3 border border-rule-strong bg-band px-4 py-2.5 sm:mx-5">{th.submission.lockedNote}</p>}
      {!co.canWrite && <p className="mx-3 mt-3 text-sm text-ink2 sm:mx-5">{th.sales.readOnly}</p>}

      <div className="grid gap-5 p-3 sm:grid-cols-[minmax(0,470px)_minmax(0,1fr)] sm:p-5">
        <div className={`flex flex-col gap-5 ${paperOpen ? 'max-sm:hidden' : ''}`}>
          <div className="border-b-2 border-ink pb-2.5">
            <h1 className="font-doc text-[19px] font-bold sm:text-2xl">{th.sales.formTitle[kind]}</h1>
            <div className="mt-2.5 grid grid-cols-4 gap-1 sm:hidden" aria-hidden>
              {steps.map((s, i) => <span key={s} className={`h-1 ${i <= step ? 'bg-ink' : 'bg-rule'}`} />)}
            </div>
            <p className="mt-1.5 text-sm text-ink2 sm:hidden">{th.invoice.step(step + 1, 4, steps[step]!)}</p>
          </div>

          {/* ขั้น 1: ลูกค้า (หรือใบที่อ้างถึง) และวันที่ */}
          <section className={sec(0)} aria-label={steps[0]}>
            <h2 className={h2}>{steps[0]}</h2>
            {target ? (
              <>
                <p className="border border-rule-input px-3 py-2">
                  {th.sales.refInfo(target.docNo, formatMoney(target.total), formatMoney(target.open ?? '0'))}
                  <br /><span className="text-ink2">{target.partyName}</span>
                </p>
                <label className="flex flex-col text-sm">
                  {th.sales.reason}
                  <input className={inputCls} value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} aria-invalid={!reason.trim()} />
                </label>
              </>
            ) : (
              <PartyPicker parties={form.customers} selected={party} label={th.sales.customer} hint={th.sales.customerSearch} none={th.sales.customerNone}
                onPick={(c) => { setPartyCode(c.code); setCreditDays(null); }} onClear={() => { setPartyCode(''); setCreditDays(null); }} />
            )}
            <label className="flex flex-col text-sm">
              {th.sales.date}
              <input className={`${inputCls} font-num`} inputMode="numeric" value={date} onChange={(e) => setDate(e.target.value)} aria-invalid={isoDate === null} />
            </label>
          </section>

          {/* ขั้น 2: รายการ */}
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
            {kind === 'invoice' && isService && co.vatRegistered && <p className="text-sm text-ink2">{th.sales.serviceNote}</p>}
            <ol className="flex flex-col gap-3">
              {lines.map((l, i) => {
                const amt = calc.amounts.get(l.key);
                const problem = calc.problems.get(l.key);
                return (
                  <li key={l.key} className="flex flex-col gap-2 border border-rule px-3 pt-1 pb-3">
                    <ItemField items={form.items} value={l.description} picked={Boolean(l.itemCode)} label={`${th.sales.description} ${i + 1}`} price={(it) => it.salePrice}
                      onText={(text) => update(l.key, { description: text, itemCode: l.itemCode && itemsByCode.get(l.itemCode)?.name === text ? l.itemCode : '' })}
                      onPick={(it) => update(l.key, { itemCode: it.code, description: it.name, unit: it.unit, unitPrice: it.salePrice ?? l.unitPrice })} />
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

          {/* ขั้น 3: ตรวจยอดและภาษี */}
          <section className={sec(2)} aria-label={steps[2]}>
            <h2 className={h2}>{steps[2]}</h2>
            {!co.vatRegistered && <p className="text-sm text-ink2">{th.sales.noVat}</p>}
            {!isNote && co.vatRegistered && (
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
                  <input inputMode="numeric" className={`${inputCls} num`} value={creditDays ?? String(party?.creditDays ?? 0)} onChange={(e) => setCreditDays(e.target.value)} aria-invalid={daysBad} />
                </label>
              )}
              {kind === 'cash-sale' && (
                <label className="flex flex-col text-sm">
                  {th.sales.cashAccount}
                  <select className={inputCls} value={cashAccount} onChange={(e) => setCashAccount(e.target.value)}>
                    {form.cashAccounts.map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}
                  </select>
                </label>
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
            </dl>
          </section>

          {/* ขั้น 4 (มือถือ): ตรวจกระดาษแล้วผ่านรายการ */}
          <section className={`${sec(3)} sm:hidden`} aria-label={steps[3]}>
            <h2 className={h2}>{steps[3]}</h2>
            <p className="text-sm">{th.sales.review}</p>
            <DocumentPaper p={paper} />
          </section>

          {step < 3 && (
            <button type="button" className="min-h-12 border border-dashed border-ink2 text-ink2 sm:hidden" onClick={() => setPaperOpen(true)}>
              {th.sales.preview}
            </button>
          )}
        </div>

        {/* กระดาษตัวอย่าง: จอใหญ่อยู่ขวาเสมอ มือถือเปิดจากปุ่ม */}
        <div className={`flex flex-col gap-2 ${paperOpen ? '' : 'max-sm:hidden'}`}>
          <p className="text-sm text-ink2">{th.sales.previewNote}</p>
          <DocumentPaper p={paper} className="sm:sticky sm:top-4" />
          <Button type="button" variant="secondary" className="sm:hidden" onClick={() => setPaperOpen(false)}>{th.sales.backToForm}</Button>
        </div>
      </div>

      <footer className="sticky bottom-0 mt-auto flex flex-col gap-2.5 border-t border-rule-strong bg-paper px-4 py-2.5 sm:flex-row sm:items-center sm:gap-6 sm:px-6">
        <dl className="flex justify-between gap-3 text-[15px] sm:gap-5">
          <dt>{mode === 'none' ? th.sales.total : th.sales.base}</dt>
          <dd className="num font-semibold">{money(mode === 'none' ? calc.total : calc.base)}</dd>
          {mode !== 'none' && <><dt className="max-sm:hidden">{th.sales.total}</dt><dd className="num font-semibold max-sm:hidden">{money(calc.total)}</dd></>}
        </dl>
        {/* เหตุที่ยังไปต่อ/ผ่านรายการไม่ได้: มือถือบอกของขั้นปัจจุบัน จอใหญ่บอกเหตุแรกของทั้งใบ */}
        <p role="alert" className={`text-sm sm:hidden ${error ? 'neg' : 'text-ink2'}`}>{error ?? (busy ? th.sales.posting : step < 3 ? stepProblem[step] : blocked)}</p>
        <p role="alert" className={`text-sm max-sm:hidden ${error ? 'neg' : 'text-ink2'}`}>{error ?? (busy ? th.sales.posting : blocked)}</p>
        <div className="grid grid-cols-2 gap-3 sm:hidden">
          <Button type="button" variant="secondary" disabled={step === 0} onClick={() => setStep((s) => s - 1)}>{th.sales.prev}</Button>
          {/* key ต่างกัน: ถ้า React ใช้ปุ่มเดิมแล้วเปลี่ยนเป็น submit ระหว่างคลิก เบราว์เซอร์จะส่งฟอร์ม (ผ่านรายการเองโดยไม่ได้กด) */}
          {step < 3
            ? <Button key="next" type="button" disabled={Boolean(stepProblem[step])} onClick={() => { setStep((s) => s + 1); setPaperOpen(false); window.scrollTo(0, 0); }}>{th.sales.next(steps[step + 1]!)}</Button>
            : <Button key="post" type="submit" disabled={!canPost}>{th.sales.post}</Button>}
        </div>
        <Button type="submit" shortcut="F9" disabled={!canPost} className="max-sm:hidden sm:ml-auto">{th.sales.post}</Button>
      </footer>
    </form>
  );
}
