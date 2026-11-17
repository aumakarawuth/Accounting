'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/Button';
import { SelectField, TextField } from '@/components/Fields';
import { patchJson, postJson, type ApiError, type InventoryItem, type Warehouse } from '@/lib/api';
import { isoToThai, maskDate, thaiToIso, todayIso } from '@/lib/date';
import { th } from '@/i18n/th';

const t = th.warehouses;
const QTY = /^\d{1,11}(\.\d{1,3})?$/;
const errText = (e: unknown) => {
  const err = e as ApiError;
  return err.code === 'server' ? th.error.server(err.ref ?? '-') : err.message;
};

// รายชื่อคลัง: เพิ่ม / เปิด-ปิดใช้ (DB ตรวจว่าคลังหลักปิดไม่ได้ และคลังที่ยังมีของปิดไม่ได้)
export function WarehouseList({ companyId, warehouses, editable }: { companyId: string; warehouses: Warehouse[]; editable: boolean }) {
  const router = useRouter();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      router.refresh();
    } catch (e) {
      setMsg({ ok: false, text: errText(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-3" aria-label={t.list}>
      <h2 className="text-[17px] font-semibold">{t.list}</h2>
      <ul className="border-t border-rule-strong bg-paper">
        {warehouses.map((w) => (
          <li key={w.code} className={`flex min-h-12 flex-wrap items-center gap-x-3 gap-y-1 border-b border-rule px-3 py-2 ${w.active ? '' : 'text-ink2'}`}>
            <span className="font-num">{w.code}</span>
            <span>{w.name}</span>
            {w.isMain && <span className="text-sm text-ink2">· {t.main}</span>}
            {!w.active && <span className="text-sm">· {t.inactive}</span>}
            {editable && !w.isMain && (
              <button type="button" disabled={busy} className="ml-auto min-h-11 text-sm underline"
                onClick={() => void run(() => patchJson(`/companies/${companyId}/warehouses/${w.code}`, { active: !w.active }))}>
                {w.active ? t.deactivate(w.name) : t.activate(w.name)}
              </button>
            )}
          </li>
        ))}
      </ul>
      {editable && (
        <form className="grid gap-3 sm:grid-cols-[10rem_minmax(0,1fr)_auto] sm:items-end" aria-label={t.add}
          onSubmit={(e) => {
            e.preventDefault();
            if (!code || !name.trim()) return;
            void run(async () => { await postJson(`/companies/${companyId}/warehouses`, { code, name: name.trim() }); setCode(''); setName(''); });
          }}>
          <TextField label={t.code} value={code} onChange={(v) => setCode(v.toUpperCase().trim())} mono maxLength={20} />
          <TextField label={t.name} value={name} onChange={setName} maxLength={100} />
          <Button type="submit" disabled={busy || !code || !name.trim()} className="max-sm:w-full">{t.add}</Button>
        </form>
      )}
      {msg && <p role="alert" className="neg text-[15px]">{msg.text}</p>}
    </section>
  );
}

type Line = { key: number; itemCode: string; qty: string };
let seq = 0;

// ใบโอนย้าย: คลังต้นทาง → ปลายทาง หลายสินค้า ไม่ลงบัญชี (DB ตรวจของพอ ณ วันที่)
export function TransferForm({ companyId, warehouses, items }: { companyId: string; warehouses: Warehouse[]; items: InventoryItem[] }) {
  const router = useRouter();
  const active = warehouses.filter((w) => w.active);
  const [from, setFrom] = useState(active[0]?.code ?? '');
  const [to, setTo] = useState(active[1]?.code ?? '');
  const [date, setDate] = useState(isoToThai(todayIso()));
  const [description, setDescription] = useState('');
  const [lines, setLines] = useState<Line[]>(() => [{ key: ++seq, itemCode: items[0]?.code ?? '', qty: '' }]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const key = useRef(crypto.randomUUID());
  const iso = thaiToIso(date);
  const valid = Boolean(from && to && from !== to && iso && lines.every((l) => l.itemCode && QTY.test(l.qty.trim()) && Number(l.qty) > 0));

  async function submit() {
    if (busy) return;
    if (!valid) { setMsg({ ok: false, text: t.invalid }); return; }
    setBusy(true);
    setMsg(null);
    try {
      const r = await postJson<{ docNo: string }>(`/companies/${companyId}/inventory/transfers`, {
        date: iso, from, to, ...(description.trim() ? { description: description.trim() } : {}),
        lines: lines.map((l) => ({ itemCode: l.itemCode, qty: l.qty.trim() })),
      }, { 'idempotency-key': key.current });
      key.current = crypto.randomUUID();
      setLines([{ key: ++seq, itemCode: items[0]?.code ?? '', qty: '' }]);
      setDescription('');
      setMsg({ ok: true, text: t.saved(r.docNo) });
      router.refresh();
    } catch (e) {
      setMsg({ ok: false, text: errText(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="flex flex-col gap-4 border border-rule-strong bg-paper p-4 sm:p-6" aria-label={t.transferNew}
      onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <h2 className="text-[17px] font-semibold">{t.transferNew}</h2>
      <p className="text-sm text-ink2">{t.transferNote}</p>
      <div className="grid gap-4 sm:grid-cols-3 sm:gap-6">
        <SelectField label={t.from} value={from} onChange={setFrom}>
          {active.map((w) => <option key={w.code} value={w.code}>{w.code} {w.name}</option>)}
        </SelectField>
        <SelectField label={t.to} value={to} onChange={setTo}>
          {active.map((w) => <option key={w.code} value={w.code}>{w.code} {w.name}</option>)}
        </SelectField>
        <TextField label={th.inventory.date} value={date} onChange={(v) => setDate(maskDate(v))} inputMode="numeric" mono />
      </div>
      <ol className="flex flex-col gap-3">
        {lines.map((l, i) => (
          <li key={l.key} className="grid grid-cols-[minmax(0,1fr)_8rem] items-end gap-3">
            <SelectField label={t.item(i + 1)} value={l.itemCode}
              onChange={(v) => setLines((ls) => ls.map((x) => (x.key === l.key ? { ...x, itemCode: v } : x)))}>
              {items.map((it) => <option key={it.code} value={it.code}>{it.code} {it.name}</option>)}
            </SelectField>
            <TextField label={`${t.qty} ${i + 1}`} value={l.qty} inputMode="decimal" mono
              onChange={(v) => setLines((ls) => ls.map((x) => (x.key === l.key ? { ...x, qty: v } : x)))} />
            {lines.length > 1 && (
              <button type="button" className="col-span-2 min-h-11 justify-self-start text-sm text-ink2 underline"
                onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>{t.removeLine} {i + 1}</button>
            )}
          </li>
        ))}
      </ol>
      <Button type="button" variant="secondary" className="self-start max-sm:w-full"
        onClick={() => setLines((ls) => [...ls, { key: ++seq, itemCode: items[0]?.code ?? '', qty: '' }])}>{t.addLine}</Button>
      <TextField label={th.inventory.description} value={description} onChange={setDescription} maxLength={300} />
      {msg && <p role={msg.ok ? 'status' : 'alert'} className={msg.ok ? 'text-[15px]' : 'neg text-[15px]'}>{msg.text}</p>}
      <div><Button type="submit" disabled={busy} className="max-sm:w-full">{t.transferSave}</Button></div>
    </form>
  );
}
