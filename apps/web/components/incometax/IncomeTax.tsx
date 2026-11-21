'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Button } from '@/components/Button';
import { Money } from '@/components/Money';
import { CheckField, TextField } from '@/components/Fields';
import { AccountSelect, ConfirmPanel, DateInput, PlainInput, errText, useAction } from '@/components/ConfirmPanel';
import { postJson, type CitPreview, type IncomeTaxFiling, type IncomeTaxPage } from '@/lib/api';
import { isoToThai, thaiToIso, todayIso } from '@/lib/date';
import { formatMoney, toCents } from '@/lib/money';
import { th } from '@/i18n/th';

const t = th.incomeTax;
const SIGNED = /^-?\d{1,16}(\.\d{1,2})?$/;

export function IncomeTax({ companyId, data }: { companyId: string; data: IncomeTaxPage }) {
  const writable = data.canWrite && !data.locked;
  const year = data.filings.filter((f) => f.yearEnd === data.yearEnd && !f.voided);
  return (
    <div className="flex flex-col gap-6">
      {!data.canWrite && <p className="text-sm text-ink2">{th.cheques.readOnly}</p>}
      {data.locked && <p role="status" className="border border-rule-strong bg-band px-4 py-2.5">{th.submission.lockedNote}</p>}
      <div className="grid gap-4 lg:grid-cols-2">
        <FormPanel companyId={companyId} data={data} form="51" filed={year.find((f) => f.form === '51')} writable={writable && !year.some((f) => f.form === '50')} />
        <FormPanel companyId={companyId} data={data} form="50" filed={year.find((f) => f.form === '50')} writable={writable} />
      </div>
      <FilingList companyId={companyId} data={data} writable={writable} />
    </div>
  );
}

function Line({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`grid grid-cols-[minmax(0,1fr)_auto] gap-3 border-b border-rule-faint py-1.5 ${strong ? 'font-semibold' : ''}`}>
      <span>{label}</span><Money value={value} />
    </div>
  );
}

function FormPanel({ companyId, data, form, filed, writable }: { companyId: string; data: IncomeTaxPage; form: '51' | '50'; filed?: IncomeTaxFiling; writable: boolean }) {
  const base = (form === '51' ? data.preview51 : data.preview50)!;
  const [p, setP] = useState<CitPreview>(base);
  const [profit, setProfit] = useState(base.profit);
  const [revenue, setRevenue] = useState(base.revenue);
  const [useWht, setUseWht] = useState(false);
  const [date, setDate] = useState(isoToThai(todayIso() > base.date ? todayIso() : base.date));
  const [cash, setCash] = useState(data.cashAccounts[0]?.code ?? '');
  const [done, setDone] = useState<string | null>(null);
  const [calcErr, setCalcErr] = useState<string | null>(null);
  const a = useAction();
  const iso = form === '51' ? thaiToIso(date) : base.yearEnd;
  const inputsOk = form === '50' || (SIGNED.test(profit.trim()) && toCents(revenue.trim()) !== null && iso !== null);
  // คำนวณใหม่ที่ DB ทุกครั้งที่ตัวเลขเปลี่ยน (ตัวเลขบนจอ = ตัวเลขที่จะลงบัญชี)
  useEffect(() => {
    if (!inputsOk) return;
    let live = true;
    const body = { form, yearEnd: base.yearEnd, useWht, ...(form === '51' ? { estimatedProfit: profit.trim(), estimatedRevenue: revenue.trim(), date: iso } : {}) };
    postJson<CitPreview>(`/companies/${companyId}/income-tax/preview`, body)
      .then((r) => { if (live) { setP(r); setCalcErr(null); } }).catch((e) => { if (live) setCalcErr(errText(e)); });
    return () => { live = false; };
  }, [companyId, form, base.yearEnd, profit, revenue, useWht, iso, inputsOk]);
  const end = isoToThai(p.periodEnd);
  return (
    <form aria-label={form === '51' ? t.form51 : t.form50} className="flex flex-col gap-3 border border-rule-strong bg-paper p-4 sm:p-6"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!inputsOk) return;
        const r = await a.run<IncomeTaxFiling>(`/companies/${companyId}/income-tax`, {
          form, yearEnd: base.yearEnd, useWht,
          ...(form === '51' ? { estimatedProfit: profit.trim(), estimatedRevenue: revenue.trim(), date: iso, ...(cash ? { cashAccount: cash } : {}) } : {}),
        });
        if (r) setDone(t.filed(r.docNo));
      }}>
      <h2 className="font-doc text-[18px] font-bold">{form === '51' ? t.form51 : t.form50}</h2>
      <p className="text-[13px] text-ink2">{form === '51' ? t.note51(end) : t.note50(isoToThai(p.yearEnd))}</p>
      <div className="flex flex-col text-[15px]">
        <Line label={t.actualProfit(end)} value={p.actualProfit} />
        <Line label={t.actualRevenue(end)} value={p.actualRevenue} />
        <Line label={t.paidUp} value={p.paidUp} />
      </div>
      {form === '51' && !filed && writable && (
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField label={t.estimatedProfit} value={profit} onChange={setProfit} inputMode="decimal" mono hint={t.estimateHint} />
          <TextField label={t.estimatedRevenue} value={revenue} onChange={setRevenue} inputMode="decimal" mono />
        </div>
      )}
      <div className="flex flex-col text-[15px]">
        <Line label={form === '51' ? t.estimatedProfit : t.profit} value={p.profit} />
        <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 border-b border-rule-faint py-1.5"><span>{t.rate}</span><span>{p.sme ? t.sme : t.general}</span></div>
        {form === '51' && <Line label={t.taxFull} value={p.taxFull} />}
        <Line strong label={form === '51' ? t.tax51 : t.tax50} value={p.tax} />
        {form === '50' && <Line label={t.prepaid} value={p.creditPrepaid} />}
        {useWht && <Line label={t.creditWht} value={p.creditWht} />}
        <Line strong label={form === '51' ? t.payable51 : t.payable50} value={p.payable} />
      </div>
      {filed ? <p role="status" className="text-[15px]">{t.already(filed.docNo)}</p> : writable && (
        <>
          <CheckField label={t.useWht} checked={useWht} onChange={setUseWht} note={t.whtBalance(formatMoney(p.whtBalance))} />
          {form === '51' && (
            <div className="grid gap-3 sm:grid-cols-2">
              <DateInput label={t.date51} value={date} onChange={setDate} invalid={iso === null} />
              <AccountSelect label={t.cashAccount} value={cash} onChange={setCash} accounts={data.cashAccounts} />
            </div>
          )}
          {(a.error || calcErr) && <p role="alert" className="neg text-[15px]">{a.error ?? calcErr}</p>}
          {done && <p role="status" className="text-[15px]">{done}</p>}
          <div><Button type="submit" disabled={a.busy || !inputsOk || calcErr !== null} className="max-sm:w-full">{form === '51' ? t.file51 : t.file50}</Button></div>
        </>
      )}
    </form>
  );
}

function FilingList({ companyId, data, writable }: { companyId: string; data: IncomeTaxPage; writable: boolean }) {
  const [open, setOpen] = useState<{ id: string; kind: 'pay' | 'payment' | 'filing' } | null>(null);
  return (
    <section aria-label={t.list} className="flex flex-col gap-2">
      <h2 className="text-[17px] font-semibold">{t.list}</h2>
      {data.filings.length === 0 ? <p className="text-ink2">{t.empty}</p> : (
        <ul className="border-t border-rule-strong bg-paper">
          {data.filings.map((f) => (
            <li key={f.id} className={`flex flex-col gap-1 border-b border-rule px-4 py-3 ${f.voided ? 'text-ink2' : ''}`}>
              <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3">
                <span>
                  {f.docNo && f.entryId ? <Link href={`/c/${companyId}/journal/${f.entryId}`} className="font-num underline decoration-rule-input">{f.docNo}</Link> : null}
                  {' '}{isoToThai(f.date)} · {t.row(f.form, isoToThai(f.yearStart), isoToThai(f.yearEnd))}
                </span>
                <Money value={f.tax} />
              </div>
              <span className="text-[13px]">
                {f.voided ? t.voided(f.voidDocNo, f.voidReason ?? '')
                  : f.form === '50' && f.payable !== '0.00' ? (f.paidOn ? t.paid(f.payDocNo ?? '', isoToThai(f.paidOn)) : t.unpaid(formatMoney(f.payable))) : ''}
              </span>
              {writable && !f.voided && (
                <div className="flex flex-wrap gap-2">
                  {f.form === '50' && f.payable !== '0.00' && !f.paidOn && <Button type="button" className="min-h-11 px-3 text-sm" onClick={() => setOpen({ id: f.id, kind: 'pay' })}>{t.pay}</Button>}
                  {f.paidOn
                    ? <Button type="button" variant="secondary" className="min-h-11 px-3 text-sm" onClick={() => setOpen({ id: f.id, kind: 'payment' })}>{t.voidPay}</Button>
                    : <Button type="button" variant="secondary" className="min-h-11 px-3 text-sm" onClick={() => setOpen({ id: f.id, kind: 'filing' })}>{t.voidFiling}</Button>}
                </div>
              )}
              {open?.id === f.id && open.kind === 'pay' && <PayPanel companyId={companyId} row={f} cash={data.cashAccounts} onDone={() => setOpen(null)} />}
              {open?.id === f.id && open.kind !== 'pay' && <VoidPanel companyId={companyId} row={f} what={open.kind} onDone={() => setOpen(null)} />}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function PayPanel({ companyId, row, cash, onDone }: { companyId: string; row: IncomeTaxFiling; cash: { code: string; name: string }[]; onDone: () => void }) {
  const [date, setDate] = useState(isoToThai(todayIso() > row.yearEnd ? todayIso() : row.yearEnd));
  const [account, setAccount] = useState(cash[0]?.code ?? '');
  const a = useAction();
  const iso = thaiToIso(date);
  return (
    <ConfirmPanel title={t.payTitle(row.docNo ?? '')} explain={t.payExplain} ready={iso !== null && account !== ''} busy={a.busy} error={a.error} onCancel={onDone}
      onConfirm={async () => { if (await a.run(`/companies/${companyId}/income-tax/${row.id}/pay`, { date: iso, cashAccount: account })) onDone(); }}>
      <div className="grid gap-3 @md:grid-cols-2">
        <DateInput label={t.payDate} value={date} onChange={setDate} invalid={iso === null} />
        <AccountSelect label={t.cashAccount} value={account} onChange={setAccount} accounts={cash} />
      </div>
    </ConfirmPanel>
  );
}

function VoidPanel({ companyId, row, what, onDone }: { companyId: string; row: IncomeTaxFiling; what: 'payment' | 'filing'; onDone: () => void }) {
  const base = what === 'payment' ? row.paidOn ?? row.date : row.date;
  const [date, setDate] = useState(isoToThai(base));
  const [reason, setReason] = useState('');
  const a = useAction();
  const iso = thaiToIso(date);
  const no = (what === 'payment' ? row.payDocNo : row.docNo) ?? t.row(row.form, isoToThai(row.yearStart), isoToThai(row.yearEnd));
  return (
    <ConfirmPanel title={t.voidTitle(no)} explain={t.voidExplain} ready={iso !== null && reason.trim() !== ''} busy={a.busy} error={a.error} onCancel={onDone}
      onConfirm={async () => { if (await a.run(`/companies/${companyId}/income-tax/${row.id}/void`, { what, date: iso, reason: reason.trim() })) onDone(); }}>
      <div className="grid gap-3 @md:grid-cols-2">
        <DateInput label={t.voidDate} value={date} onChange={setDate} invalid={iso === null} />
        <PlainInput label={t.reason} value={reason} onChange={setReason} maxLength={300} />
      </div>
    </ConfirmPanel>
  );
}
