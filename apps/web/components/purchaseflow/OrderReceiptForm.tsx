'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/Button';
import { DateInput, PlainInput } from '@/components/ConfirmPanel';
import { EntryPreview } from '@/components/docs/parts';
import { api, postJson, type ApiError, type PurchaseFormData, type PurchaseOrderDetail, type PurchaseOrderRow } from '@/lib/api';
import { isoToThai, thaiToIso, todayIso } from '@/lib/date';
import { formatMoney, fromCents, toCents } from '@/lib/money';
import { lineAmount, vatCalc } from '@/lib/vat';
import { th } from '@/i18n/th';

// ใบสั่งซื้อ (ไม่ลงบัญชี) และใบรับสินค้า (ลง ซื้อสินค้า / 2130) ฟอร์มหน้าเดียว ยอดคิดสูตรเดียวกับ DB แล้ว DB ตรวจซ้ำ
// mode=receipt + order: รับสินค้าตามใบสั่งซื้อ ดึงจำนวนที่ยังไม่ได้รับมาให้
type Line = { key: number; itemCode: string; qty: string; unitPrice: string; orderLineNo?: number };
let seq = 0;
const blank = (): Line => ({ key: ++seq, itemCode: '', qty: '1', unitPrice: '' });
const QTY = /^\d{1,11}(\.\d{1,3})?$/;
const field = 'h-11 w-full border-b border-rule-input bg-transparent text-base';

export function OrderReceiptForm({ companyId, mode, form, order }: {
  companyId: string; mode: 'order' | 'receipt'; form: PurchaseFormData; order: PurchaseOrderDetail | null;
}) {
  const router = useRouter();
  const co = form.company;
  const isReceipt = mode === 'receipt';
  const items = useMemo(() => form.items.filter((i) => !isReceipt || !i.isService), [form.items, isReceipt]);
  const byCode = useMemo(() => new Map(form.items.map((i) => [i.code, i])), [form.items]);
  const fromOrder = (o: PurchaseOrderDetail): Line[] => o.lines.flatMap((l) => {
    const left = Math.round((Number(l.qty) - Number(l.received)) * 1000) / 1000;
    return left > 0 && l.itemCode && !l.isService ? [{ key: ++seq, itemCode: l.itemCode, qty: String(left), unitPrice: l.unitPrice, orderLineNo: l.lineNo }] : [];
  });

  const [partyCode, setPartyCode] = useState(order?.partyCode ?? '');
  const [orderState, setOrderState] = useState<{ party: string; rows: PurchaseOrderRow[] }>({ party: order?.partyCode ?? '', rows: order ? [order] : [] });
  const [date, setDate] = useState(isoToThai(todayIso()));
  const [until, setUntil] = useState('');
  const [vendorDocNo, setVendorDocNo] = useState('');
  const [mode2, setPriceMode] = useState<'exclusive' | 'inclusive'>('exclusive');
  const [discount, setDiscount] = useState('');
  const [lines, setLines] = useState<Line[]>(() => (order ? fromOrder(order) : []).concat(order ? [] : [blank()]));
  const [picked, setPicked] = useState(order?.id ?? ''); // ใบสั่งซื้อที่อ้าง (ใบรับสินค้า)
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [key] = useState(() => crypto.randomUUID());

  // ใบรับสินค้า: ใบสั่งซื้อที่ยังรับไม่ครบของผู้ขายรายนี้ (เลือกอ้างได้)
  useEffect(() => {
    if (!isReceipt || !partyCode || order) return;
    let live = true;
    api<PurchaseOrderRow[]>(`/companies/${companyId}/purchase-orders?party=${encodeURIComponent(partyCode)}`).then(
      (rows) => { if (live) setOrderState({ party: partyCode, rows: rows.filter((r) => r.status === 'open' || r.status === 'partial') }); }, () => {});
    return () => { live = false; };
  }, [isReceipt, partyCode, companyId, order]);
  const orders = orderState.party === partyCode ? orderState.rows : [];

  const vendor = form.vendors.find((v) => v.code === partyCode) ?? null;
  const vatMode = isReceipt || (vendor && !vendor.vatRegistered) ? 'none' : mode2;
  const first = lines.map((l) => byCode.get(l.itemCode)).find(Boolean);
  const isService = !isReceipt && (first?.isService ?? false);
  const calc = useMemo(() => {
    let gross = 0n;
    const amounts = new Map<number, bigint>();
    let problem: string | null = null;
    lines.forEach((l, i) => {
      const it = byCode.get(l.itemCode);
      const price = toCents(l.unitPrice);
      const amt = price === null ? null : lineAmount(l.qty, price);
      if (!it || amt === null || !QTY.test(l.qty.trim()) || Number(l.qty) <= 0 || price === null || (isReceipt ? price <= 0n : price < 0n)) {
        problem ??= th.goodsReceipts.lineInvalid(i + 1);
      } else if (it.isService !== isService) {
        problem ??= th.sales.lineMixed(i + 1);
      }
      if (amt !== null) { gross += amt; amounts.set(l.key, amt); }
    });
    const disc = isReceipt ? 0n : toCents(discount);
    const discBad = disc === null || (disc > 0n && disc >= gross);
    return { gross, amounts, problem, discBad, ...vatCalc(gross, discBad ? 0n : disc!, isReceipt ? '0' : co.vatRate, vatMode) };
  }, [lines, byCode, isReceipt, isService, discount, co.vatRate, vatMode]);

  const iso = thaiToIso(date);
  const untilIso = until.trim() ? thaiToIso(until) : null;
  const untilBad = until.trim() !== '' && (untilIso === null || (iso !== null && untilIso < iso));
  const problem = !vendor ? th.purchases.vendorRequired
    : iso === null ? th.sales.dateInvalid
    : isReceipt && !vendorDocNo.trim() ? th.purchases.vendorDocNoRequired
    : untilBad ? th.sales.untilInvalid
    : calc.problem ?? (calc.gross === 0n ? th.sales.noLines : calc.discBad ? th.sales.discountInvalid : null);
  const ready = co.canWrite && !co.locked && !problem && !busy;

  // ใบรับสินค้า: รายการบัญชีที่จะเกิด (บัญชีซื้อของสินค้า / 2130)
  const entry = useMemo(() => {
    if (!isReceipt) return [];
    const byAcc = new Map<string, bigint>();
    for (const l of lines) {
      const amt = calc.amounts.get(l.key);
      if (amt === undefined) continue;
      const acc = byCode.get(l.itemCode)?.purchaseAccount ?? '5110';
      byAcc.set(acc, (byAcc.get(acc) ?? 0n) + amt);
    }
    return [...[...byAcc].sort().map(([code, v]) => ({ code, debit: v, credit: 0n })), ...(calc.gross > 0n ? [{ code: '2130', debit: 0n, credit: calc.gross }] : [])];
  }, [isReceipt, lines, calc, byCode]);
  const names = useMemo(() => new Map([...form.expenseAccounts, ...form.systemAccounts].map((a) => [a.code, a.name])), [form]);

  const pickOrder = async (id: string) => {
    if (!id) { setLines([blank()]); return; }
    try {
      const o = await api<PurchaseOrderDetail>(`/companies/${companyId}/purchase-orders/${id}`);
      const ls = fromOrder(o);
      setLines(ls.length ? ls : [blank()]);
      setPicked(id);
    } catch (e) { setError((e as ApiError).message); }
  };
  async function save() {
    if (!ready || !iso) return;
    setBusy(true);
    setError(null);
    const body = isReceipt ? {
      date: iso, partyCode, vendorDocNo: vendorDocNo.trim(), ...(picked ? { orderId: picked } : {}),
      lines: lines.filter((l) => calc.amounts.has(l.key)).map((l) => ({
        itemCode: l.itemCode, qty: l.qty.trim(), unitPrice: fromCents(toCents(l.unitPrice)!), ...(picked && l.orderLineNo ? { orderLineNo: l.orderLineNo } : {}),
      })),
    } : {
      date: iso, partyCode, isService, ...(untilIso ? { untilDate: untilIso } : {}), ...(vatMode !== 'none' ? { priceMode: vatMode } : {}),
      ...(calc.discBad || toCents(discount) === 0n || !discount.trim() ? {} : { discount: fromCents(toCents(discount)!) }),
      lines: lines.filter((l) => calc.amounts.has(l.key)).map((l) => ({ itemCode: l.itemCode, qty: l.qty.trim(), unitPrice: fromCents(toCents(l.unitPrice)!) })),
    };
    try {
      const r = await postJson<{ id: string }>(isReceipt ? `/companies/${companyId}/purchases/goods-receipt` : `/companies/${companyId}/purchase-orders`,
        body, { 'idempotency-key': key });
      router.push(isReceipt ? `/c/${companyId}/purchases/documents/${r.id}` : `/c/${companyId}/purchases/orders/${r.id}`);
    } catch (e) {
      const err = e as ApiError;
      setError(err.code === 'server' ? th.error.server(err.ref ?? '-') : err.message);
      setBusy(false);
    }
  }

  const money = (c: bigint) => formatMoney(fromCents(c));
  return (
    <form className="grid gap-5 sm:grid-cols-[minmax(0,560px)_minmax(0,1fr)]" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <div className="flex flex-col gap-4">
        <label className="flex flex-col text-sm">
          {th.purchases.vendor}
          <select className={field} value={partyCode} disabled={Boolean(order)}
            onChange={(e) => { setPartyCode(e.target.value); setPicked(''); if (picked) setLines([blank()]); }}>
            <option value="">-</option>
            {form.vendors.map((v) => <option key={v.code} value={v.code}>{v.code} {v.name}</option>)}
          </select>
        </label>
        {isReceipt && (
          <label className="flex flex-col text-sm">
            {th.goodsReceipts.order}
            <select className={field} value={picked} disabled={Boolean(order)} onChange={(e) => void pickOrder(e.target.value)}>
              <option value="">{th.goodsReceipts.orderNone}</option>
              {(order ? [order] : orders).map((o) => <option key={o.id} value={o.id}>{o.docNo} · {formatMoney(o.total)}</option>)}
            </select>
          </label>
        )}
        {isReceipt && <PlainInput label={th.goodsReceipts.vendorDocNo} value={vendorDocNo} onChange={setVendorDocNo} mono maxLength={40} invalid={!vendorDocNo.trim()} />}
        <div className="grid grid-cols-2 gap-3">
          <DateInput label={isReceipt ? th.purchases.date : th.sales.date} value={date} onChange={setDate} invalid={iso === null} />
          {!isReceipt && <DateInput label={th.purchaseOrders.until} value={until} onChange={setUntil} invalid={untilBad} />}
        </div>
        {isReceipt && <p className="text-sm text-ink2">{th.goodsReceipts.goodsOnly}</p>}
        <ol className="flex flex-col gap-3">
          {lines.map((l, i) => {
            const it = byCode.get(l.itemCode);
            const amt = calc.amounts.get(l.key);
            return (
              <li key={l.key} className="flex flex-col gap-2 border border-rule px-3 pt-1 pb-3">
                <label className="flex flex-col text-[13px] text-ink2">
                  {th.goodsReceipts.item(i + 1)}
                  <select className={`${field} text-ink`} value={l.itemCode}
                    onChange={(e) => {
                      const next = byCode.get(e.target.value);
                      setLines((ls) => ls.map((x) => (x.key === l.key ? { ...x, itemCode: e.target.value, unitPrice: x.unitPrice || next?.purchasePrice || '' } : x)));
                    }}>
                    <option value="">{th.goodsReceipts.itemPick}</option>
                    {items.map((x) => <option key={x.code} value={x.code}>{x.code} {x.name}</option>)}
                  </select>
                </label>
                <div className="grid grid-cols-[minmax(0,0.8fr)_minmax(0,1fr)_minmax(0,1fr)] gap-3">
                  <label className="flex flex-col text-[13px] text-ink2">
                    {th.sales.qty}{it ? ` (${it.unit})` : ''}
                    <input inputMode="decimal" className={`${field} num text-ink`} value={l.qty}
                      onChange={(e) => setLines((ls) => ls.map((x) => (x.key === l.key ? { ...x, qty: e.target.value } : x)))} />
                  </label>
                  <label className="flex flex-col text-[13px] text-ink2">
                    {isReceipt ? th.goodsReceipts.unitPrice : th.sales.unitPrice}
                    <input inputMode="decimal" className={`${field} num text-ink`} value={l.unitPrice}
                      onChange={(e) => setLines((ls) => ls.map((x) => (x.key === l.key ? { ...x, unitPrice: e.target.value } : x)))} />
                  </label>
                  <div className="flex flex-col text-[13px] text-ink2">
                    {th.sales.amount}
                    <output className="num flex h-11 items-center justify-end text-base text-ink">{amt === undefined ? '—' : money(amt)}</output>
                  </div>
                </div>
                {lines.length > 1 && (
                  <button type="button" className="min-h-11 self-start text-sm text-ink2 underline" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>
                    {th.sales.removeLine} {i + 1}
                  </button>
                )}
              </li>
            );
          })}
        </ol>
        <Button type="button" variant="secondary" onClick={() => setLines((ls) => [...ls, blank()])} className="self-start max-sm:w-full">{th.sales.addLine}</Button>
        {!isReceipt && vatMode !== 'none' && (
          <fieldset className="flex flex-col text-sm">
            <legend>{th.sales.priceMode}</legend>
            {(['exclusive', 'inclusive'] as const).map((m) => (
              <label key={m} className="flex min-h-11 items-center gap-2 text-base">
                <input type="radio" name="mode" className="size-5 accent-ink" checked={mode2 === m} onChange={() => setPriceMode(m)} />{th.sales[m]}
              </label>
            ))}
          </fieldset>
        )}
        {!isReceipt && <PlainInput label={th.sales.discount} value={discount} onChange={setDiscount} inputMode="decimal" invalid={calc.discBad} />}
        <dl className="grid grid-cols-[minmax(0,1fr)_auto] text-[15px]">
          <dt className="py-1">{th.sales.subtotal}</dt><dd className="num py-1">{money(calc.gross)}</dd>
          {vatMode !== 'none' && <><dt className="py-1">{th.sales.base}</dt><dd className="num py-1">{money(calc.base)}</dd>
            <dt className="py-1">{th.sales.vat(String(Number(co.vatRate)))}</dt><dd className="num py-1">{money(calc.vat)}</dd></>}
          <dt className="border-t border-ink py-1 font-semibold">{th.sales.total}</dt>
          <dd className="num border-t border-ink py-1 font-semibold">{money(calc.total)}</dd>
        </dl>
        <p role="alert" className={`text-sm ${error ? 'neg' : 'text-ink2'}`}>{error ?? (busy ? th.purchases.posting : problem)}</p>
        <Button type="submit" disabled={!ready} className="self-start max-sm:w-full">{isReceipt ? th.goodsReceipts.save : th.purchaseOrders.save}</Button>
      </div>
      {isReceipt ? (
        <div className="flex flex-col gap-2 sm:sticky sm:top-4 sm:self-start">
          <h2 className="font-doc text-[17px] font-bold">{th.purchases.entryPreview}</h2>
          <p className="text-sm text-ink2">{th.purchases.entryNote}</p>
          <EntryPreview lines={entry} names={names} />
        </div>
      ) : <p className="text-sm text-ink2">{th.purchaseOrders.note}</p>}
    </form>
  );
}
