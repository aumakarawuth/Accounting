'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/Button';
import { Money } from '@/components/Money';
import { SelectField, TextField } from '@/components/Fields';
import { AccountSelect, ConfirmPanel, DateInput, PlainInput, useAction } from '@/components/ConfirmPanel';
import { postJson, type ApiError, type PettyCashPage, type PettyVoucher } from '@/lib/api';
import { isoToThai, maskDate, thaiToIso, todayIso } from '@/lib/date';
import { formatMoney, fromCents, toCents } from '@/lib/money';
import { th } from '@/i18n/th';

const t = th.pettyCash;
const errText = (e: unknown) => {
  const err = e as ApiError;
  return err.code === 'server' ? th.error.server(err.ref ?? '-') : err.message;
};

/** เงินสดย่อยระบบวงเงินคงที่: สรุปวงเงิน · จ่ายด้วยใบสำคัญ · เบิกชดเชย · ตั้ง/ปรับวงเงิน */
export function PettyCash({ companyId, data }: { companyId: string; data: PettyCashPage }) {
  const writable = data.company.canWrite && !data.company.locked;
  const [fundOpen, setFundOpen] = useState(false);
  const hasFund = data.funds.length > 0;
  return (
    <div className="flex flex-col gap-6">
      {!data.company.canWrite && <p className="text-sm text-ink2">{th.cheques.readOnly}</p>}
      {data.company.locked && <p role="status" className="border border-rule-strong bg-band px-4 py-2.5">{th.submission.lockedNote}</p>}

      <section aria-label={t.fund} className="flex flex-col gap-3">
        <dl className="grid grid-cols-2 gap-px border border-rule bg-rule sm:grid-cols-4">
          {[[t.fund, data.fund], [t.pending, data.pending], [t.onHand, data.onHand]].map(([label, v]) => (
            <div key={label} className="flex flex-col gap-1 bg-paper px-4 py-3">
              <dt className="text-sm text-ink2">{label}</dt>
              <dd className="text-[17px]"><Money value={v!} /></dd>
            </div>
          ))}
          <div className="flex flex-col gap-1 bg-paper px-4 py-3">
            <dt className="text-sm text-ink2">{t.custodian}</dt>
            <dd className="text-[15px]">{data.custodian ?? '-'}</dd>
          </div>
        </dl>
        {!hasFund && <p className="text-ink2">{t.noFund}</p>}
        {writable && (fundOpen
          ? <FundPanel companyId={companyId} data={data} onDone={() => setFundOpen(false)} />
          : <div><Button type="button" variant={hasFund ? 'secondary' : 'primary'} className="max-sm:w-full" onClick={() => setFundOpen(true)}>
              {hasFund ? t.adjustFund : t.setFund}</Button></div>)}
      </section>

      {writable && hasFund && <VoucherForm companyId={companyId} data={data} />}
      {writable && <ReimburseForm companyId={companyId} data={data} />}
      <VoucherList companyId={companyId} vouchers={data.vouchers} writable={writable} />
      <Reimbursements companyId={companyId} data={data} writable={writable} />
      {data.funds.length > 0 && (
        <section aria-label={t.history} className="flex flex-col gap-2">
          <h2 className="text-[17px] font-semibold">{t.history}</h2>
          <ul className="border-t border-rule bg-paper text-[15px]">
            {data.funds.map((f) => (
              <li key={f.id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 border-b border-rule px-4 py-2">
                <span><span className="font-num text-sm">{f.docNo} · {isoToThai(f.date)}</span> {t.fund} {formatMoney(f.fund)} · {f.custodian}</span>
                <Money value={f.change} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function FundPanel({ companyId, data, onDone }: { companyId: string; data: PettyCashPage; onDone: () => void }) {
  const [fund, setFund] = useState(data.funds.length === 0 ? '' : data.fund);
  const [custodian, setCustodian] = useState(data.custodian ?? '');
  const [cash, setCash] = useState(data.cashAccounts[0]?.code ?? '');
  const [date, setDate] = useState(isoToThai(todayIso()));
  const [done, setDone] = useState<string | null>(null);
  const a = useAction();
  const iso = thaiToIso(date);
  const cents = toCents(fund.trim());
  return (
    <ConfirmPanel title={t.fundTitle} explain={t.fundExplain} ready={iso !== null && cents !== null && cents >= 0n && custodian.trim() !== '' && cash !== ''}
      busy={a.busy} error={a.error} onCancel={onDone}
      onConfirm={async () => {
        const r = await a.run<{ docNo: string }>(`/companies/${companyId}/petty-cash/fund`, {
          date: iso, fund: fromCents(cents!), cashAccount: cash, custodian: custodian.trim(),
        });
        if (r) setDone(t.fundSaved(r.docNo));
      }}>
      <div className="grid gap-3 @md:grid-cols-2">
        <PlainInput label={t.newFund} value={fund} onChange={setFund} inputMode="decimal" />
        <PlainInput label={t.custodian} value={custodian} onChange={setCustodian} maxLength={160} />
        <AccountSelect label={t.cashAccount} value={cash} onChange={setCash} accounts={data.cashAccounts} />
        <DateInput label={t.date} value={date} onChange={setDate} invalid={iso === null} />
      </div>
      {done && <p role="status" className="text-[15px]">{done}</p>}
    </ConfirmPanel>
  );
}

function VoucherForm({ companyId, data }: { companyId: string; data: PettyCashPage }) {
  const router = useRouter();
  const [date, setDate] = useState(isoToThai(todayIso()));
  const [payee, setPayee] = useState('');
  const [description, setDescription] = useState('');
  const [account, setAccount] = useState(data.expenseAccounts.find((x) => x.code === '5260')?.code ?? data.expenseAccounts[0]?.code ?? '');
  const [amount, setAmount] = useState('');
  const [receiptNo, setReceiptNo] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const key = useRef(crypto.randomUUID());
  const iso = thaiToIso(date);
  const cents = toCents(amount.trim());
  const valid = Boolean(iso && payee.trim() && description.trim() && account && cents !== null && cents > 0n);

  async function submit() {
    if (busy) return;
    if (!valid) { setMsg({ ok: false, text: t.voucherInvalid }); return; }
    setBusy(true);
    setMsg(null);
    try {
      const r = await postJson<PettyVoucher>(`/companies/${companyId}/petty-cash/vouchers`, {
        date: iso, payee: payee.trim(), description: description.trim(), account, amount: fromCents(cents!),
        ...(receiptNo.trim() ? { receiptNo: receiptNo.trim() } : {}),
      }, { 'idempotency-key': key.current });
      key.current = crypto.randomUUID();
      setPayee('');
      setDescription('');
      setAmount('');
      setReceiptNo('');
      setMsg({ ok: true, text: t.voucherSaved(r.docNo) });
      router.refresh();
    } catch (e) {
      setMsg({ ok: false, text: errText(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="flex flex-col gap-4 border border-rule-strong bg-paper p-4 sm:p-6" aria-label={t.voucherForm}
      onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <h2 className="text-[17px] font-semibold">{t.voucherForm}</h2>
      <p className="text-sm text-ink2">{t.voucherNote}</p>
      <div className="grid gap-4 sm:grid-cols-2 sm:gap-6 lg:grid-cols-3">
        <TextField label={t.date} value={date} onChange={(v) => setDate(maskDate(v))} inputMode="numeric" mono />
        <TextField label={t.payee} value={payee} onChange={setPayee} maxLength={160} />
        <TextField label={t.description} value={description} onChange={setDescription} maxLength={200} />
        <SelectField label={t.account} value={account} onChange={setAccount}>
          {data.expenseAccounts.map((x) => <option key={x.code} value={x.code}>{x.code} {x.name}</option>)}
        </SelectField>
        <TextField label={t.amount} value={amount} onChange={setAmount} inputMode="decimal" mono />
        <TextField label={t.receiptNo} value={receiptNo} onChange={setReceiptNo} maxLength={40} mono />
      </div>
      {msg && <p role={msg.ok ? 'status' : 'alert'} className={msg.ok ? 'text-[15px]' : 'neg text-[15px]'}>{msg.text}</p>}
      <div><Button type="submit" disabled={busy} className="max-sm:w-full">{t.saveVoucher}</Button></div>
    </form>
  );
}

function ReimburseForm({ companyId, data }: { companyId: string; data: PettyCashPage }) {
  const router = useRouter();
  const pending = data.vouchers.filter((v) => v.status === 'pending');
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [cash, setCash] = useState(data.cashAccounts[0]?.code ?? '');
  const [date, setDate] = useState(isoToThai(todayIso()));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const key = useRef(crypto.randomUUID());
  const iso = thaiToIso(date);
  const chosen = pending.filter((v) => picked.has(v.id));
  const total = chosen.reduce((s, v) => s + (toCents(v.amount) ?? 0n), 0n);

  async function submit() {
    if (busy || !iso || chosen.length === 0 || !cash) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await postJson<{ docNo: string }>(`/companies/${companyId}/petty-cash/reimbursements`, {
        date: iso, cashAccount: cash, voucherIds: chosen.map((v) => v.id),
      }, { 'idempotency-key': key.current });
      key.current = crypto.randomUUID();
      setPicked(new Set());
      setMsg({ ok: true, text: t.reimburseSaved(r.docNo) });
      router.refresh();
    } catch (e) {
      setMsg({ ok: false, text: errText(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="flex flex-col gap-4 border border-rule-strong bg-paper p-4 sm:p-6" aria-label={t.reimburse}
      onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <h2 className="text-[17px] font-semibold">{t.reimburse}</h2>
      <p className="text-sm text-ink2">{t.reimburseNote}</p>
      {pending.length === 0 ? <p className="text-ink2">{t.nothingPending}</p> : (
        <>
          <ul className="flex flex-col border-t border-rule">
            {pending.map((v) => (
              <li key={v.id} className="border-b border-rule">
                <label className="grid min-h-11 cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-1 py-2 text-base">
                  <input type="checkbox" className="size-5" checked={picked.has(v.id)}
                    onChange={(e) => setPicked((s) => { const n = new Set(s); if (e.target.checked) n.add(v.id); else n.delete(v.id); return n; })} />
                  <span className="min-w-0"><span className="font-num text-sm">{v.docNo}</span> {v.description}
                    <span className="block text-[13px] text-ink2">{v.payee} · {v.account} {v.accountName}</span></span>
                  <Money value={v.amount} />
                </label>
              </li>
            ))}
          </ul>
          <p className="text-[15px]">{t.selected(chosen.length, formatMoney(fromCents(total)))}</p>
          <div className="grid gap-4 sm:grid-cols-2 sm:gap-6">
            <SelectField label={t.reimburseFrom} value={cash} onChange={setCash}>
              {data.cashAccounts.map((x) => <option key={x.code} value={x.code}>{x.code} {x.name}</option>)}
            </SelectField>
            <TextField label={t.date} value={date} onChange={(v) => setDate(maskDate(v))} inputMode="numeric" mono />
          </div>
        </>
      )}
      {msg && <p role={msg.ok ? 'status' : 'alert'} className={msg.ok ? 'text-[15px]' : 'neg text-[15px]'}>{msg.text}</p>}
      {pending.length > 0 && (
        <div><Button type="submit" disabled={busy || chosen.length === 0 || !iso} className="max-sm:w-full">{t.saveReimburse}</Button></div>
      )}
    </form>
  );
}

function VoucherList({ companyId, vouchers, writable }: { companyId: string; vouchers: PettyVoucher[]; writable: boolean }) {
  const [cancelling, setCancelling] = useState<string | null>(null);
  return (
    <section aria-label={t.vouchers} className="flex flex-col gap-2">
      <h2 className="text-[17px] font-semibold">{t.vouchers}</h2>
      {vouchers.length === 0 ? <p className="text-ink2">{t.noVouchers}</p> : (
        <ul className="border-t border-rule-strong bg-paper">
          {vouchers.map((v) => (
            <li key={v.id} className={`flex flex-col gap-1.5 border-b border-rule px-4 py-3 ${v.status === 'cancelled' ? 'text-ink2' : ''}`}>
              <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3">
                <span className="min-w-0"><span className="font-num text-sm">{v.docNo} · {isoToThai(v.date)}</span> {v.description}</span>
                <Money value={v.amount} />
                <span className="text-[13px] text-ink2">{v.payee} · {v.account} {v.accountName}{v.receiptNo ? ` · ${v.receiptNo}` : ''}</span>
                <span className="text-right text-[13px] font-medium">{t.status[v.status]}</span>
              </div>
              {v.cancelReason && <span className="text-[13px]">{v.cancelReason}</span>}
              {writable && v.status === 'pending' && cancelling !== v.id && (
                <div><Button type="button" variant="secondary" className="min-h-11 px-3 text-sm" onClick={() => setCancelling(v.id)}>{t.cancel}</Button></div>
              )}
              {cancelling === v.id && <CancelPanel companyId={companyId} voucher={v} onDone={() => setCancelling(null)} />}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function CancelPanel({ companyId, voucher, onDone }: { companyId: string; voucher: PettyVoucher; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const a = useAction();
  return (
    <ConfirmPanel title={t.cancelTitle(voucher.docNo)} explain={t.cancelExplain} ready={reason.trim() !== ''} busy={a.busy} error={a.error} onCancel={onDone}
      onConfirm={async () => {
        const r = await a.run(`/companies/${companyId}/petty-cash/vouchers/${voucher.id}/cancel`, { reason: reason.trim() });
        if (r) onDone();
      }}>
      <PlainInput label={t.reason} value={reason} onChange={setReason} maxLength={300} />
    </ConfirmPanel>
  );
}

function Reimbursements({ companyId, data, writable }: { companyId: string; data: PettyCashPage; writable: boolean }) {
  const [voiding, setVoiding] = useState<string | null>(null);
  if (data.reimbursements.length === 0) return null;
  return (
    <section aria-label={t.reimbursements} className="flex flex-col gap-2">
      <h2 className="text-[17px] font-semibold">{t.reimbursements}</h2>
      <ul className="border-t border-rule-strong bg-paper">
        {data.reimbursements.map((r) => (
          <li key={r.id} className={`flex flex-col gap-1.5 border-b border-rule px-4 py-3 ${r.voided ? 'text-ink2' : ''}`}>
            <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3">
              <span className="min-w-0"><span className="font-num text-sm">{r.docNo} · {isoToThai(r.date)}</span> {r.cashAccount}</span>
              <Money value={r.total} />
              <span className="font-num text-[13px] text-ink2">{r.vouchers.join(', ')}</span>
            </div>
            {r.voided && <span className="text-[13px]">{t.voided(r.voidReason ?? '')}</span>}
            {writable && !r.voided && voiding !== r.id && (
              <div><Button type="button" variant="secondary" className="min-h-11 px-3 text-sm" onClick={() => setVoiding(r.id)}>{t.voidReimburse}</Button></div>
            )}
            {voiding === r.id && <VoidReimbursement companyId={companyId} id={r.id} docNo={r.docNo} minDate={r.date} onDone={() => setVoiding(null)} />}
          </li>
        ))}
      </ul>
    </section>
  );
}

function VoidReimbursement({ companyId, id, docNo, minDate, onDone }: { companyId: string; id: string; docNo: string; minDate: string; onDone: () => void }) {
  const [date, setDate] = useState(isoToThai(todayIso() > minDate ? todayIso() : minDate));
  const [reason, setReason] = useState('');
  const a = useAction();
  const iso = thaiToIso(date);
  return (
    <ConfirmPanel title={t.voidTitle(docNo)} explain={t.voidExplain} ready={iso !== null && reason.trim() !== ''} busy={a.busy} error={a.error} onCancel={onDone}
      onConfirm={async () => {
        const r = await a.run(`/companies/${companyId}/petty-cash/reimbursements/${id}/void`, { date: iso, reason: reason.trim() });
        if (r) onDone();
      }}>
      <div className="grid gap-3 @md:grid-cols-2">
        <DateInput label={t.voidDate} value={date} onChange={setDate} invalid={iso === null} />
        <PlainInput label={t.reason} value={reason} onChange={setReason} maxLength={300} />
      </div>
    </ConfirmPanel>
  );
}
