'use client';

import { useId, useMemo, useState } from 'react';
import { formatMoney, fromCents } from '@/lib/money';
import type { EntryLine } from '@/lib/entry-preview';
import { th } from '@/i18n/th';

// ชิ้นส่วนที่ฟอร์มเอกสารขายและซื้อใช้ร่วมกัน

const inputCls = 'h-11 w-full border-b border-rule-input bg-transparent px-0.5 text-base';

type PickItem = { code: string; name: string };

/** ช่องรายละเอียดที่ค้นสินค้าได้: พิมพ์รหัส/ชื่อ เลือกแล้วเติมหน่วยและราคา พิมพ์เองโดยไม่เลือกก็ได้ */
export function ItemField<T extends PickItem>({ items, value, picked, label, price, onPick, onText }: {
  items: T[]; value: string; picked: boolean; label: string; price: (it: T) => string | null;
  onPick: (it: T) => void; onText: (text: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const matches = useMemo(() => {
    const s = value.trim().toUpperCase();
    if (!s || picked) return [];
    return items.filter((i) => i.code.startsWith(s) || i.name.toUpperCase().includes(s)).slice(0, 8);
  }, [items, value, picked]);
  const show = open && matches.length > 0;
  const pick = (it: T) => { onPick(it); setOpen(false); };
  return (
    <div className="relative">
      <input
        role="combobox" aria-label={label} aria-expanded={show} aria-controls={listId} aria-autocomplete="list"
        aria-activedescendant={show ? `${listId}-${active}` : undefined}
        placeholder={th.sales.itemSearch}
        className={inputCls}
        value={value}
        onChange={(e) => { onText(e.target.value); setOpen(true); setActive(0); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={(e) => {
          if (!show) return;
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(i + 1, matches.length - 1)); }
          if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
          if (e.key === 'Enter') { e.preventDefault(); const m = matches[active]; if (m) pick(m); }
          if (e.key === 'Escape') setOpen(false);
        }}
      />
      {show && (
        <ul id={listId} role="listbox" className="absolute top-full left-0 z-10 w-[min(360px,85vw)] border border-ink bg-paper">
          {matches.map((it, i) => (
            <li key={it.code} id={`${listId}-${i}`} role="option" aria-selected={i === active}
              onMouseDown={(e) => { e.preventDefault(); pick(it); }}
              className="flex min-h-11 cursor-pointer items-center gap-3 border-b border-rule px-2.5 aria-selected:bg-ink aria-selected:text-paper">
              <span className="font-num">{it.code}</span>
              <span className="min-w-0 flex-1 truncate">{it.name}</span>
              {price(it) && <span className="num text-sm">{formatMoney(price(it)!)}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** เลือกลูกค้า/ผู้ขาย: เลือกแล้วแสดงการ์ดพร้อมปุ่มเปลี่ยน ยังไม่เลือกแสดงช่องค้นหา + รายการที่ตรง */
export function PartyPicker<T extends PickItem & { taxId: string | null }>({ parties, selected, label, hint, none, onPick, onClear, extra }: {
  parties: T[]; selected: T | null; label: string; hint: string; none: string;
  onPick: (p: T) => void; onClear: () => void; extra?: (p: T) => string | null;
}) {
  const [q, setQ] = useState('');
  const matches = useMemo(() => {
    const s = q.trim().toUpperCase();
    return (s ? parties.filter((c) => c.code.startsWith(s) || c.name.toUpperCase().includes(s)) : parties).slice(0, 8);
  }, [parties, q]);
  if (selected) {
    return (
      <div className="flex items-start justify-between gap-3 border border-rule-input px-3 py-2">
        <div className="min-w-0">
          <div><span className="font-num">{selected.code}</span> {selected.name}</div>
          {selected.taxId && <div className="text-sm text-ink2">{th.sales.taxId} <span className="font-num">{selected.taxId}</span></div>}
          {extra?.(selected) && <div className="text-sm text-ink2">{extra(selected)}</div>}
        </div>
        <button type="button" className="min-h-11 shrink-0 text-sm underline" onClick={onClear}>{th.sales.change}</button>
      </div>
    );
  }
  return (
    <div className="flex flex-col">
      <label className="flex flex-col text-sm">
        {label}
        <input className={inputCls} value={q} placeholder={hint} onChange={(e) => setQ(e.target.value)} />
      </label>
      {parties.length === 0 && <p className="pt-2 text-sm text-ink2">{none}</p>}
      <ul className="flex flex-col">
        {matches.map((c) => (
          <li key={c.code}>
            <button type="button" className="flex min-h-12 w-full items-center gap-3 border-b border-rule px-1 text-left" onClick={() => onPick(c)}>
              <span className="font-num">{c.code}</span><span className="min-w-0 flex-1 truncate">{c.name}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** ตารางรายการบัญชีที่เอกสารจะสร้าง (เดบิตก่อนเครดิต) พร้อมยอดรวมสองฝั่ง */
export function EntryPreview({ lines, names, className = '' }: { lines: EntryLine[]; names: Map<string, string>; className?: string }) {
  const sorted = [...lines.filter((l) => l.debit > 0n), ...lines.filter((l) => l.credit > 0n)];
  const dr = lines.reduce((s, l) => s + l.debit, 0n);
  const cr = lines.reduce((s, l) => s + l.credit, 0n);
  const m = (v: bigint) => (v > 0n ? formatMoney(fromCents(v)) : '');
  const cell = 'border border-rule px-1.5 py-1.5 sm:px-2';
  return (
    <table className={`w-full border-collapse bg-paper text-[13px] sm:text-sm ${className}`}>
      <thead className="bg-band text-left">
        <tr>
          <th className={`${cell} font-medium`}>{th.journal.accountName}</th>
          <th className={`${cell} w-[5.5rem] text-right font-medium sm:w-28`}>{th.money.debit}</th>
          <th className={`${cell} w-[5.5rem] text-right font-medium sm:w-28`}>{th.money.credit}</th>
        </tr>
      </thead>
      <tbody>
        {sorted.length === 0 && <tr><td colSpan={3} className={`${cell} text-ink2`}>—</td></tr>}
        {sorted.map((l, i) => (
          <tr key={i}>
            <td className={`${cell} ${l.credit > 0n ? 'pl-4 sm:pl-7' : ''}`}><span className="font-num">{l.code}</span> {names.get(l.code) ?? ''}</td>
            <td className={`${cell} num`}>{m(l.debit)}</td>
            <td className={`${cell} num`}>{m(l.credit)}</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr className="font-semibold">
          <td className={cell}>{th.money.total}</td>
          <td className={`${cell} num`}>{formatMoney(fromCents(dr))}</td>
          <td className={`${cell} num`}>{formatMoney(fromCents(cr))}</td>
        </tr>
      </tfoot>
    </table>
  );
}

/** แถบแจ้งว่ากู้ร่างที่ค้างในเครื่องมา พร้อมปุ่มทิ้งร่าง (ข้อความเดียวกับสมุดรายวัน) */
export function DraftBanner({ restoredAt, onDiscard }: { restoredAt: number | null; onDiscard: () => void }) {
  if (restoredAt === null) return null;
  return (
    <p role="status" className="mx-3 mt-3 flex flex-wrap items-center gap-x-4 border border-rule-strong bg-band px-4 py-1 sm:mx-5">
      <span className="py-1.5">{th.journal.draftRestored(new Date(restoredAt).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' }))}</span>
      <button type="button" className="min-h-11 text-sm underline" onClick={onDiscard}>{th.journal.discardDraft}</button>
    </p>
  );
}

/** รายการบัญชี (สตางค์) → ร่างที่ส่งให้ครูดูสด */
export function liveLines(lines: EntryLine[]) {
  return lines.map((l) => ({ account_code: l.code, debit: l.debit > 0n ? fromCents(l.debit) : '', credit: l.credit > 0n ? fromCents(l.credit) : '' }));
}
