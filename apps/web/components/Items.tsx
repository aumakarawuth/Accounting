'use client';

import { useState } from 'react';
import { Button } from '@/components/Button';
import { SelectField, TextField } from '@/components/Fields';
import { Money } from '@/components/Money';
import { patchJson, postJson, type ApiError, type ChartRow, type Item } from '@/lib/api';
import { MASTER_CODE, MONEY } from '@/lib/taxid';
import { th } from '@/i18n/th';

const errText = (e: unknown) => {
  const err = e as ApiError;
  return err.code === 'server' ? th.error.server(err.ref ?? '-') : err.message;
};

// สินค้า/บริการ: บริการกำหนดจุดความรับผิดภาษีตอนรับ/จ่ายเงิน (docs/phase2-spec.md T4)
export function Items({ companyId, initial, chart, editable }: { companyId: string; initial: Item[]; chart: ChartRow[]; editable: boolean }) {
  const [rows, setRows] = useState(initial);
  const [showInactive, setShowInactive] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const upsert = (it: Item) => setRows((rs) => [...rs.filter((r) => r.code !== it.code), it].sort((a, b) => a.code.localeCompare(b.code)));
  const names = new Map(chart.map((a) => [a.code, a.name]));
  const inactive = rows.filter((r) => !r.active).length;
  const visible = rows.filter((r) => showInactive || r.active);

  return (
    <div className="flex flex-col gap-4">
      {editable && !adding && (
        <div><Button type="button" variant="secondary" onClick={() => { setAdding(true); setEditing(null); setMessage(null); }} className="max-sm:w-full">{th.items.add}</Button></div>
      )}
      {adding && (
        <ItemForm companyId={companyId} chart={chart}
          onDone={(it) => { if (it) { upsert(it); setMessage({ ok: true, text: th.master.added(it.code, it.name) }); } setAdding(false); }} />
      )}
      {message && <p role={message.ok ? 'status' : 'alert'} className={message.ok ? 'text-[15px]' : 'neg text-[15px]'}>{message.text}</p>}
      {inactive > 0 && (
        <button type="button" className="flex min-h-11 items-center self-start text-sm underline" onClick={() => setShowInactive((v) => !v)}>
          {showInactive ? th.master.hideInactive : `${th.master.showInactive} (${inactive})`}
        </button>
      )}

      <ul className="border border-rule-strong bg-paper" aria-label={th.items.title}>
        {visible.length === 0 && <li className="px-3 py-4 text-ink2">{th.master.empty}</li>}
        {visible.map((it) => editing === it.code ? (
          <li key={it.code} className="border-t border-rule first:border-t-0">
            <ItemForm companyId={companyId} chart={chart} item={it}
              onDone={(saved) => { if (saved) { upsert(saved); setMessage({ ok: true, text: th.master.saved }); } setEditing(null); }} />
          </li>
        ) : (
          <li key={it.code} className={`grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 border-t border-rule px-3 py-2.5 first:border-t-0 ${it.active ? '' : 'text-ink2'}`}>
            <div className="min-w-0">
              <p><span className="font-num">{it.code}</span> <span className="font-medium">{it.name}</span></p>
              <p className="text-[13px] text-ink2">
                {[it.isService ? th.items.service : th.items.goods, it.unit,
                  it.salesAccount && `${th.items.salesAccount} ${it.salesAccount} ${names.get(it.salesAccount) ?? ''}`,
                  !it.active && th.master.inactive].filter(Boolean).join(' · ')}
              </p>
            </div>
            <span className="flex flex-col items-end">
              {it.salePrice !== null && <span className="text-[15px]"><Money value={it.salePrice} /></span>}
              {editable && (
                <span className="flex gap-3">
                  <button type="button" className="min-h-11 px-1 text-sm underline" onClick={() => { setEditing(it.code); setAdding(false); setMessage(null); }}>{th.master.edit}</button>
                  <button type="button" className="min-h-11 px-1 text-sm underline"
                    onClick={async () => {
                      setMessage(null);
                      try { upsert(await patchJson<Item>(`/companies/${companyId}/items/${it.code}`, { version: it.version, active: !it.active })); }
                      catch (e) { setMessage({ ok: false, text: errText(e) }); }
                    }}>
                    {it.active ? th.master.deactivate : th.master.activate}
                  </button>
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ItemForm({ companyId, chart, item, onDone }: { companyId: string; chart: ChartRow[]; item?: Item; onDone: (it: Item | null) => void }) {
  const [code, setCode] = useState(item?.code ?? '');
  const [name, setName] = useState(item?.name ?? '');
  const [unit, setUnit] = useState(item?.unit ?? '');
  const [service, setService] = useState(item?.isService ?? false);
  const [sale, setSale] = useState(item?.salePrice ?? '');
  const [purchase, setPurchase] = useState(item?.purchasePrice ?? '');
  const [salesAcc, setSalesAcc] = useState(item?.salesAccount ?? '');
  const [purchaseAcc, setPurchaseAcc] = useState(item?.purchaseAccount ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const revenue = chart.filter((a) => a.active && a.type === 'revenue');
  const costs = chart.filter((a) => a.active && (a.type === 'expense' || a.type === 'asset'));

  const errors = {
    code: !item && code !== '' && !MASTER_CODE.test(code) ? th.master.codeInvalid : null,
    sale: sale !== '' && !MONEY.test(sale) ? th.items.priceInvalid : null,
    purchase: purchase !== '' && !MONEY.test(purchase) ? th.items.priceInvalid : null,
  };
  const valid = (item || MASTER_CODE.test(code)) && name.trim() !== '' && Object.values(errors).every((e) => !e);

  async function submit() {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    const body: Record<string, unknown> = {
      name: name.trim(), unit: unit.trim(), isService: service, salePrice: sale || null, purchasePrice: purchase || null,
      salesAccount: salesAcc || null, purchaseAccount: purchaseAcc || null,
    };
    try {
      if (item) {
        const changed: Record<string, unknown> = { version: item.version };
        for (const [k, v] of Object.entries(body)) {
          const before = (item as Record<string, unknown>)[k];
          const same = k.endsWith('Price') ? (v === null ? before === null : before !== null && Number(v) === Number(before)) : v === before;
          if (!same) changed[k] = v;
        }
        onDone(await patchJson<Item>(`/companies/${companyId}/items/${item.code}`, changed));
      } else {
        onDone(await postJson<Item>(`/companies/${companyId}/items`, { code, ...body }));
      }
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="flex flex-col gap-4 border border-rule-strong bg-paper p-4 sm:p-6" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <h2 className="text-[17px] font-semibold">{item ? th.items.editTitle(item.code) : th.items.addTitle}</h2>
      <div className="grid gap-4 sm:grid-cols-[10rem_minmax(0,1fr)_8rem] sm:gap-6">
        <TextField label={th.master.code} value={code} onChange={(v) => setCode(v.toUpperCase().trim())} mono maxLength={20}
          readOnly={Boolean(item)} hint={item ? undefined : th.master.codeHint} error={errors.code} />
        <TextField label={th.items.name} value={name} onChange={setName} maxLength={160} />
        <TextField label={th.items.unit} value={unit} onChange={setUnit} maxLength={20} hint={th.items.unitHint} />
      </div>
      <fieldset className="flex flex-col gap-1">
        <legend className="text-sm">{th.items.kind}</legend>
        <div className="flex flex-wrap gap-x-8">
          {([[false, th.items.goods], [true, th.items.service]] as const).map(([v, label]) => (
            <label key={label} className="flex min-h-11 items-center gap-3 text-[15px]">
              <input type="radio" name="kind" className="size-5 text-base accent-ink" checked={service === v} onChange={() => setService(v)} />
              {label}
            </label>
          ))}
        </div>
        <span className="text-[13px] text-ink2">{th.items.note}</span>
      </fieldset>
      <div className="grid gap-4 sm:grid-cols-2 sm:gap-6">
        <TextField label={th.items.salePrice} value={sale} onChange={(v) => setSale(v.trim())} inputMode="decimal" mono error={errors.sale} />
        <TextField label={th.items.purchasePrice} value={purchase} onChange={(v) => setPurchase(v.trim())} inputMode="decimal" mono error={errors.purchase} />
        <SelectField label={th.items.salesAccount} value={salesAcc} onChange={setSalesAcc}>
          <option value="">{th.items.accountDefault}</option>
          {revenue.map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}
        </SelectField>
        <SelectField label={th.items.purchaseAccount} value={purchaseAcc} onChange={setPurchaseAcc}>
          <option value="">{th.items.accountDefault}</option>
          {costs.map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}
        </SelectField>
      </div>
      {error && <p role="alert" className="neg text-[15px]">{error}</p>}
      <div className="flex flex-wrap gap-3">
        <Button type="submit" disabled={!valid || busy} className="max-sm:w-full">{th.master.save}</Button>
        <Button type="button" variant="secondary" disabled={busy} onClick={() => onDone(null)} className="max-sm:w-full">{th.master.cancel}</Button>
      </div>
    </form>
  );
}
