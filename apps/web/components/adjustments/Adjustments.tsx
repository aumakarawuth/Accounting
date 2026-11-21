'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Button } from '@/components/Button';
import { Money } from '@/components/Money';
import { SelectField, TextField } from '@/components/Fields';
import { ConfirmPanel, DateInput, PlainInput, useAction } from '@/components/ConfirmPanel';
import type { AdjustmentPage, AdjustmentRow } from '@/lib/api';
import { isoToThai, monthLabel, thaiToIso, todayIso } from '@/lib/date';
import { formatMoney, fromCents, toCents } from '@/lib/money';
import { th } from '@/i18n/th';

const t = th.adjustments;
type Kind = 'accrued_expense' | 'accrued_revenue' | 'prepaid_expense' | 'unearned_revenue';
const KINDS: Kind[] = ['accrued_expense', 'accrued_revenue', 'prepaid_expense', 'unearned_revenue'];
const SPEC: Record<Kind, { pl: 'expense' | 'revenue'; bs: 'asset' | 'liability'; bsDefault: string; methods: string[] }> = {
  accrued_expense: { pl: 'expense', bs: 'liability', bsDefault: '2310', methods: [] },
  accrued_revenue: { pl: 'revenue', bs: 'asset', bsDefault: '1230', methods: [] },
  prepaid_expense: { pl: 'expense', bs: 'asset', bsDefault: '1510', methods: ['asset', 'expense'] },
  unearned_revenue: { pl: 'revenue', bs: 'liability', bsDefault: '2410', methods: ['liability', 'revenue'] },
};
/** เดบิตบัญชีกำไรขาดทุนหรือไม่ และกลับรายการได้หรือไม่ (ตรงกับ acc.post_adjustment) */
function sides(kind: Kind, method: string) {
  switch (kind) {
    case 'accrued_expense': return { drPl: true, reversible: true };
    case 'accrued_revenue': return { drPl: false, reversible: true };
    case 'prepaid_expense': return { drPl: method === 'asset', reversible: method === 'expense' };
    default: return { drPl: method === 'revenue', reversible: method === 'revenue' };
  }
}

/** รายการปรับปรุงสิ้นเดือน + กลับรายการอัตโนมัติ (docs/phase6-spec.md ข้อ 5) */
export function Adjustments({ companyId, data, month }: { companyId: string; data: AdjustmentPage; month: string }) {
  const writable = data.canWrite && !data.locked;
  return (
    <div className="flex flex-col gap-6">
      {!data.canWrite && <p className="text-sm text-ink2">{th.cheques.readOnly}</p>}
      {data.locked && <p role="status" className="border border-rule-strong bg-band px-4 py-2.5">{th.submission.lockedNote}</p>}
      {writable && <AdjustmentForm companyId={companyId} data={data} month={month} />}
      <AdjustmentList companyId={companyId} rows={data.adjustments} writable={writable} />
    </div>
  );
}

function AdjustmentForm({ companyId, data, month }: { companyId: string; data: AdjustmentPage; month: string }) {
  const [kind, setKind] = useState<Kind>('accrued_expense');
  const spec = SPEC[kind];
  const [method, setMethod] = useState('');
  const plAccounts = data.accounts.filter((a) => a.type === spec.pl);
  const bsAccounts = data.accounts.filter((a) => a.type === spec.bs);
  const [pl, setPl] = useState('');
  const [bs, setBs] = useState('');
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [auto, setAuto] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const a = useAction();
  const m = spec.methods.length ? (method || spec.methods[0]!) : '';
  const s = sides(kind, m);
  const plCode = pl || plAccounts[0]?.code || '';
  const bsCode = bs || spec.bsDefault;
  const bsName = data.accounts.find((x) => x.code === bsCode)?.name ?? (bsCode === '1230' ? t.accruedRevenueAccount : '');
  const plName = data.accounts.find((x) => x.code === plCode)?.name ?? '';
  const cents = toCents(amount.trim());
  const valid = Boolean(plCode && cents !== null && cents > 0n);
  const dr = s.drPl ? `${plCode} ${plName}` : `${bsCode} ${bsName}`;
  const cr = s.drPl ? `${bsCode} ${bsName}` : `${plCode} ${plName}`;

  return (
    <form aria-label={t.form} className="flex flex-col gap-4 border border-rule-strong bg-paper p-4 sm:p-6"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!valid) return;
        const r = await a.run<AdjustmentRow>(`/companies/${companyId}/adjustments`, {
          month, kind, ...(m ? { method: m } : {}), plAccount: plCode, ...(bs ? { bsAccount: bs } : {}), amount: fromCents(cents!),
          ...(description.trim() ? { description: description.trim() } : {}), autoReverse: s.reversible && auto,
        });
        if (r) { setDone(r.reversalDocNo ? t.postedWithReverse(r.docNo, r.reversalDocNo) : t.posted(r.docNo)); setAmount(''); setDescription(''); }
      }}>
      <h2 className="text-[17px] font-semibold">{t.form} · {t.monthHint(monthLabel(month))}</h2>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <SelectField label={t.kind} value={kind} onChange={(v) => { setKind(v as Kind); setMethod(''); setPl(''); setBs(''); setDone(null); }}>
          {KINDS.map((k) => <option key={k} value={k}>{t.kinds[k]}</option>)}
        </SelectField>
        {spec.methods.length > 0 && (
          <SelectField label={t.method} value={m} onChange={(v) => { setMethod(v); setDone(null); }}>
            {spec.methods.map((x) => <option key={x} value={x}>{t.methods[x]}</option>)}
          </SelectField>
        )}
        <SelectField label={spec.pl === 'expense' ? t.expenseAccount : t.revenueAccount} value={plCode} onChange={setPl}>
          {plAccounts.map((x) => <option key={x.code} value={x.code}>{x.code} {x.name}</option>)}
        </SelectField>
        <SelectField label={t.bsAccount} value={bsCode} onChange={setBs}>
          {!bsAccounts.some((x) => x.code === spec.bsDefault) && <option value={spec.bsDefault}>{spec.bsDefault} {bsName} {t.willCreate}</option>}
          {bsAccounts.map((x) => <option key={x.code} value={x.code}>{x.code} {x.name}</option>)}
        </SelectField>
        <TextField label={t.amount} value={amount} onChange={setAmount} inputMode="decimal" mono hint={t.amountHint[`${kind}${m ? `:${m}` : ''}`]} />
        <TextField label={t.description} value={description} onChange={setDescription} maxLength={300} />
      </div>
      <label className={`flex min-h-11 items-center gap-3 ${s.reversible ? '' : 'text-ink2'}`}>
        <input type="checkbox" className="size-5 shrink-0 text-base accent-ink" checked={s.reversible && auto} disabled={!s.reversible} onChange={(e) => setAuto(e.target.checked)} />
        <span>{t.autoReverse}</span>
      </label>
      <p className="text-[13px] text-ink2">{s.reversible ? t.reverseNote : t.noReverseNote}</p>
      <p className="text-sm">{t.entry(dr, cr, cents !== null && cents > 0n ? formatMoney(fromCents(cents)) : '—')}</p>
      {s.reversible && auto && <p className="text-sm">{t.reverseEntry(cr, dr)}</p>}
      {a.error && <p role="alert" className="neg text-[15px]">{a.error}</p>}
      {done && <p role="status" className="text-[15px]">{done}</p>}
      <div><Button type="submit" disabled={a.busy || !valid} className="max-sm:w-full">{t.post}</Button></div>
    </form>
  );
}

function AdjustmentList({ companyId, rows, writable }: { companyId: string; rows: AdjustmentRow[]; writable: boolean }) {
  const [voiding, setVoiding] = useState<string | null>(null);
  return (
    <section aria-label={t.list} className="flex flex-col gap-2">
      <h2 className="text-[17px] font-semibold">{t.list}</h2>
      {rows.length === 0 ? <p className="text-ink2">{t.empty}</p> : (
        <ul className="border-t border-rule-strong bg-paper">
          {rows.map((r) => (
            <li key={r.id} className={`flex flex-col gap-1 border-b border-rule px-4 py-3 ${r.voided ? 'text-ink2' : ''}`}>
              <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3">
                <span>
                  <Link href={`/c/${companyId}/journal/${r.entryId}`} className="font-num underline decoration-rule-input">{r.docNo}</Link>
                  {' '}{isoToThai(r.date)} · {t.kinds[r.kind]}{r.method ? ` (${t.methods[r.method]})` : ''}
                </span>
                <Money value={r.amount} />
                <span className="text-[13px] text-ink2">{r.description} · {r.plAccount} / {r.bsAccount}</span>
              </div>
              {r.reversalDocNo && <span className="text-[13px]">{t.reversedOn(r.reversalDocNo, isoToThai(r.reversalDate!))}</span>}
              {r.voided && <span className="text-[13px]">{t.voided(r.voidDocNo ?? '', r.voidReason ?? '')}</span>}
              {writable && !r.voided && <div><Button type="button" variant="secondary" className="min-h-11 px-3 text-sm" onClick={() => setVoiding(r.id)}>{t.void}</Button></div>}
              {voiding === r.id && <VoidPanel companyId={companyId} row={r} onDone={() => setVoiding(null)} />}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function VoidPanel({ companyId, row, onDone }: { companyId: string; row: AdjustmentRow; onDone: () => void }) {
  const [date, setDate] = useState(isoToThai(todayIso() > row.date ? todayIso() : row.date));
  const [reason, setReason] = useState('');
  const a = useAction();
  const iso = thaiToIso(date);
  return (
    <ConfirmPanel title={t.voidTitle(row.docNo)} explain={row.reversalDocNo ? t.voidExplainBoth(row.reversalDocNo) : t.voidExplain} ready={iso !== null && reason.trim() !== ''}
      busy={a.busy} error={a.error} onCancel={onDone}
      onConfirm={async () => {
        const r = await a.run(`/companies/${companyId}/adjustments/${row.id}/void`, { date: iso, reason: reason.trim() });
        if (r) onDone();
      }}>
      <div className="grid gap-3 @md:grid-cols-2">
        <DateInput label={t.voidDate} value={date} onChange={setDate} invalid={iso === null} />
        <PlainInput label={t.reason} value={reason} onChange={setReason} maxLength={300} />
      </div>
    </ConfirmPanel>
  );
}
