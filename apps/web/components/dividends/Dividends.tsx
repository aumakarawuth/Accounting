'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Button } from '@/components/Button';
import { Money } from '@/components/Money';
import { SelectField, TextField } from '@/components/Fields';
import { AccountSelect, ConfirmPanel, DateInput, PlainInput, errText, useAction } from '@/components/ConfirmPanel';
import { api, type DividendPage, type DividendRow } from '@/lib/api';
import { isoToThai, maskDate, thaiToIso, todayIso } from '@/lib/date';
import { formatMoney, fromCents, toCents } from '@/lib/money';
import { th } from '@/i18n/th';

const t = th.dividends;

/** หุ้นที่ออก × ต่อหุ้น (สตางค์ ปัดครึ่งขึ้น) — ตรงกับ acc.declare_dividend */
function dividendCents(shares: string | null, perShare: string): bigint | null {
  if (!shares || !/^\d{1,12}(\.\d{1,4})?$/.test(perShare)) return null;
  const s4 = BigInt(Math.round(Number(shares) * 10000)), [i, f = ''] = perShare.split('.');
  const p4 = BigInt(i!) * 10000n + BigInt((f + '0000').slice(0, 4));
  const raw = s4 * p4; // หน่วย 1e-8 บาท
  return (raw + 500000n) / 1000000n;
}

export function Dividends({ companyId, data }: { companyId: string; data: DividendPage }) {
  const writable = data.canWrite && !data.locked;
  return (
    <div className="flex flex-col gap-6">
      {!data.canWrite && <p className="text-sm text-ink2">{th.cheques.readOnly}</p>}
      {data.locked && <p role="status" className="border border-rule-strong bg-band px-4 py-2.5">{th.submission.lockedNote}</p>}
      {writable && <DeclareForm companyId={companyId} data={data} />}
      <DividendList companyId={companyId} data={data} writable={writable} />
    </div>
  );
}

function DeclareForm({ companyId, data }: { companyId: string; data: DividendPage }) {
  const [date, setDate] = useState(isoToThai(todayIso()));
  const iso = thaiToIso(date);
  const [p, setP] = useState(data.preview);
  const [basis, setBasis] = useState<'perShare' | 'amount'>('perShare');
  const [perShare, setPerShare] = useState('');
  const [amount, setAmount] = useState('');
  // ทุนสำรองตั้งต้น = ขั้นต่ำตามกฎหมาย ณ วันที่ประกาศ จนกว่านักเรียนจะแก้เอง
  const [reserveInput, setReserve] = useState<string | null>(null);
  const reserve = reserveInput ?? p.minReserve;
  const [description, setDescription] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const a = useAction();
  const [factsErr, setFactsErr] = useState<string | null>(null);
  // ข้อมูล ณ วันที่ประกาศ (กำไรสะสม ทุนสำรองขั้นต่ำ) โหลดใหม่เมื่อเปลี่ยนวันที่
  useEffect(() => {
    if (!iso || iso === p.date) return;
    let live = true;
    api<DividendPage>(`/companies/${companyId}/dividends?date=${iso}`)
      .then((r) => { if (live) { setP(r.preview); setFactsErr(null); } })
      .catch((e) => { if (live) setFactsErr(errText(e)); });
    return () => { live = false; };
  }, [iso, p.date, companyId]);
  const total = basis === 'perShare' ? dividendCents(p.shares, perShare.trim()) : toCents(amount.trim());
  const res = toCents(reserve.trim() || '0');
  const valid = iso !== null && total !== null && total > 0n && res !== null;
  const fact = (label: string, v: string | null, money = true) => (
    <div className="contents"><dt className="text-ink2">{label}</dt><dd className="text-right">{v === null ? '—' : money ? <Money value={v} /> : <span className="font-num">{Number(v).toLocaleString('th-TH')}</span>}</dd></div>
  );
  return (
    <form aria-label={t.form} className="flex flex-col gap-4 border border-rule-strong bg-paper p-4 sm:p-6"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!valid) return;
        const r = await a.run<DividendRow>(`/companies/${companyId}/dividends`, {
          date: iso, ...(basis === 'perShare' ? { perShare: perShare.trim() } : { amount: fromCents(total!) }), reserve: fromCents(res!),
          ...(description.trim() ? { description: description.trim() } : {}),
        });
        if (r) { setDone(t.declared(r.docNo)); setPerShare(''); setAmount(''); }
      }}>
      <h2 className="text-[17px] font-semibold">{t.form}</h2>
      <section aria-label={t.facts} className="max-w-xl">
        <h3 className="pb-1 text-sm font-medium">{t.facts}</h3>
        <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 text-[15px]">
          {fact(t.retained, p.retained)}
          {fact(t.reserve, p.reserve)}
          {fact(t.shareCapital, p.shareCapital)}
          {fact(t.shares, p.shares, false)}
          {fact(t.lastProfit, p.lastYearProfit)}
          {fact(t.minReserve, p.minReserve)}
        </dl>
      </section>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <label className="flex min-w-0 flex-col text-sm">{t.date}
          <input className="h-11 w-full border-b border-rule-input bg-transparent font-num text-base" inputMode="numeric" value={date}
            aria-invalid={iso === null} onChange={(e) => setDate(maskDate(e.target.value))} />
        </label>
        <SelectField label={t.basis} value={basis} onChange={(v) => setBasis(v as 'perShare' | 'amount')}>
          <option value="perShare">{t.perShareBasis}</option>
          <option value="amount">{t.amountBasis}</option>
        </SelectField>
        {basis === 'perShare'
          ? <TextField label={t.perShare} value={perShare} onChange={setPerShare} inputMode="decimal" mono
              hint={total !== null && p.shares ? t.computed(Number(p.shares).toLocaleString('th-TH'), perShare, formatMoney(fromCents(total))) : undefined} />
          : <TextField label={t.amount} value={amount} onChange={setAmount} inputMode="decimal" mono />}
        <TextField label={t.reserveAmount} value={reserve} onChange={setReserve} inputMode="decimal" mono
          error={res !== null && res < (toCents(p.minReserve) ?? 0n) ? t.belowMin(formatMoney(p.minReserve)) : null} />
        <TextField label={t.description} value={description} onChange={setDescription} maxLength={300} />
      </div>
      <p className="text-sm">{t.entry(total !== null && res !== null ? formatMoney(fromCents(total + res)) : '—', res && res > 0n ? t.entryReserve(formatMoney(fromCents(res))) : '')}</p>
      {(a.error || factsErr) && <p role="alert" className="neg text-[15px]">{a.error ?? factsErr}</p>}
      {done && <p role="status" className="text-[15px]">{done}</p>}
      <div><Button type="submit" disabled={a.busy || !valid} className="max-sm:w-full">{t.declare}</Button></div>
    </form>
  );
}

function DividendList({ companyId, data, writable }: { companyId: string; data: DividendPage; writable: boolean }) {
  const [open, setOpen] = useState<{ id: string; kind: 'pay' | 'payment' | 'declaration' } | null>(null);
  return (
    <section aria-label={t.list} className="flex flex-col gap-2">
      <h2 className="text-[17px] font-semibold">{t.list}</h2>
      {data.dividends.length === 0 ? <p className="text-ink2">{t.empty}</p> : (
        <ul className="border-t border-rule-strong bg-paper">
          {data.dividends.map((d) => (
            <li key={d.id} className={`flex flex-col gap-1 border-b border-rule px-4 py-3 ${d.voided ? 'text-ink2' : ''}`}>
              <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3">
                <span>
                  <Link href={`/c/${companyId}/journal/${d.entryId}`} className="font-num underline decoration-rule-input">{d.docNo}</Link>
                  {' '}{isoToThai(d.date)} · {d.description}
                </span>
                <Money value={d.amount} />
              </div>
              {d.reserve !== '0.00' && <span className="text-[13px]">{t.reserveAmount} {formatMoney(d.reserve)}</span>}
              <span className="text-[13px]">{d.voided ? t.voided(d.voidDocNo ?? '', d.voidReason ?? '') : d.paidOn ? t.paid(d.payDocNo ?? '', isoToThai(d.paidOn)) : t.unpaid}</span>
              {writable && !d.voided && (
                <div className="flex flex-wrap gap-2">
                  {!d.paidOn && <Button type="button" className="min-h-11 px-3 text-sm" onClick={() => setOpen({ id: d.id, kind: 'pay' })}>{t.pay}</Button>}
                  {d.paidOn
                    ? <Button type="button" variant="secondary" className="min-h-11 px-3 text-sm" onClick={() => setOpen({ id: d.id, kind: 'payment' })}>{t.voidPay}</Button>
                    : <Button type="button" variant="secondary" className="min-h-11 px-3 text-sm" onClick={() => setOpen({ id: d.id, kind: 'declaration' })}>{t.voidDeclare}</Button>}
                </div>
              )}
              {open?.id === d.id && open.kind === 'pay' && <PayPanel companyId={companyId} row={d} cash={data.cashAccounts} onDone={() => setOpen(null)} />}
              {open?.id === d.id && open.kind !== 'pay' && <VoidPanel companyId={companyId} row={d} what={open.kind} onDone={() => setOpen(null)} />}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function PayPanel({ companyId, row, cash, onDone }: { companyId: string; row: DividendRow; cash: { code: string; name: string }[]; onDone: () => void }) {
  const [date, setDate] = useState(isoToThai(todayIso() > row.date ? todayIso() : row.date));
  const [account, setAccount] = useState(cash[0]?.code ?? '');
  const a = useAction();
  const iso = thaiToIso(date);
  return (
    <ConfirmPanel title={t.payTitle(row.docNo)} explain={t.payExplain} ready={iso !== null && account !== ''} busy={a.busy} error={a.error} onCancel={onDone}
      onConfirm={async () => { if (await a.run(`/companies/${companyId}/dividends/${row.id}/pay`, { date: iso, cashAccount: account })) onDone(); }}>
      <div className="grid gap-3 @md:grid-cols-2">
        <DateInput label={t.payDate} value={date} onChange={setDate} invalid={iso === null} />
        <AccountSelect label={t.cashAccount} value={account} onChange={setAccount} accounts={cash} />
      </div>
    </ConfirmPanel>
  );
}

function VoidPanel({ companyId, row, what, onDone }: { companyId: string; row: DividendRow; what: 'payment' | 'declaration'; onDone: () => void }) {
  const base = what === 'payment' ? row.paidOn ?? row.date : row.date;
  const [date, setDate] = useState(isoToThai(todayIso() > base ? todayIso() : base));
  const [reason, setReason] = useState('');
  const a = useAction();
  const iso = thaiToIso(date);
  const no = what === 'payment' ? row.payDocNo ?? '' : row.docNo;
  return (
    <ConfirmPanel title={t.voidTitle(no)} explain={t.voidExplain} ready={iso !== null && reason.trim() !== ''} busy={a.busy} error={a.error} onCancel={onDone}
      onConfirm={async () => { if (await a.run(`/companies/${companyId}/dividends/${row.id}/void`, { what, date: iso, reason: reason.trim() })) onDone(); }}>
      <div className="grid gap-3 @md:grid-cols-2">
        <DateInput label={t.voidDate} value={date} onChange={setDate} invalid={iso === null} />
        <PlainInput label={t.reason} value={reason} onChange={setReason} maxLength={300} />
      </div>
    </ConfirmPanel>
  );
}
