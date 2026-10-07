'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/Button';
import { api, type Account, type ApiError } from '@/lib/api';
import { fromCents, formatMoney, toCents } from '@/lib/money';
import { isoToThai, thaiToIso, todayIso } from '@/lib/date';
import { th } from '@/i18n/th';
import { clearDraft, setDraft } from '@/lib/presence';

type Line = { key: number; code: string; debit: string; credit: string; memo: string };

let seq = 0;
const blank = (): Line => ({ key: ++seq, code: '', debit: '', credit: '', memo: '' });
const newKey = () => crypto.randomUUID();

/** ค้นหารหัสบัญชีด้วยการพิมพ์ (รหัสหรือชื่อ) ไม่ใช้ดรอปดาวน์ยาว */
function AccountField({
  accounts, value, onChange, label,
}: { accounts: Account[]; value: string; onChange: (code: string) => void; label: string }) {
  const [q, setQ] = useState(value);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  // ค่าจากภายนอกเปลี่ยน (เช่น ล้างฟอร์ม) ให้ช่องพิมพ์ตาม — ทำระหว่าง render ตามแนวทาง React ไม่ใช้ effect
  const [prevValue, setPrevValue] = useState(value);
  if (value !== prevValue) {
    setPrevValue(value);
    setQ(value);
  }

  const matches = useMemo(() => {
    const s = q.trim();
    if (!s) return [];
    return accounts.filter((a) => a.code.startsWith(s) || a.name.includes(s)).slice(0, 8);
  }, [accounts, q]);

  const pick = (a: Account) => {
    onChange(a.code);
    setQ(a.code);
    setOpen(false);
  };

  return (
    <div className="relative">
      <input
        role="combobox"
        aria-label={label}
        aria-expanded={open && matches.length > 0}
        aria-controls={listId}
        aria-activedescendant={open && matches[active] ? `${listId}-${active}` : undefined}
        aria-autocomplete="list"
        className="h-11 w-full bg-transparent px-1 font-num outline-offset-[-2px]"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
          setActive(0);
          const exact = accounts.find((a) => a.code === e.target.value.trim());
          onChange(exact ? exact.code : '');
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={(e) => {
          if (!open || matches.length === 0) return;
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(i + 1, matches.length - 1)); }
          if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
          if (e.key === 'Enter') { e.preventDefault(); const m = matches[active]; if (m) pick(m); }
          if (e.key === 'Escape') setOpen(false);
        }}
      />
      {open && matches.length > 0 && (
        <ul id={listId} role="listbox" className="absolute top-full left-0 z-10 w-[min(340px,85vw)] border border-ink bg-paper">
          {matches.map((a, i) => (
            <li
              key={a.code}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => { e.preventDefault(); pick(a); }}
              className="flex min-h-11 cursor-pointer items-center gap-3 border-b border-rule px-2.5 aria-selected:bg-ink aria-selected:text-paper"
            >
              <span className="font-num">{a.code}</span>
              {a.name}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function JournalForm({ companyId, accounts, locked = false }: { companyId: string; accounts: Account[]; locked?: boolean }) {
  const [date, setDate] = useState(isoToThai(todayIso()));
  const [description, setDescription] = useState('');
  const [lines, setLines] = useState<Line[]>(() => [blank(), blank()]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string; href?: string } | null>(null);
  const idem = useRef(newKey()); // คีย์เดิมจนกว่าจะผ่านรายการสำเร็จ (กดซ้ำ/เน็ตหลุดไม่เกิดรายการซ้ำ)

  const byCode = useMemo(() => new Map(accounts.map((a) => [a.code, a])), [accounts]);
  const update = (key: number, patch: Partial<Line>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const addLine = useCallback(() => setLines((ls) => [...ls, blank()]), []);

  // ยอดรวมเป็นสตางค์ BigInt (ไม่ใช้ float)
  const calc = useMemo(() => {
    let dr = 0n, cr = 0n, filled = 0, invalid = false;
    for (const l of lines) {
      const d = toCents(l.debit), c = toCents(l.credit);
      if (d === null || c === null) { invalid = true; continue; }
      if (d === 0n && c === 0n) continue;
      if ((d > 0n) === (c > 0n) || !byCode.has(l.code)) invalid = true;
      dr += d; cr += c; filled++;
    }
    return { dr, cr, diff: dr - cr, filled, invalid };
  }, [lines, byCode]);

  // ส่งร่างให้ครูดูสด (หน่วงใน lib/presence) — ไม่ส่งเมื่อถูกล็อก
  useEffect(() => {
    if (locked) return;
    setDraft({ date, description, lines: lines.map((l) => ({ account_code: l.code, debit: l.debit, credit: l.credit })) });
  }, [date, description, lines, locked]);

  const isoDate = thaiToIso(date);
  const canPost = !locked && !busy && !calc.invalid && calc.filled >= 2 && calc.diff === 0n && calc.dr > 0n && isoDate !== null;

  const submit = useCallback(async () => {
    if (!canPost || !isoDate) return;
    if (!navigator.onLine) { setResult({ ok: false, text: th.error.offline }); return; }
    setBusy(true);
    setResult(null);
    try {
      const payload = {
        date: isoDate,
        description,
        lines: lines
          .filter((l) => toCents(l.debit) !== 0n || toCents(l.credit) !== 0n)
          .map((l) => {
            const d = toCents(l.debit)!, c = toCents(l.credit)!;
            return { account_code: l.code, ...(d > 0n ? { debit: fromCents(d) } : { credit: fromCents(c) }), ...(l.memo ? { memo: l.memo } : {}) };
          }),
      };
      const r = await api<{ id: string; docNo: string }>(`/companies/${companyId}/journal`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': idem.current },
        body: JSON.stringify(payload),
      });
      setResult({ ok: true, text: th.journal.posted(r.docNo), href: `/c/${companyId}/journal/${r.id}` });
      void clearDraft();
      setLines([blank(), blank()]);
      setDescription('');
      idem.current = newKey();
    } catch (e) {
      const err = e as ApiError;
      setResult({ ok: false, text: err.code === 'server' ? th.error.server(err.ref ?? '-') : err.message });
    } finally {
      setBusy(false);
    }
  }, [canPost, isoDate, description, lines, companyId]);

  // ปุ่มลัดแบบโปรแกรมบัญชี (มีปุ่มบนจอให้กดได้เสมอ ปุ่มลัดเป็นทางเสริม)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F9') { e.preventDefault(); void submit(); }
      if (e.key === 'Insert') { e.preventDefault(); addLine(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [submit, addLine]);

  const money = (c: bigint) => formatMoney(fromCents(c < 0n ? -c : c));
  const cellIn = 'h-11 w-full bg-transparent px-1 outline-offset-[-2px]';

  return (
    <form
      className="flex min-h-full flex-col"
      onSubmit={(e) => { e.preventDefault(); void submit(); }}
    >
      {locked && <p role="status" className="mx-3 mt-3 border border-rule-strong bg-band px-4 py-2.5 sm:mx-5">{th.submission.lockedNote}</p>}
      <section className="m-3 flex flex-col gap-4 border border-rule-strong bg-paper p-4 sm:m-5 sm:p-6">
        <div className="flex items-start justify-between border-b-2 border-ink pb-2.5">
          <h1 className="font-doc text-[19px] font-bold sm:text-2xl">{th.journal.title}</h1>
          <p className="text-right text-sm text-ink2">
            {th.invoice.docNo} {th.journal.docNoPending}
          </p>
        </div>

        <div className="grid grid-cols-[130px_minmax(0,1fr)] gap-3 sm:grid-cols-[180px_minmax(0,1fr)] sm:gap-5">
          <label className="flex flex-col text-sm">
            {th.journal.date}
            <input
              className="h-10 border-b border-rule-input bg-transparent px-0.5 font-num text-base"
              inputMode="numeric"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              aria-invalid={isoDate === null}
            />
          </label>
          <label className="flex flex-col text-sm">
            {th.journal.description}
            <input
              className="h-10 border-b border-rule-input bg-transparent px-0.5 text-base"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
        </div>

        {/* หัวตาราง (iPad/คอม) */}
        <div role="row" className="hidden grid-cols-[96px_minmax(0,1fr)_minmax(0,1fr)_150px_150px_88px] border border-rule bg-band text-sm font-medium sm:grid">
          <span className="px-2 py-2">{th.journal.accountCode}</span>
          <span className="border-l border-rule px-2 py-2">{th.journal.accountName}</span>
          <span className="border-l border-rule px-2 py-2">{th.journal.lineMemo}</span>
          <span className="border-l border-rule px-2 py-2 text-right">{th.money.debit}</span>
          <span className="border-l border-rule px-2 py-2 text-right">{th.money.credit}</span>
          <span className="border-l border-rule" />
        </div>

        <div className="-mt-4 flex flex-col">
          {lines.map((l, i) => {
            const acc = byCode.get(l.code);
            const isCredit = (toCents(l.credit) ?? 0n) > 0n;
            return (
              <div
                key={l.key}
                className="grid grid-cols-2 border-b border-rule max-sm:gap-x-3 max-sm:py-2 sm:grid-cols-[96px_minmax(0,1fr)_minmax(0,1fr)_150px_150px_88px] sm:border-x"
              >
                <div className="col-span-2 sm:col-span-1">
                  <AccountField
                    accounts={accounts}
                    value={l.code}
                    onChange={(code) => update(l.key, { code })}
                    label={`${th.journal.accountCode} ${i + 1}`}
                  />
                </div>
                <span className={`col-span-2 flex items-center text-[15px] sm:col-span-1 sm:border-l sm:border-rule sm:px-2 ${isCredit ? 'sm:pl-7' : ''} ${acc ? '' : 'text-ink2'}`}>
                  {acc?.name ?? th.journal.accountSearchHint}
                </span>
                <input
                  aria-label={`${th.journal.lineMemo} ${i + 1}`}
                  className={`${cellIn} hidden sm:block sm:border-l sm:border-rule sm:px-2`}
                  value={l.memo}
                  onChange={(e) => update(l.key, { memo: e.target.value })}
                />
                <label className="flex flex-col text-[13px] text-ink2 sm:border-l sm:border-rule sm:text-base sm:text-ink">
                  <span className="sm:sr-only">{th.money.debit}</span>
                  <input
                    inputMode="decimal"
                    aria-invalid={toCents(l.debit) === null}
                    className={`${cellIn} num border-b border-rule-input text-base text-ink sm:border-0 sm:px-2`}
                    value={l.debit}
                    onChange={(e) => update(l.key, { debit: e.target.value })}
                  />
                </label>
                <label className="flex flex-col text-[13px] text-ink2 sm:border-l sm:border-rule sm:text-base sm:text-ink">
                  <span className="sm:sr-only">{th.money.credit}</span>
                  <input
                    inputMode="decimal"
                    aria-invalid={toCents(l.credit) === null}
                    className={`${cellIn} num border-b border-rule-input text-base text-ink sm:border-0 sm:px-2`}
                    value={l.credit}
                    onChange={(e) => update(l.key, { credit: e.target.value })}
                  />
                </label>
                <button
                  type="button"
                  className="col-span-2 min-h-11 text-left text-sm whitespace-nowrap text-ink2 underline sm:col-span-1 sm:border-l sm:border-rule sm:text-center"
                  onClick={() => setLines((ls) => (ls.length > 2 ? ls.filter((x) => x.key !== l.key) : ls))}
                  disabled={lines.length <= 2}
                >
                  {th.journal.removeLine}
                </button>
              </div>
            );
          })}
        </div>

        <div className="flex gap-3">
          <Button type="button" variant="secondary" shortcut="Ins" onClick={addLine} className="max-sm:w-full">
            {th.journal.addLine}
          </Button>
          <Button
            type="button"
            variant="secondary"
            className="max-sm:hidden"
            onClick={() => { setLines([blank(), blank()]); setDescription(''); setResult(null); }}
          >
            {th.journal.clear}
          </Button>
        </div>
      </section>

      {/* แถบผลต่าง: ติดล่างจอจนเป็น 0 จึงผ่านรายการได้ */}
      <footer
        className={`sticky bottom-0 mt-auto flex flex-col gap-2.5 border-t bg-paper px-4 py-2.5 sm:flex-row sm:items-center sm:gap-6 sm:px-6 ${calc.diff === 0n ? 'border-rule-strong' : 'border-t-2 border-red'}`}
      >
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 text-[15px] sm:flex sm:gap-5">
          <dt>{th.money.debit}</dt><dd className="num">{money(calc.dr)}</dd>
          <dt>{th.money.credit}</dt><dd className="num">{money(calc.cr)}</dd>
          <dt className={calc.diff === 0n ? '' : 'neg font-semibold'}>{th.money.difference}</dt>
          <dd className={`num ${calc.diff === 0n ? '' : 'neg font-semibold'}`}>
            {money(calc.diff)}{calc.diff === 0n && calc.dr > 0n ? ` · ${th.money.balanced}` : ''}
          </dd>
        </dl>
        <div role={result?.ok ? 'status' : 'alert'} className={`text-sm ${result && !result.ok ? 'neg' : ''}`}>
          {result?.text ??
            (calc.diff > 0n ? th.journal.debitExceeds(money(calc.diff)) : calc.diff < 0n ? th.journal.creditExceeds(money(calc.diff)) : '')}
          {calc.diff !== 0n && !result && ` ${th.journal.postableWhenZero}`}
          {result?.href && <> · <Link href={result.href} className="underline">{th.journal.viewPosted}</Link></>}
        </div>
        <Button type="submit" shortcut="F9" disabled={!canPost} className="max-sm:w-full sm:ml-auto">
          {th.journal.post}
        </Button>
      </footer>
    </form>
  );
}
