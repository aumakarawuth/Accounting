'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/Button';
import { SelectField, TextField } from '@/components/Fields';
import { postJson, type ApiError, type InventoryItem } from '@/lib/api';
import { isoToThai, thaiToIso, todayIso, maskDate } from '@/lib/date';
import { th } from '@/i18n/th';

const t = th.inventory;
const QTY = /^-?\d{1,11}(\.\d{1,3})?$/;
const COST = /^\d{1,12}(\.\d{1,6})?$/;

// ปรับสต็อก: คีย์ idempotency คงเดิมจนสำเร็จ (กดซ้ำ/เน็ตหลุดแล้วส่งใหม่ไม่เกิดรายการซ้ำ)
export function InventoryAdjust({ companyId, items, accounts, initialItem, warehouses }: {
  companyId: string; items: InventoryItem[]; accounts: { code: string; name: string }[]; initialItem?: string;
  warehouses: { code: string; name: string }[];
}) {
  const router = useRouter();
  const [itemCode, setItemCode] = useState(initialItem ?? items[0]?.code ?? '');
  const [date, setDate] = useState(isoToThai(todayIso()));
  const [quantity, setQuantity] = useState('');
  const [unitCost, setUnitCost] = useState('');
  const [offset, setOffset] = useState('');
  const [description, setDescription] = useState('');
  const [warehouse, setWarehouse] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const key = useRef(crypto.randomUUID());
  const iso = thaiToIso(date);
  const out = quantity.trim().startsWith('-');
  const valid = Boolean(itemCode && iso && QTY.test(quantity.trim()) && Number(quantity) !== 0 && offset && (out || COST.test(unitCost.trim())));

  async function submit() {
    if (busy) return;
    if (!valid) { setMsg({ ok: false, text: t.invalid }); return; }
    if (!navigator.onLine) { setMsg({ ok: false, text: th.error.offline }); return; }
    setBusy(true);
    setMsg(null);
    try {
      const r = await postJson<{ docNo: string }>(`/companies/${companyId}/inventory/adjustments`, {
        itemCode, date: iso, quantity: quantity.trim(), ...(out ? {} : { unitCost: unitCost.trim() }), offsetAccount: offset,
        ...(description.trim() ? { description: description.trim() } : {}), ...(warehouse ? { warehouse } : {}),
      }, { 'idempotency-key': key.current });
      key.current = crypto.randomUUID();
      setQuantity(''); setUnitCost(''); setDescription('');
      setMsg({ ok: true, text: t.saved(r.docNo) });
      router.refresh();
    } catch (e) {
      const err = e as ApiError;
      setMsg({ ok: false, text: err.code === 'server' ? th.error.server(err.ref ?? '-') : err.message });
      if (err.code === 'ACC03') key.current = crypto.randomUUID();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="flex flex-col gap-4 border border-rule-strong bg-paper p-4 sm:p-6" aria-label={t.adjust}
      onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <h2 className="text-[17px] font-semibold">{t.adjust}</h2>
      <p className="text-sm text-ink2">{t.adjustExplain}</p>
      <div className="grid gap-4 sm:grid-cols-2 sm:gap-6">
        <SelectField label={t.item} value={itemCode} onChange={setItemCode}>
          {items.map((i) => <option key={i.code} value={i.code}>{i.code} {i.name}</option>)}
        </SelectField>
        <TextField label={t.date} value={date} onChange={(v) => setDate(maskDate(v))} inputMode="numeric" mono />
        <TextField label={t.qty} value={quantity} onChange={setQuantity} inputMode="text" mono />
        {!out && <TextField label={t.unitCost} value={unitCost} onChange={setUnitCost} inputMode="decimal" mono />}
        <SelectField label={t.offset} value={offset} onChange={setOffset}>
          <option value="">{t.chooseOffset}</option>
          {accounts.map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}
        </SelectField>
        <TextField label={t.description} value={description} onChange={setDescription} maxLength={300} />
        {warehouses.length > 1 && (
          <SelectField label={t.warehouse} value={warehouse} onChange={setWarehouse}>
            {warehouses.map((w, i) => <option key={w.code} value={i === 0 ? '' : w.code}>{w.code} {w.name}</option>)}
          </SelectField>
        )}
      </div>
      <p className="text-[13px] text-ink2">{t.offsetHint}</p>
      {msg && <p role={msg.ok ? 'status' : 'alert'} className={msg.ok ? 'text-[15px]' : 'neg text-[15px]'}>{msg.text}</p>}
      <div><Button type="submit" disabled={busy} className="max-sm:w-full">{busy ? t.saving : t.save}</Button></div>
    </form>
  );
}
