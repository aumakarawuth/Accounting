'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AccountField } from '@/components/JournalForm';
import { TextField } from '@/components/Fields';
import { api, postJson, type Account, type ApiError, type ExerciseSetDetail } from '@/lib/api';
import { isoToThai, thaiToIso, maskDate } from '@/lib/date';
import { formatMoney, fromCents, toCents } from '@/lib/money';
import { th } from '@/i18n/th';

type Line = { key: number; code: string; debit: string; credit: string };
type Item = { key: number; date: string; narrative: string; points: string; lines: Line[] };

let seq = 0;
const line = (l: Partial<Line> = {}): Line => ({ key: ++seq, code: '', debit: '', credit: '', ...l });
const item = (date = ''): Item => ({ key: ++seq, date, narrative: '', points: '1', lines: [line(), line()] });
const t = th.exercises;

/** ตรวจก่อนส่ง (DB ตรวจซ้ำ): บอกข้อแรกที่ผิดพร้อมเหตุผลจริง */
function problems(items: Item[], accounts: Account[]): string[] {
  const out: string[] = [];
  items.forEach((it, i) => {
    const no = i + 1;
    if (!thaiToIso(it.date)) out.push(t.badDate(no));
    if (!it.narrative.trim()) out.push(t.emptyNarrative(no));
    if (!/^\d{1,3}(\.\d{1,2})?$/.test(it.points.trim()) || Number(it.points) <= 0) out.push(t.badPoints(no));
    let d = 0n, c = 0n, n = 0;
    for (const l of it.lines) {
      const dr = toCents(l.debit), cr = toCents(l.credit);
      if (!l.code && dr === 0n && cr === 0n) continue;
      if (dr === null || cr === null || (dr > 0n) === (cr > 0n)) { out.push(t.badAmount(no)); return; }
      if (!accounts.some((a) => a.code === l.code)) { out.push(t.unknownAccount(no, l.code || '-')); return; }
      d += dr; c += cr; n++;
    }
    if (n < 2) out.push(t.fewLines(no));
    else if (d !== c) out.push(t.unbalanced(no, formatMoney(fromCents(d)), formatMoney(fromCents(c)), formatMoney(fromCents(d > c ? d - c : c - d))));
  });
  return out;
}

export function ExerciseEditor({ set, accounts }: { set: ExerciseSetDetail | null; accounts: Account[] }) {
  const router = useRouter();
  const [title, setTitle] = useState(set?.title ?? '');
  const [companyName, setCompanyName] = useState(set?.companyName ?? th.teacher.companyNameDefault);
  const [description, setDescription] = useState(set?.description ?? '');
  const [items, setItems] = useState<Item[]>(() => set?.items.map((i) => ({
    key: ++seq, date: isoToThai(i.date), narrative: i.narrative, points: i.points.replace(/\.00$/, ''),
    lines: i.lines.map((l) => line({ code: l.account_code, debit: l.debit ?? '', credit: l.credit ?? '' })),
  })) ?? [item()]);
  const [version, setVersion] = useState(set?.version ?? 0);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const issues = useMemo(() => problems(items, accounts), [items, accounts]);

  const setItem = (key: number, patch: Partial<Item>) => setItems((xs) => xs.map((x) => (x.key === key ? { ...x, ...patch } : x)));
  const setLine = (ik: number, lk: number, patch: Partial<Line>) =>
    setItems((xs) => xs.map((x) => (x.key === ik ? { ...x, lines: x.lines.map((l) => (l.key === lk ? { ...l, ...patch } : l)) } : x)));

  async function save() {
    setMsg(null);
    if (!title.trim() || !companyName.trim() || issues.length) { setMsg({ ok: false, text: issues[0] ?? t.setTitle }); return; }
    setBusy(true);
    const body = {
      title, companyName, description,
      items: items.map((it) => ({
        date: thaiToIso(it.date), narrative: it.narrative, points: it.points.trim(),
        lines: it.lines.filter((l) => l.code).map((l) => {
          const d = toCents(l.debit)!;
          return { account_code: l.code, ...(d > 0n ? { debit: fromCents(d) } : { credit: fromCents(toCents(l.credit)!) }) };
        }),
      })),
    };
    try {
      if (set) {
        const r = await api<{ version: number }>(`/teacher/exercises/${set.id}`, {
          method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, version }),
        });
        setVersion(r.version);
        setMsg({ ok: true, text: t.saved(r.version) });
        router.refresh();
      } else {
        const r = await postJson<{ id: string }>('/teacher/exercises', body);
        router.push(`/teacher/exercises/${r.id}`);
      }
    } catch (e) {
      setMsg({ ok: false, text: (e as ApiError).message });
    } finally {
      setBusy(false);
    }
  }

  const input = 'h-11 w-full border-b border-rule-input bg-transparent px-1 text-base';
  return (
    <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <div className="grid gap-3 border border-rule-strong bg-paper p-4 sm:grid-cols-2">
        <TextField label={t.setTitle} value={title} onChange={setTitle} maxLength={200} />
        <TextField label={t.companyName} value={companyName} onChange={setCompanyName} maxLength={120} />
        <div className="sm:col-span-2"><TextField label={t.description} value={description} onChange={setDescription} maxLength={4000} multiline /></div>
        <p className="text-[13px] text-ink2 sm:col-span-2">{t.accountsHint}{set && set.assignments.length > 0 ? ` · ${t.editAfterAssign}` : ''}</p>
      </div>

      <ol className="flex flex-col gap-4">
        {items.map((it, i) => {
          const d = it.lines.reduce((s, l) => s + (toCents(l.debit) ?? 0n), 0n);
          const c = it.lines.reduce((s, l) => s + (toCents(l.credit) ?? 0n), 0n);
          return (
            <li key={it.key} aria-label={t.item(i + 1)} className="flex flex-col gap-3 border border-rule-strong bg-paper p-4">
              <div className="flex flex-wrap items-baseline gap-3 border-b-2 border-ink pb-2">
                <h2 className="font-doc text-lg font-bold">{t.item(i + 1)}</h2>
                <div className="ml-auto flex gap-2">
                  {i > 0 && (
                    <button type="button" className="min-h-11 rounded-doc border border-ink px-3 text-sm"
                      onClick={() => setItems((xs) => { const ys = [...xs]; [ys[i - 1], ys[i]] = [ys[i]!, ys[i - 1]!]; return ys; })}>{t.moveUp}</button>
                  )}
                  {items.length > 1 && (
                    <button type="button" className="min-h-11 rounded-doc border border-ink px-3 text-sm"
                      onClick={() => setItems((xs) => xs.filter((x) => x.key !== it.key))}>{t.removeItem}</button>
                  )}
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-[10rem_minmax(0,1fr)_6rem]">
                <label className="flex flex-col text-sm">{t.date}
                  <input className={`${input} font-num`} inputMode="numeric" placeholder="วว/ดด/ปปปป" value={it.date}
                    aria-invalid={!thaiToIso(it.date)} onChange={(e) => setItem(it.key, { date: maskDate(e.target.value) })} />
                </label>
                <label className="flex flex-col text-sm">{t.narrative}
                  <textarea rows={2} className={`${input} h-auto min-h-11 resize-y py-2`} maxLength={2000} value={it.narrative}
                    onChange={(e) => setItem(it.key, { narrative: e.target.value })} />
                </label>
                <label className="flex flex-col text-sm">{t.points}
                  <input className={`${input} text-right font-num`} inputMode="decimal" value={it.points}
                    onChange={(e) => setItem(it.key, { points: e.target.value })} />
                </label>
              </div>
              <div className="flex flex-col">
                <p className="text-sm font-semibold">{t.answer}</p>
                <div className="hidden grid-cols-[minmax(0,1fr)_9rem_9rem_5.5rem] border-b border-rule bg-band text-sm sm:grid">
                  <span className="px-2 py-2">{t.account}</span>
                  <span className="border-l border-rule px-2 py-2 text-right">{th.money.debit}</span>
                  <span className="border-l border-rule px-2 py-2 text-right">{th.money.credit}</span>
                  <span />
                </div>
                {it.lines.map((l, k) => {
                  const acc = accounts.find((a) => a.code === l.code);
                  return (
                    <div key={l.key} className="grid grid-cols-2 gap-x-3 border-b border-rule py-1 sm:grid-cols-[minmax(0,1fr)_9rem_9rem_5.5rem] sm:gap-0 sm:py-0">
                      <div className="col-span-2 flex items-center gap-2 sm:col-span-1 sm:px-2">
                        <div className="w-28 shrink-0"><AccountField accounts={accounts} value={l.code} onChange={(code) => setLine(it.key, l.key, { code })}
                          label={`${t.item(i + 1)} ${t.account} ${k + 1}`} /></div>
                        <span className={`truncate text-[15px] ${(toCents(l.credit) ?? 0n) > 0n ? 'sm:pl-7' : ''} ${acc ? '' : 'text-ink2'}`}>{acc?.name ?? th.journal.accountSearchHint}</span>
                      </div>
                      <label className="flex flex-col text-[13px] sm:border-l sm:border-rule sm:px-2">
                        <span className="sm:sr-only">{th.money.debit}</span>
                        <input className="h-11 bg-transparent text-right font-num text-base" inputMode="decimal" value={l.debit}
                          aria-label={`${t.item(i + 1)} ${th.money.debit} ${k + 1}`} onChange={(e) => setLine(it.key, l.key, { debit: e.target.value })} />
                      </label>
                      <label className="flex flex-col text-[13px] sm:border-l sm:border-rule sm:px-2">
                        <span className="sm:sr-only">{th.money.credit}</span>
                        <input className="h-11 bg-transparent text-right font-num text-base" inputMode="decimal" value={l.credit}
                          aria-label={`${t.item(i + 1)} ${th.money.credit} ${k + 1}`} onChange={(e) => setLine(it.key, l.key, { credit: e.target.value })} />
                      </label>
                      {it.lines.length > 2 && (
                        <button type="button" className="col-span-2 min-h-11 text-sm underline sm:col-span-1 sm:border-l sm:border-rule"
                          onClick={() => setItem(it.key, { lines: it.lines.filter((x) => x.key !== l.key) })}>{t.removeLine}</button>
                      )}
                    </div>
                  );
                })}
                <div className="flex flex-wrap items-center gap-3 pt-2">
                  {it.lines.length < 20 && (
                    <button type="button" className="min-h-11 rounded-doc border border-ink px-3 text-sm"
                      onClick={() => setItem(it.key, { lines: [...it.lines, line()] })}>{t.addLine}</button>
                  )}
                  <span className={`ml-auto font-num text-sm ${d !== c ? 'neg' : ''}`}>
                    {th.money.debit} {formatMoney(fromCents(d))} · {th.money.credit} {formatMoney(fromCents(c))}
                    {d !== c ? ` · ${th.money.difference} ${formatMoney(fromCents(d > c ? d - c : c - d))}` : ` · ${th.money.balanced}`}
                  </span>
                </div>
              </div>
            </li>
          );
        })}
      </ol>

      <div className="sticky bottom-0 flex flex-wrap items-center gap-3 border-t border-rule-strong bg-ground py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        {items.length < 200 && (
          <button type="button" className="min-h-11 rounded-doc border border-ink px-4 font-medium"
            onClick={() => setItems((xs) => [...xs, item(xs[xs.length - 1]?.date ?? '')])}>{t.addItem}</button>
        )}
        <button type="submit" disabled={busy} className="min-h-11 rounded-doc bg-ink px-4 font-medium text-paper disabled:bg-disabled disabled:text-ink2 max-sm:min-h-13 max-sm:flex-1">
          {busy ? t.saving : t.save}
        </button>
        {msg && <p role={msg.ok ? 'status' : 'alert'} className={`basis-full text-sm ${msg.ok ? '' : 'neg'}`}>{msg.text}</p>}
        {!msg && issues.length > 0 && <p className="basis-full text-sm text-ink2">{issues[0]}</p>}
      </div>
    </form>
  );
}
