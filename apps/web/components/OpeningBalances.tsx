'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { Button } from '@/components/Button';
import { AccountSelect, ConfirmPanel, DateInput, PlainInput, useAction } from '@/components/ConfirmPanel';
import type { OpeningData } from '@/lib/api';
import { deleteDocDraft, loadDocDraft, saveDocDraft } from '@/lib/drafts';
import { isoToThai, thaiToIso } from '@/lib/date';
import { formatMoney, fromCents, toCents } from '@/lib/money';
import { th } from '@/i18n/th';

// ยอดยกมาพร้อมรายตัว (docs/phase5-spec.md ข้อ 3): ฟอร์มเดียว ลงครั้งเดียวเป็น OB
// ผลรวมเดบิต/เครดิตคิดเป็นสตางค์ (BigInt) รวมบรรทัดบัญชีคุมที่ระบบจะสร้างจากรายตัว · ตรวจซ้ำทั้งหมดที่ DB

type GlRow = { code: string; debit: string; credit: string };
type ItemRow = { partyCode: string; ref: string; date: string; dueDate: string; amount: string; undueVat: string };
type AssetRow = { code: string; name: string; acquiredDate: string; cost: string; salvage: string; lifeMonths: string; assetAccount: string; accumAccount: string; accumulated: string };
type InvRow = { itemCode: string; qty: string; unitCost: string };
type State = { date: string; accounts: GlRow[]; receivables: ItemRow[]; payables: ItemRow[]; assets: AssetRow[]; inventory: InvRow[] };

const EMPTY: State = { date: '', accounts: [{ code: '', debit: '', credit: '' }], receivables: [], payables: [], assets: [], inventory: [] };
const newItem = (): ItemRow => ({ partyCode: '', ref: '', date: '', dueDate: '', amount: '', undueVat: '' });
const newAsset = (): AssetRow => ({ code: '', name: '', acquiredDate: '', cost: '', salvage: '', lifeMonths: '', assetAccount: '', accumAccount: '', accumulated: '' });
const c = (v: string) => (v.trim() === '' ? 0n : (toCents(v.replace(/,/g, '')) ?? 0n));
const iso = (v: string) => (v.trim() === '' ? undefined : (thaiToIso(v) ?? v));
const t = th.opening;

/** ค่าของสินค้า = ปัด(จำนวน × ต้นทุน, 2) คิดด้วยสตริงทศนิยม (ไม่ใช้ float) */
function invValueCents(qty: string, unit: string): bigint {
  const parse = (s: string, dp: number) => {
    const m = /^(\d+)(?:\.(\d+))?$/.exec(s.trim());
    if (!m) return null;
    return BigInt(m[1]! + (m[2] ?? '').padEnd(dp, '0').slice(0, dp));
  };
  const q = parse(qty, 3), u = parse(unit, 6);
  if (q === null || u === null) return 0n;
  const raw = q * u; // หน่วย 10^-9 บาท
  return (raw + 5_000_000n) / 10_000_000n; // ปัดครึ่งขึ้นเป็นสตางค์
}

function Section({ title, note, children, onAdd, addLabel }: { title: string; note?: string; children: ReactNode; onAdd: () => void; addLabel: string }) {
  return (
    <section aria-label={title} className="flex flex-col gap-3 border border-rule-strong bg-paper p-4">
      <h2 className="font-doc text-[18px] font-bold">{title}</h2>
      {note && <p className="text-sm text-ink2">{note}</p>}
      {children}
      <Button type="button" variant="secondary" onClick={onAdd} className="self-start max-sm:w-full">{addLabel}</Button>
    </section>
  );
}

function Row({ label, onRemove, children }: { label: string; onRemove: () => void; children: ReactNode }) {
  return (
    <fieldset aria-label={label} className="grid gap-x-4 gap-y-2 border-t border-rule pt-3 sm:grid-cols-2 lg:grid-cols-4">
      <legend className="sr-only">{label}</legend>
      {children}
      <button type="button" onClick={onRemove} className="min-h-11 justify-self-start text-sm underline">{t.remove}</button>
    </fieldset>
  );
}

function Select({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: { code: string; name: string }[] }) {
  return (
    <label className="flex min-w-0 flex-col text-sm">
      {label}
      <select className="h-11 w-full border-b border-rule-input bg-transparent text-base" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{t.none}</option>
        {options.map((o) => <option key={o.code} value={o.code}>{o.code} {o.name}</option>)}
      </select>
    </label>
  );
}

export function OpeningBalances({ companyId, data }: { companyId: string; data: OpeningData }) {
  const [s, setS] = useState<State>(EMPTY);
  const [done, setDone] = useState<string | null>(null);
  const [voiding, setVoiding] = useState(false);
  const [reason, setReason] = useState('');
  const action = useAction();
  const ob = data.opening;
  const editable = !ob && data.canWrite;

  useEffect(() => {
    if (!editable) return;
    let live = true;
    void loadDocDraft<State>('opening', companyId).then((d) => { if (live && d) setS(d.state); });
    return () => { live = false; };
  }, [companyId, editable]);
  useEffect(() => { if (editable && s !== EMPTY) void saveDocDraft('opening', companyId, s); }, [s, companyId, editable]);

  const set = <K extends keyof State>(k: K, v: State[K]) => setS((x) => ({ ...x, [k]: v }));
  const upd = <K extends 'accounts' | 'receivables' | 'payables' | 'assets' | 'inventory'>(k: K, i: number, patch: Partial<State[K][number]>) =>
    setS((x) => ({ ...x, [k]: (x[k] as State[K][number][]).map((r, j) => (j === i ? { ...r, ...patch } : r)) }));
  const del = (k: 'accounts' | 'receivables' | 'payables' | 'assets' | 'inventory', i: number) =>
    setS((x) => ({ ...x, [k]: (x[k] as unknown[]).filter((_, j) => j !== i) }));

  // บัญชีคุม: พิมพ์เองไม่ได้ (เหมือนที่ DB ตรวจ)
  const control = useMemo(() => {
    const set = new Set(['1210', '2110', '2211', '1411']);
    if (data.items.length > 0 || s.inventory.length > 0) set.add('1310');
    for (const a of s.assets) { if (a.assetAccount) set.add(a.assetAccount); if (a.accumAccount) set.add(a.accumAccount); }
    return set;
  }, [data.items.length, s.inventory.length, s.assets]);
  const glAccounts = data.accounts.filter((a) => !control.has(a.code));
  const ppe = data.accounts.filter((a) => a.type === 'asset' && a.code.startsWith('16'));

  const totals = useMemo(() => {
    let d = 0n, cr = 0n;
    for (const r of s.accounts) { d += c(r.debit); cr += c(r.credit); }
    for (const r of s.receivables) { d += c(r.amount); cr += c(r.undueVat); }
    for (const r of s.payables) { cr += c(r.amount); d += c(r.undueVat); }
    for (const r of s.inventory) d += invValueCents(r.qty, r.unitCost);
    for (const r of s.assets) { d += c(r.cost); cr += c(r.accumulated); }
    return { d, cr };
  }, [s]);
  const diff = totals.d - totals.cr;
  const dateIso = thaiToIso(s.date);

  async function post() {
    const body = {
      date: dateIso,
      accounts: s.accounts.filter((r) => r.code).map((r) => ({ code: r.code, ...(c(r.debit) > 0n ? { debit: fromCents(c(r.debit)) } : {}), ...(c(r.credit) > 0n ? { credit: fromCents(c(r.credit)) } : {}) })),
      receivables: s.receivables.map((r) => ({ partyCode: r.partyCode, ref: r.ref.trim(), date: iso(r.date), dueDate: iso(r.dueDate), amount: fromCents(c(r.amount)), ...(c(r.undueVat) > 0n ? { undueVat: fromCents(c(r.undueVat)) } : {}) })),
      payables: s.payables.map((r) => ({ partyCode: r.partyCode, ref: r.ref.trim(), date: iso(r.date), dueDate: iso(r.dueDate), amount: fromCents(c(r.amount)), ...(c(r.undueVat) > 0n ? { undueVat: fromCents(c(r.undueVat)) } : {}) })),
      assets: s.assets.map((r) => ({ code: r.code.trim().toUpperCase(), name: r.name.trim(), acquiredDate: iso(r.acquiredDate), cost: fromCents(c(r.cost)),
        ...(c(r.salvage) > 0n ? { salvage: fromCents(c(r.salvage)) } : {}), lifeMonths: Number(r.lifeMonths), assetAccount: r.assetAccount,
        accumAccount: r.accumAccount, accumulated: fromCents(c(r.accumulated)) })),
      inventory: s.inventory.map((r) => ({ itemCode: r.itemCode, qty: r.qty.trim(), unitCost: r.unitCost.trim() })),
    };
    const r = await action.run<{ docNo: string }>(`/companies/${companyId}/opening`, body);
    if (r) { setDone(t.posted(r.docNo)); setS(EMPTY); await deleteDocDraft('opening', companyId); }
  }

  async function voidAll() {
    const r = await action.run<{ docNo: string }>(`/companies/${companyId}/opening/void`, { reason });
    if (r) { setDone(t.voided(r.docNo)); setVoiding(false); setReason(''); }
  }

  const cell = 'border border-rule px-2.5 py-2';
  if (ob) {
    const table = (title: string, head: string[], rows: string[][]) => (
      <section aria-label={title} className="flex flex-col gap-2">
        <h2 className="font-doc text-[18px] font-bold">{title}</h2>
        {rows.length === 0 ? <p className="text-sm text-ink2">{t.noItems}</p> : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse bg-paper text-[15px]">
              <thead className="bg-band text-left text-sm"><tr>{head.map((h, i) => <th key={h} className={`${cell} font-medium ${i >= head.length - 2 ? 'text-right' : ''}`}>{h}</th>)}</tr></thead>
              <tbody>{rows.map((r) => <tr key={r[0]}>{r.map((v, i) => <td key={i} className={`${cell} ${i >= r.length - 2 ? 'num' : ''}`}>{v}</td>)}</tr>)}</tbody>
            </table>
          </div>
        )}
      </section>
    );
    return (
      <div className="flex flex-col gap-5">
        <p className="text-[15px]">
          <Link href={`/c/${companyId}/journal/${ob.entryId}`} className="underline">{t.postedTitle(isoToThai(ob.date), ob.docNo)}</Link>
          {' · '}{t.total} {formatMoney(ob.total)}
        </p>
        {table(t.receivables, [t.ref, t.customer, t.dueDate, t.undueVat, t.amount],
          ob.receivables.map((x) => [x.docNo, `${x.partyCode} ${x.partyName}`, isoToThai(x.dueDate), formatMoney(x.undueVat), formatMoney(x.amount)]))}
        {table(t.payables, [t.ref, t.vendor, t.dueDate, t.undueVat, t.amount],
          ob.payables.map((x) => [x.docNo, `${x.partyCode} ${x.partyName}`, isoToThai(x.dueDate), formatMoney(x.undueVat), formatMoney(x.amount)]))}
        {table(t.assets, [t.assetCode, t.assetName, t.life, t.accumulated, t.cost],
          ob.assets.map((x) => [x.code, x.name, String(x.months), formatMoney(x.accumulated), formatMoney(x.cost)]))}
        {table(t.inventory, [t.item, t.qty, t.unitCost, t.value],
          ob.inventory.map((x) => [`${x.itemCode} ${x.name}`, x.qty, x.unitCost, formatMoney(x.value)]))}
        {data.canWrite && !voiding && (
          <Button type="button" variant="secondary" onClick={() => setVoiding(true)} className="self-start max-sm:w-full">{t.voidTitle}</Button>
        )}
        {voiding && (
          <ConfirmPanel title={t.voidTitle} explain={t.voidExplain} ready={reason.trim().length > 0} busy={action.busy} error={action.error}
            confirm={t.voidConfirm} onConfirm={() => void voidAll()} onCancel={() => setVoiding(false)}>
            <PlainInput label={t.voidReason} value={reason} onChange={setReason} maxLength={300} />
          </ConfirmPanel>
        )}
        {done && <p role="status" className="text-[15px]">{done}</p>}
      </div>
    );
  }
  if (!data.canWrite) return <p className="text-ink2">{done ?? t.readOnly}</p>;

  const parties = (k: 'receivables' | 'payables') => (k === 'receivables' ? data.customers : data.vendors);
  const items = (k: 'receivables' | 'payables', what: string) => (
    <Section title={k === 'receivables' ? t.receivables : t.payables} onAdd={() => set(k, [...s[k], newItem()])} addLabel={t.add(what)}>
      {s[k].map((r, i) => (
        <Row key={i} label={`${what} ${i + 1}`} onRemove={() => del(k, i)}>
          <Select label={what} value={r.partyCode} onChange={(v) => upd(k, i, { partyCode: v })} options={parties(k)} />
          <PlainInput label={t.ref} value={r.ref} onChange={(v) => upd(k, i, { ref: v })} maxLength={20} mono />
          <DateInput label={t.docDate} value={r.date} onChange={(v) => upd(k, i, { date: v })} invalid={r.date !== '' && !thaiToIso(r.date)} />
          <DateInput label={t.dueDate} value={r.dueDate} onChange={(v) => upd(k, i, { dueDate: v })} invalid={r.dueDate !== '' && !thaiToIso(r.dueDate)} />
          <PlainInput label={t.amount} value={r.amount} onChange={(v) => upd(k, i, { amount: v })} inputMode="decimal" />
          {data.vatRegistered && <PlainInput label={t.undueVat} value={r.undueVat} onChange={(v) => upd(k, i, { undueVat: v })} inputMode="decimal" />}
        </Row>
      ))}
    </Section>
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1 sm:max-w-xs">
        <DateInput label={t.date} value={s.date} onChange={(v) => set('date', v)} invalid={s.date !== '' && !dateIso} />
        {data.firstEntryDate && <p className="text-sm text-ink2">{t.dateHint(isoToThai(data.firstEntryDate))}</p>}
      </div>

      <Section title={t.accounts} note={t.accountsNote} onAdd={() => set('accounts', [...s.accounts, { code: '', debit: '', credit: '' }])} addLabel={t.add(t.account)}>
        {s.accounts.map((r, i) => (
          <Row key={i} label={`${t.account} ${i + 1}`} onRemove={() => del('accounts', i)}>
            <AccountSelect label={t.account} value={r.code} onChange={(v) => upd('accounts', i, { code: v })} accounts={glAccounts} none={t.none} />
            <PlainInput label={th.money.debit} value={r.debit} onChange={(v) => upd('accounts', i, { debit: v })} inputMode="decimal" />
            <PlainInput label={th.money.credit} value={r.credit} onChange={(v) => upd('accounts', i, { credit: v })} inputMode="decimal" />
          </Row>
        ))}
      </Section>

      {items('receivables', t.customer)}
      {items('payables', t.vendor)}

      <Section title={t.assets} onAdd={() => set('assets', [...s.assets, newAsset()])} addLabel={t.add(t.assets)}>
        {s.assets.map((r, i) => (
          <Row key={i} label={`${t.assets} ${i + 1}`} onRemove={() => del('assets', i)}>
            <PlainInput label={t.assetCode} value={r.code} onChange={(v) => upd('assets', i, { code: v })} maxLength={20} mono />
            <PlainInput label={t.assetName} value={r.name} onChange={(v) => upd('assets', i, { name: v })} maxLength={160} />
            <DateInput label={t.acquired} value={r.acquiredDate} onChange={(v) => upd('assets', i, { acquiredDate: v })} invalid={r.acquiredDate !== '' && !thaiToIso(r.acquiredDate)} />
            <PlainInput label={t.cost} value={r.cost} onChange={(v) => upd('assets', i, { cost: v })} inputMode="decimal" />
            <PlainInput label={t.salvage} value={r.salvage} onChange={(v) => upd('assets', i, { salvage: v })} inputMode="decimal" />
            <PlainInput label={t.life} value={r.lifeMonths} onChange={(v) => upd('assets', i, { lifeMonths: v })} inputMode="numeric" />
            <AccountSelect label={t.assetAccount} value={r.assetAccount} onChange={(v) => upd('assets', i, { assetAccount: v })} accounts={ppe} none={t.none} />
            <AccountSelect label={t.accumAccount} value={r.accumAccount} onChange={(v) => upd('assets', i, { accumAccount: v })} accounts={ppe} none={t.none} />
            <PlainInput label={t.accumulated} value={r.accumulated} onChange={(v) => upd('assets', i, { accumulated: v })} inputMode="decimal" />
          </Row>
        ))}
      </Section>

      {data.items.length > 0 && (
        <Section title={t.inventory} onAdd={() => set('inventory', [...s.inventory, { itemCode: '', qty: '', unitCost: '' }])} addLabel={t.add(t.item)}>
          {s.inventory.map((r, i) => (
            <Row key={i} label={`${t.item} ${i + 1}`} onRemove={() => del('inventory', i)}>
              <Select label={t.item} value={r.itemCode} onChange={(v) => upd('inventory', i, { itemCode: v })} options={data.items} />
              <PlainInput label={t.qty} value={r.qty} onChange={(v) => upd('inventory', i, { qty: v })} inputMode="decimal" />
              <PlainInput label={t.unitCost} value={r.unitCost} onChange={(v) => upd('inventory', i, { unitCost: v })} inputMode="decimal" />
              <p className="flex flex-col text-sm">{t.value}<span className="num h-11 leading-[44px]">{formatMoney(fromCents(invValueCents(r.qty, r.unitCost)))}</span></p>
            </Row>
          ))}
        </Section>
      )}

      {/* แถบผลต่างติดล่าง: กดผ่านรายการได้เมื่อดุลและวันที่ถูก (มือถือ: ปุ่มหลักนิ้วโป้งถึง) */}
      <div className="sticky bottom-0 z-10 flex flex-wrap items-center gap-3 border-t-2 border-ink bg-paper px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <p role="status" className={`text-[15px] ${diff === 0n ? '' : 'neg font-semibold'}`}>
          {t.totals(formatMoney(fromCents(totals.d)), formatMoney(fromCents(totals.cr)))} · {diff === 0n ? t.balanced : t.diff(formatMoney(fromCents(diff < 0n ? -diff : diff)))}
        </p>
        <Button type="button" disabled={action.busy || diff !== 0n || totals.d === 0n || !dateIso} onClick={() => void post()} className="max-sm:w-full sm:ml-auto">
          {t.post}
        </Button>
        {action.error && <p role="alert" className="neg w-full text-[15px]">{action.error}</p>}
        {done && <p className="w-full text-[15px]">{done}</p>}
      </div>
    </div>
  );
}
