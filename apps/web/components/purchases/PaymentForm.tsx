'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/Button';
import { api, postJson, type ApiError, type ChequeRow, type PurchaseFormData, type PurchaseRow, type WhtKind } from '@/lib/api';
import { formatMoney, fromCents, toCents } from '@/lib/money';
import { isoToThai, thaiToIso, todayIso, maskDate } from '@/lib/date';
import { rateHundredths } from '@/lib/vat';
import { whtFor, type EntryLine } from '@/lib/entry-preview';
import { DraftBanner, EntryPreview, PartyPicker, liveLines } from '@/components/docs/parts';
import { useDocDraft } from '@/components/docs/useDocDraft';
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
  const [discounts, setDiscounts] = useState<Record<string, string>>({}); // documentId → ส่วนลดเงินสดที่ได้รับ
  const [date, setDate] = useState(isoToThai(todayIso()));
  const [cashAccount, setCashAccount] = useState(form.cashAccounts[0]?.code ?? '1110');
  const [whtKind, setWhtKind] = useState<WhtKind | '' | null>(null); // null = ตามที่ตั้งไว้ที่ผู้ขาย
  const [whtRate, setWhtRate] = useState<string | null>(null);
  // จ่ายเป็นเช็ค: ใบสำคัญจ่ายลงเช็คจ่าย (2120/2121) แล้วลงทะเบียนเช็คพร้อมกัน เงินออกจากบัญชีที่สั่งจ่ายเมื่อเช็คผ่าน
  const [byCheque, setByCheque] = useState(false);
  const [chequeNo, setChequeNo] = useState('');
  const [chequeBank, setChequeBank] = useState('');
  const [chequeDate, setChequeDate] = useState(isoToThai(todayIso()));
  const bankAccounts = form.cashAccounts.filter((a) => a.code !== '1110' && a.code !== '1140');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [idemKey, setIdemKey] = useState(() => crypto.randomUUID()); // คีย์เดิมจนบันทึกสำเร็จ กดซ้ำ/เน็ตหลุดไม่ออกใบซ้ำ
  const vendor = form.vendors.find((v) => v.code === partyCode) ?? null;

  // ใบค้างของผู้ขาย (เก่าสุดก่อน) พร้อมภาษีซื้อบริการที่ยังไม่ถึงกำหนด · ใบที่ส่งมาจากหน้าเอกสารเลือกไว้ให้เต็มยอด
  useEffect(() => {
    if (!partyCode) return;
    let alive = true;
    void api<PurchaseRow[]>(`/companies/${companyId}/purchases?party=${encodeURIComponent(partyCode)}`).then((rows) => {
      if (!alive) return;
      // ใบซื้อเชื่อและใบเพิ่มหนี้ที่ยังค้าง
      const items = rows.filter((r) => (r.kind === 'purchase_invoice' || r.kind === 'purchase_debit_note') && r.open !== null && Number(r.open) > 0).reverse().map((r) => ({ ...r, undue: toCents(r.undueVat ?? '0') ?? 0n }));
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

  const wKind = whtKind ?? vendor?.whtKind ?? '';
  const wRate = whtRate ?? (wKind && wKind === vendor?.whtKind && vendor.whtRate ? String(Number(vendor.whtRate)) : STANDARD[wKind] ?? '');
  const wRateOk = !wKind || (RATE.test(wRate) && Number(wRate) > 0 && Number(wRate) <= 15);

  const calc = useMemo(() => {
    let total = 0n, vat = 0n, disc = 0n, dvat = 0n, gross = 0n, bad: string | null = null;
    const parts: { amount: bigint; base: bigint; total: bigint }[] = [];
    for (const r of open ?? []) {
      if (!(r.id in amounts)) continue;
      const a = toCents(amounts[r.id]!);
      const d = (discounts[r.id] ?? '').trim() ? toCents(discounts[r.id]!) : 0n;
      const max = toCents(r.open!)!;
      if (a === null || d === null || a <= 0n || d < 0n || a + d > max) { bad ??= th.purchases.payInvalid(r.docNo); continue; }
      const settle = a + d;
      total += a; disc += d; gross += settle;
      // ภาษีซื้อบริการ (สูตรเดียวกับ acc.post_payment): ส่วนที่จ่ายเงินถึงกำหนด ส่วนลดล้างออก
      if (r.undue > 0n) {
        const tr = settle === max ? r.undue : divRound(settle * r.undue, max);
        const dv = divRound(d * r.undue, max);
        vat += tr - dv; dvat += dv;
      }
      parts.push({ amount: a, base: toCents(r.base)!, total: toCents(r.total)! }); // ฐานหัก ณ ที่จ่ายจากเงินที่จ่ายจริง
    }
    const wht = wKind && wRateOk ? whtFor(parts, rateHundredths(wRate)) : { base: 0n, amount: 0n };
    return { total, vat, disc, dvat, gross, bad, wht };
  }, [open, amounts, discounts, wKind, wRate, wRateOk]);
  // ใส่ส่วนลดตอนยอดจ่ายยังเต็มยอดค้าง: ลดยอดจ่ายให้เท่าส่วนที่เหลือ
  const setDiscount = (r: { id: string; open: string | null }, v: string) => {
    const max = toCents(r.open!)!, prev = toCents(discounts[r.id] || '0') ?? 0n, next = toCents(v || '0');
    setDiscounts((x) => ({ ...x, [r.id]: v }));
    if (next !== null && next >= 0n && next < max && toCents(amounts[r.id] ?? '') === max - prev) setAmounts((x) => ({ ...x, [r.id]: fromCents(max - next) }));
  };

  const isoChequeDate = thaiToIso(chequeDate);
  const draftIso = thaiToIso(date);
  const payCode = byCheque ? (isoChequeDate && draftIso && isoChequeDate > draftIso ? '2121' : '2120') : cashAccount;
  const chequeBad = !byCheque ? null : !bankAccounts.some((a) => a.code === cashAccount) ? th.cheques.invalid.bankAccount
    : !/^[0-9A-Za-z-]{1,20}$/.test(chequeNo) ? th.cheques.invalid.chequeNo
    : chequeBank.trim() === '' ? th.cheques.invalid.bank : isoChequeDate === null ? th.cheques.invalid.date : null;
  const entry: EntryLine[] = [
    { code: '2110', debit: calc.gross, credit: 0n },
    ...(calc.vat > 0n ? [{ code: '1410', debit: calc.vat, credit: 0n }] : []),
    { code: payCode, debit: 0n, credit: calc.total - calc.wht.amount },
    ...(calc.wht.amount > 0n ? [{ code: '2230', debit: 0n, credit: calc.wht.amount }] : []),
    ...(calc.vat + calc.dvat > 0n ? [{ code: '1411', debit: 0n, credit: calc.vat + calc.dvat }] : []),
    ...(calc.disc - calc.dvat > 0n ? [{ code: '5120', debit: 0n, credit: calc.disc - calc.dvat }] : []),
  ];

  const isoDate = thaiToIso(date);
  const blocked = !vendor ? th.purchases.vendorRequired
    : calc.bad ?? (calc.total === 0n ? th.purchases.selectOne : isoDate === null ? th.sales.dateInvalid
      : wKind && !vendor.taxId ? th.purchases.whtNeedsTaxId
      : !wRateOk ? th.purchases.whtRateInvalid
      : wKind && calc.wht.amount === 0n ? th.purchases.whtTooSmall : chequeBad);
  const canPost = writable && !busy && !blocked;

  // ร่างในเครื่อง + ครูดูสด
  const draft = useDocDraft(writable ? 'payment' : null, companyId, { partyCode, amounts, discounts, date, cashAccount, whtKind, whtRate, idemKey, byCheque, chequeNo, chequeBank, chequeDate }, {
    isEmpty: (d) => !d.partyCode,
    restore: (d) => {
      if (initialParty && d.partyCode !== initialParty) return false; // เปิดจากหน้าเอกสารของผู้ขายรายอื่น: ไม่ทับด้วยร่างเก่า
      setPartyCode(d.partyCode); setAmounts(d.amounts); setDiscounts(d.discounts ?? {}); setDate(d.date); setCashAccount(d.cashAccount);
      setWhtKind(d.whtKind); setWhtRate(d.whtRate); setIdemKey(d.idemKey);
      setByCheque(d.byCheque ?? false); setChequeNo(d.chequeNo ?? ''); setChequeBank(d.chequeBank ?? ''); if (d.chequeDate) setChequeDate(d.chequeDate);
    },
    live: calc.total > 0n ? { title: th.purchases.paymentTitle, date: isoDate ?? date, description: vendor?.name ?? '', lines: liveLines(entry) } : null,
  });
  const discardDraft = () => {
    setPartyCode(''); setOpen(null); setAmounts({}); setDiscounts({}); setWhtKind(null); setWhtRate(null);
    setIdemKey(crypto.randomUUID());
    draft.discard();
  };

  // ไม่ห่อ useCallback: React Compiler จัดการ memo เอง (มือห่อแล้ว compiler ข้ามทั้งคอมโพเนนต์)
  const submit = async () => {
    if (!canPost || !isoDate || !open) return;
    if (!navigator.onLine) { setError(th.error.offline); return; }
    setBusy(true);
    setError(null);
    try {
      const payment = {
        partyCode, ...(wKind ? { whtKind: wKind, whtRate: wRate } : {}),
        allocations: open.filter((x) => x.id in amounts).map((x) => ({
          documentId: x.id, amount: fromCents(toCents(amounts[x.id]!)!),
          ...((discounts[x.id] ?? '').trim() && toCents(discounts[x.id]!)! > 0n ? { discount: fromCents(toCents(discounts[x.id]!)!) } : {}),
        })),
      };
      const id = byCheque
        ? (await postJson<ChequeRow>(`/companies/${companyId}/cheques`, {
            direction: 'paid', chequeNo, bankName: chequeBank.trim(), chequeDate: isoChequeDate, date: isoDate, bankAccount: cashAccount, payment,
          }, { 'idempotency-key': idemKey })).documentId!
        : (await postJson<{ id: string }>(`/companies/${companyId}/payments`, { date: isoDate, cashAccount, ...payment }, { 'idempotency-key': idemKey })).id;
      draft.finish();
      router.push(`/c/${companyId}/purchases/documents/${id}`);
    } catch (e) {
      const err = e as ApiError;
      setError(err.code === 'server' ? th.error.server(err.ref ?? '-') : err.message);
      setBusy(false);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'F9') { e.preventDefault(); void submit(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }); // ผูกใหม่ทุกครั้งที่ render ให้ F9 ใช้ค่าล่าสุดเสมอ

  const inputCls = 'h-11 w-full border-b border-rule-input bg-transparent px-0.5 text-base';
  const h2 = 'border-b border-rule-strong pb-1.5 font-doc text-[17px] font-bold';

  return (
    <form className="flex min-h-full flex-col" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      {co.locked && <p role="status" className="mx-3 mt-3 border border-rule-strong bg-band px-4 py-2.5 sm:mx-5">{th.submission.lockedNote}</p>}
      {!co.canWrite && <p className="mx-3 mt-3 text-sm text-ink2 sm:mx-5">{th.purchases.readOnly}</p>}
      <DraftBanner restoredAt={draft.restoredAt} onDiscard={discardDraft} />
      <div className="grid gap-5 p-3 sm:p-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,420px)]">
        <div className="flex flex-col gap-5">
          <h1 className="border-b-2 border-ink pb-2.5 font-doc text-[19px] font-bold sm:text-2xl">{th.purchases.paymentTitle}</h1>

          <section className="flex flex-col gap-4" aria-label={th.purchases.vendor}>
            <h2 className={h2}>{th.purchases.vendor}</h2>
            <PartyPicker parties={form.vendors} selected={vendor} label={th.purchases.vendor} hint={th.purchases.vendorSearch} none={th.purchases.vendorNone}
              extra={(v) => (v.whtKind ? th.parties.whtKinds[v.whtKind] ?? null : null)}
              onPick={(v) => { setOpen(null); setAmounts({}); setDiscounts({}); setPartyCode(v.code); setWhtKind(null); setWhtRate(null); }}
              onClear={() => { setPartyCode(''); setOpen(null); setAmounts({}); setDiscounts({}); }} />
          </section>

          {vendor && (
            <section className="flex flex-col gap-3" aria-label={th.purchases.openItems}>
              <h2 className={h2}>{th.purchases.openItems}</h2>
              <p className="text-sm text-ink2">{th.purchases.cashDiscountNote}</p>
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
              <label className="flex flex-col text-sm">
                {byCheque ? th.cheques.bankAccount : th.purchases.cashAccount}
                <select className={inputCls} value={cashAccount} onChange={(e) => setCashAccount(e.target.value)}>
                  {(byCheque ? bankAccounts : form.cashAccounts).map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}
                </select>
              </label>
              <label className="col-span-2 flex min-h-11 items-center gap-3 text-[15px]">
                <input type="checkbox" className="size-5 shrink-0 text-base accent-ink" checked={byCheque}
                  onChange={(e) => { setByCheque(e.target.checked); if (e.target.checked && !bankAccounts.some((a) => a.code === cashAccount)) setCashAccount(bankAccounts[0]?.code ?? cashAccount); }} />
                {th.cheques.byCheque.paid}
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
                  <label className="flex flex-col text-sm">
                    {th.cheques.chequeDate}
                    <input className={`${inputCls} font-num`} inputMode="numeric" value={chequeDate} onChange={(e) => setChequeDate(maskDate(e.target.value))} aria-invalid={isoChequeDate === null} />
                  </label>
                  <p className="col-span-2 text-[13px] text-ink2">{th.cheques.byChequeNote.paid}</p>
                </>
              )}
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
              {calc.disc > 0n && <><dt className="py-1">{th.sales.settledTotal}</dt><dd className="num py-1">{money(calc.gross)}</dd>
                <dt className="py-1">{th.sales.cashDiscountTotal}</dt><dd className="num py-1">{money(calc.disc)}</dd></>}
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
