'use client';

import Link from 'next/link';
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/Button';
import { Money } from '@/components/Money';
import { SelectField, TextField } from '@/components/Fields';
import { ConfirmPanel, DateInput, PlainInput, useAction } from '@/components/ConfirmPanel';
import { postJson, type ApiError, type CashTransferPage, type CashTransferRow } from '@/lib/api';
import { isoToThai, maskDate, thaiToIso, todayIso } from '@/lib/date';
import { formatMoney, fromCents, toCents } from '@/lib/money';
import { th } from '@/i18n/th';

const t = th.cashTransfers;
const errText = (e: unknown) => {
  const err = e as ApiError;
  return err.code === 'server' ? th.error.server(err.ref ?? '-') : err.message;
};
// ฝาก = เงินสด → ธนาคาร · ถอน = ธนาคาร → เงินสด · นอกนั้น = โอนระหว่างบัญชี
const kindOf = (from: string, to: string) => (from === '1110' ? t.kind.deposit : to === '1110' ? t.kind.withdraw : t.kind.transfer);

/** ฟอร์มย้ายเงิน + รายการย้ายเงิน (ตารางบนจอกว้าง รายการบนมือถือ) */
export function CashTransfers({ companyId, data }: { companyId: string; data: CashTransferPage }) {
  const writable = data.company.canWrite && !data.company.locked;
  return (
    <div className="flex flex-col gap-6">
      {!data.company.canWrite && <p className="text-sm text-ink2">{th.cheques.readOnly}</p>}
      {data.company.locked && <p role="status" className="border border-rule-strong bg-band px-4 py-2.5">{th.submission.lockedNote}</p>}
      {writable && <TransferForm companyId={companyId} data={data} />}
      <TransferList companyId={companyId} rows={data.transfers} writable={writable} />
    </div>
  );
}

function TransferForm({ companyId, data }: { companyId: string; data: CashTransferPage }) {
  const router = useRouter();
  const accounts = data.cashAccounts;
  const [from, setFrom] = useState(accounts[0]?.code ?? '');
  const [to, setTo] = useState(accounts[1]?.code ?? '');
  const [date, setDate] = useState(isoToThai(todayIso()));
  const [amount, setAmount] = useState('');
  const [fee, setFee] = useState('');
  const [feeAccount, setFeeAccount] = useState(data.expenseAccounts.find((a) => a.code === '5260')?.code ?? data.expenseAccounts[0]?.code ?? '');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const key = useRef(crypto.randomUUID());
  const iso = thaiToIso(date);
  const cents = toCents(amount.trim());
  const feeCents = fee.trim() === '' ? 0n : toCents(fee.trim());
  const valid = Boolean(from && to && from !== to && iso && cents !== null && cents > 0n && feeCents !== null && feeCents >= 0n);
  const name = (code: string) => `${code} ${accounts.find((a) => a.code === code)?.name ?? ''}`.trim();

  async function submit() {
    if (busy) return;
    if (!valid) { setMsg({ ok: false, text: t.invalid }); return; }
    setBusy(true);
    setMsg(null);
    try {
      const r = await postJson<CashTransferRow>(`/companies/${companyId}/cash-transfers`, {
        date: iso, from, to, amount: fromCents(cents!),
        ...(feeCents! > 0n ? { fee: fromCents(feeCents!), feeAccount } : {}),
        ...(description.trim() ? { description: description.trim() } : {}),
      }, { 'idempotency-key': key.current });
      key.current = crypto.randomUUID();
      setAmount('');
      setFee('');
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
    <form className="flex flex-col gap-4 border border-rule-strong bg-paper p-4 sm:p-6" aria-label={t.form}
      onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <h2 className="text-[17px] font-semibold">{t.form}{from && to && from !== to ? ` · ${kindOf(from, to)}` : ''}</h2>
      <div className="grid gap-4 sm:grid-cols-2 sm:gap-6 lg:grid-cols-3">
        <SelectField label={t.from} value={from} onChange={setFrom}>
          {accounts.map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}
        </SelectField>
        <SelectField label={t.to} value={to} onChange={setTo}>
          {accounts.map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}
        </SelectField>
        <TextField label={t.date} value={date} onChange={(v) => setDate(maskDate(v))} inputMode="numeric" mono />
        <TextField label={t.amount} value={amount} onChange={setAmount} inputMode="decimal" mono />
        <TextField label={t.fee} value={fee} onChange={setFee} inputMode="decimal" mono />
        {feeCents !== null && feeCents > 0n && (
          <SelectField label={t.feeAccount} value={feeAccount} onChange={setFeeAccount}>
            {data.expenseAccounts.map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}
          </SelectField>
        )}
      </div>
      <TextField label={t.description} value={description} onChange={setDescription} maxLength={300} />
      {from && to && from !== to && <p className="text-sm">{t.entry(name(to), name(from), feeCents !== null && feeCents > 0n)}</p>}
      {msg && <p role={msg.ok ? 'status' : 'alert'} className={msg.ok ? 'text-[15px]' : 'neg text-[15px]'}>{msg.text}</p>}
      <div><Button type="submit" disabled={busy} className="max-sm:w-full">{t.save}</Button></div>
    </form>
  );
}

function TransferList({ companyId, rows, writable }: { companyId: string; rows: CashTransferRow[]; writable: boolean }) {
  const [voiding, setVoiding] = useState<string | null>(null);
  const cell = 'border border-rule px-2.5 py-2 align-top';
  const move = (r: CashTransferRow) => (
    <>
      <span>{t.move(kindOf(r.from, r.to), `${r.from} ${r.fromName}`, `${r.to} ${r.toName}`)}</span>
      {r.fee !== '0.00' && <span className="block text-[13px] text-ink2">{t.feeText(formatMoney(r.fee))} ({r.feeAccount})</span>}
      {r.description && <span className="block text-[13px] text-ink2">{r.description}</span>}
      {r.voided && <span className="block text-[13px]">{t.voided(r.voidReason ?? '')} {r.voidDocNo}</span>}
    </>
  );
  const action = (r: CashTransferRow) => writable && !r.voided && (
    <Button type="button" variant="secondary" className="min-h-11 px-3 text-sm" onClick={() => setVoiding(r.id)}>{t.void}</Button>
  );
  const panel = (r: CashTransferRow) => voiding === r.id && <VoidPanel companyId={companyId} row={r} onDone={() => setVoiding(null)} />;
  return (
    <section aria-label={t.list} className="flex flex-col gap-3">
      <h2 className="text-[17px] font-semibold">{t.list}</h2>
      {rows.length === 0 ? <p className="text-ink2">{t.empty}</p> : (
        <>
          <table className="w-full border-collapse bg-paper text-[15px] max-sm:hidden">
            <thead className="bg-band text-left text-sm">
              <tr>
                <th className={`${cell} w-32 font-medium`}>{t.col.date}</th>
                <th className={`${cell} w-28 font-medium`}>{t.col.doc}</th>
                <th className={`${cell} font-medium`}>{t.col.move}</th>
                <th className={`${cell} w-36 text-right font-medium`}>{t.col.amount}</th>
                <th className={`${cell} w-28`} aria-hidden />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <TransferRows key={r.id} r={r} cell={cell} move={move(r)} action={action(r)} panel={panel(r)} companyId={companyId} />
              ))}
            </tbody>
          </table>
          <ul className="border-t border-rule-strong bg-paper sm:hidden">
            {rows.map((r) => (
              <li key={r.id} className={`flex flex-col gap-1.5 border-b border-rule px-4 py-3 ${r.voided ? 'text-ink2' : ''}`}>
                <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3">
                  <span className="font-num text-[13px]">{r.docNo} · {isoToThai(r.date)}</span>
                  <Money value={r.amount} />
                </div>
                <div className="text-sm">{move(r)}</div>
                {action(r)}
                {panel(r)}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function TransferRows({ r, cell, move, action, panel, companyId }: {
  r: CashTransferRow; cell: string; move: React.ReactNode; action: React.ReactNode; panel: React.ReactNode; companyId: string;
}) {
  return (
    <>
      <tr className={r.voided ? 'text-ink2' : ''}>
        <td className={`${cell} font-num`}>{isoToThai(r.date)}</td>
        <td className={`${cell} font-num`}><Link className="underline decoration-rule-input" href={`/c/${companyId}/journal/${r.entryId}`}>{r.docNo}</Link></td>
        <td className={cell}>{move}</td>
        <td className={`${cell} text-right`}><Money value={r.amount} /></td>
        <td className={cell}>{action}</td>
      </tr>
      {panel && <tr><td colSpan={5} className="border border-rule p-2">{panel}</td></tr>}
    </>
  );
}

function VoidPanel({ companyId, row, onDone }: { companyId: string; row: CashTransferRow; onDone: () => void }) {
  const [date, setDate] = useState(isoToThai(todayIso() > row.date ? todayIso() : row.date));
  const [reason, setReason] = useState('');
  const a = useAction();
  const iso = thaiToIso(date);
  return (
    <ConfirmPanel title={t.voidTitle(row.docNo)} explain={t.voidExplain} ready={iso !== null && reason.trim() !== ''} busy={a.busy} error={a.error}
      onCancel={onDone}
      onConfirm={async () => {
        const r = await a.run(`/companies/${companyId}/cash-transfers/${row.id}/void`, { date: iso, reason: reason.trim() });
        if (r) onDone();
      }}>
      <div className="grid gap-3 @md:grid-cols-2">
        <DateInput label={t.voidDate} value={date} onChange={setDate} invalid={iso === null} />
        <PlainInput label={t.reason} value={reason} onChange={setReason} maxLength={300} />
      </div>
    </ConfirmPanel>
  );
}
