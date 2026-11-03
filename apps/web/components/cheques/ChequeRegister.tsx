'use client';

import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { Button } from '@/components/Button';
import { Money } from '@/components/Money';
import { AccountSelect, ConfirmPanel, DateInput, PlainInput, useAction } from '@/components/ConfirmPanel';
import type { ChequePage, ChequeRow } from '@/lib/api';
import { isoToThai, thaiToIso, todayIso } from '@/lib/date';
import { formatMoney, fromCents, toCents } from '@/lib/money';
import { th } from '@/i18n/th';

type Dir = 'received' | 'paid';
type Action = 'deposit' | 'clear' | 'bounce' | 'cancel';
const t = th.cheques;
const CHEQUE_NO = /^[0-9A-Za-z-]{1,20}$/;

// คำสั่งที่ทำได้ตามสถานะ (ตรงกับ acc.cheque_action)
function actionsFor(r: ChequeRow): Action[] {
  if (r.direction === 'received') return r.status === 'on_hand' ? ['deposit', 'cancel'] : r.status === 'deposited' ? ['clear', 'bounce'] : [];
  return r.status === 'issued' ? ['clear', 'bounce', 'cancel'] : [];
}

/** ทะเบียนเช็ครับ/เช็คจ่าย: ตาราง (คอม/iPad) หรือรายการ (มือถือ) + เปลี่ยนสถานะ + ลงทะเบียนเช็คใหม่ */
export function ChequeRegister({ companyId, data, dir }: { companyId: string; data: ChequePage; dir: Dir }) {
  const writable = data.company.canWrite && !data.company.locked;
  const rows = data.cheques.filter((r) => r.direction === dir);
  const [adding, setAdding] = useState(false);
  const [acting, setActing] = useState<{ id: string; action: Action } | null>(null);
  const open = rows.filter((r) => ['on_hand', 'deposited', 'issued'].includes(r.status));
  const openTotal = open.reduce((s, r) => s + (toCents(r.amount) ?? 0n), 0n);
  const party = dir === 'received' ? t.col.drawer : t.col.payee;
  const href = (p: string) => `/c/${companyId}${p}`;
  const cell = 'border border-rule px-2.5 py-2 align-top';

  const statusText = (r: ChequeRow) => (
    <>
      <span className="font-medium">{t.status[r.status]}</span>
      {r.status !== 'on_hand' && r.status !== 'issued' && <span className="font-num text-sm"> {isoToThai(r.statusDate)}</span>}
      <span className="block text-[13px] text-ink2">
        {[r.postdated && t.postdated, r.depositCode && t.depositedTo(r.depositCode), r.bankCode && t.drawnOn(r.bankCode)].filter(Boolean).join(' · ')}
      </span>
      <span className="flex flex-wrap gap-x-3 text-[13px]">
        {r.documentNo !== r.entryDocNo && <Link className="underline decoration-rule-input" href={href(`/journal/${r.entryId}`)}>{r.entryDocNo}</Link>}
        {r.statusEntryId && r.statusDocNo && <Link className={`underline decoration-rule-input ${r.statusDocNo.startsWith('RV-') ? 'neg' : ''}`} href={href(`/journal/${r.statusEntryId}`)}>{r.statusDocNo}</Link>}
        {r.documentId && r.documentNo && (
          <Link className="underline decoration-rule-input" href={href(`/${r.direction === 'received' ? 'sales' : 'purchases'}/documents/${r.documentId}`)}>{t.fromDoc(r.documentNo)}</Link>
        )}
      </span>
    </>
  );
  const buttons = (r: ChequeRow) => writable && actionsFor(r).length > 0 && (
    <span className="flex flex-wrap gap-2">
      {actionsFor(r).map((a) => (
        <Button key={a} type="button" variant={a === 'deposit' || a === 'clear' ? 'primary' : 'secondary'} className="min-h-11 px-3 text-sm"
          onClick={() => setActing({ id: r.id, action: a })}>{t.action[a]}</Button>
      ))}
    </span>
  );
  const panel = (r: ChequeRow) => acting?.id === r.id && (
    <ChequeActionPanel companyId={companyId} cheque={r} action={acting.action} bankAccounts={data.bankAccounts} onDone={() => setActing(null)} />
  );

  return (
    <div className="flex flex-col gap-4">
      {!data.company.canWrite && <p className="text-sm text-ink2">{t.readOnly}</p>}
      {data.company.locked && <p role="status" className="border border-rule-strong bg-band px-4 py-2.5">{th.submission.lockedNote}</p>}
      <p className="text-[15px]">{t.outstanding(open.length, formatMoney(fromCents(openTotal)))}</p>

      {rows.length === 0 ? <p className="text-ink2">{t.empty[dir]}</p> : (
        <>
          <table className="w-full border-collapse bg-paper text-[15px] max-sm:hidden" aria-label={dir === 'received' ? t.received : t.paid}>
            <thead className="bg-band text-left text-sm">
              <tr>
                <th className={`${cell} w-32 font-medium`}>{t.col.chequeDate}</th>
                <th className={`${cell} font-medium`}>{t.col.cheque}</th>
                <th className={`${cell} font-medium`}>{party}</th>
                <th className={`${cell} w-36 text-right font-medium`}>{t.col.amount}</th>
                <th className={`${cell} w-64 font-medium`}>{t.col.status}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <ChequeTableRow key={r.id} r={r} cell={cell} status={statusText(r)} buttons={buttons(r)} panel={panel(r)} />
              ))}
            </tbody>
          </table>
          <ul className="border-t border-rule-strong bg-paper sm:hidden" aria-label={dir === 'received' ? t.received : t.paid}>
            {rows.map((r) => (
              <li key={r.id} className={`flex flex-col gap-1.5 border-b border-rule px-4 py-3 ${r.status === 'cancelled' ? 'text-ink2' : ''}`}>
                <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3">
                  <span className="truncate font-medium">{r.partyName || r.bankName}</span>
                  <Money value={r.amount} />
                  <span className="font-num text-[13px] text-ink2">{r.chequeNo} · {r.bankName} · {isoToThai(r.chequeDate)}</span>
                </div>
                <div className="text-sm">{statusText(r)}</div>
                {buttons(r)}
                {panel(r)}
              </li>
            ))}
          </ul>
        </>
      )}

      {writable && (adding ? (
        <NewCheque companyId={companyId} dir={dir} data={data} onDone={() => setAdding(false)} />
      ) : (
        <div className="flex flex-col gap-3">
          <div><Button type="button" onClick={() => setAdding(true)} className="max-sm:w-full">{dir === 'received' ? t.newReceived : t.newPaid}</Button></div>
          <p className="text-sm text-ink2">
            {dir === 'received' ? t.receiptHint : t.paymentHint}{' '}
            <Link className="underline" href={href(dir === 'received' ? '/sales/receipts/new' : '/purchases/payments/new')}>{dir === 'received' ? t.toReceipt : t.toPayment}</Link>
          </p>
        </div>
      ))}
    </div>
  );
}

function ChequeTableRow({ r, cell, status, buttons, panel }: { r: ChequeRow; cell: string; status: ReactNode; buttons: ReactNode; panel: ReactNode }) {
  return (
    <>
      <tr className={r.status === 'cancelled' ? 'text-ink2' : ''}>
        <td className={`${cell} font-num`}>{isoToThai(r.chequeDate)}</td>
        <td className={cell}><span className="font-num">{r.chequeNo}</span> <span className="text-sm">{r.bankName}{r.bankBranch ? ` ${r.bankBranch}` : ''}</span>
          {r.description && <span className="block text-[13px] text-ink2">{r.description}</span>}</td>
        <td className={cell}>{r.partyName}</td>
        <td className={`${cell} text-right`}><Money value={r.amount} /></td>
        <td className={cell}><div className="flex flex-col gap-2"><div>{status}</div>{buttons}</div></td>
      </tr>
      {panel && <tr><td colSpan={5} className="border border-rule p-2">{panel}</td></tr>}
    </>
  );
}

function ChequeActionPanel({ companyId, cheque, action, bankAccounts, onDone }: {
  companyId: string; cheque: ChequeRow; action: Action; bankAccounts: { code: string; name: string }[]; onDone: () => void;
}) {
  const today = todayIso();
  const earliest = cheque.chequeDate > cheque.issueDate ? cheque.chequeDate : cheque.issueDate;
  const [date, setDate] = useState(isoToThai(action === 'deposit' || action === 'clear' ? (today > earliest ? today : earliest) : today > cheque.issueDate ? today : cheque.issueDate));
  const [bank, setBank] = useState(bankAccounts[0]?.code ?? '');
  const [note, setNote] = useState('');
  const a = useAction();
  const iso = thaiToIso(date);
  const explain = action === 'clear' ? t.actionExplain[`clear_${cheque.direction}`]! : t.actionExplain[action]!;
  return (
    <ConfirmPanel title={t.actionTitle(t.action[action]!, cheque.chequeNo)} explain={explain} busy={a.busy} error={a.error}
      ready={iso !== null && (action !== 'deposit' || bank !== '')} onCancel={onDone}
      onConfirm={async () => {
        const r = await a.run(`/companies/${companyId}/cheques/${cheque.id}/actions`, { action, date: iso, ...(action === 'deposit' ? { bankAccount: bank } : {}), ...(note.trim() ? { note: note.trim() } : {}) });
        if (r) onDone();
      }}>
      <div className="grid gap-3 @md:grid-cols-2">
        <DateInput label={t.actionDate} value={date} onChange={setDate} invalid={iso === null} />
        {action === 'deposit'
          ? <AccountSelect label={t.depositAccount} value={bank} onChange={setBank} accounts={bankAccounts} />
          : <PlainInput label={t.note} value={note} onChange={setNote} maxLength={300} />}
      </div>
    </ConfirmPanel>
  );
}

function NewCheque({ companyId, dir, data, onDone }: { companyId: string; dir: Dir; data: ChequePage; onDone: () => void }) {
  const [no, setNo] = useState('');
  const [bankName, setBankName] = useState('');
  const [branch, setBranch] = useState('');
  const [chequeDate, setChequeDate] = useState(isoToThai(todayIso()));
  const [date, setDate] = useState(isoToThai(todayIso()));
  const [amount, setAmount] = useState('');
  const [party, setParty] = useState('');
  const [counter, setCounter] = useState(dir === 'received' ? '1210' : '2110');
  const [bank, setBank] = useState(data.bankAccounts[0]?.code ?? '');
  const [description, setDescription] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const a = useAction();
  const cIso = thaiToIso(chequeDate);
  const dIso = thaiToIso(date);
  const cents = toCents(amount);
  const postdated = cIso !== null && dIso !== null && cIso > dIso;
  const hold = dir === 'received' ? (postdated ? '1221' : '1220') : (postdated ? '2121' : '2120');
  const errors = {
    no: no !== '' && !CHEQUE_NO.test(no) ? t.invalid.chequeNo : null,
    amount: amount !== '' && (cents === null || cents <= 0n) ? t.invalid.amount : null,
  };
  const ready = CHEQUE_NO.test(no) && bankName.trim() !== '' && cIso !== null && dIso !== null && cents !== null && cents > 0n
    && counter !== '' && (dir === 'received' || bank !== '');

  return (
    <ConfirmPanel title={dir === 'received' ? t.newReceivedTitle : t.newPaidTitle} explain={t.postdatedHint} ready={ready} busy={a.busy} error={a.error}
      confirm={t.save} onCancel={onDone}
      onConfirm={async () => {
        const r = await a.run<ChequeRow>(`/companies/${companyId}/cheques`, {
          direction: dir, chequeNo: no.trim(), bankName: bankName.trim(), ...(branch.trim() ? { bankBranch: branch.trim() } : {}),
          chequeDate: cIso, date: dIso, amount: fromCents(cents!), ...(party.trim() ? { partyName: party.trim() } : {}),
          ...(description.trim() ? { description: description.trim() } : {}), counterAccount: counter, ...(dir === 'paid' ? { bankAccount: bank } : {}),
        });
        if (r) { setDone(t.registered(r.chequeNo, r.entryDocNo)); setNo(''); setAmount(''); }
      }}>
      <div className="grid gap-3 @md:grid-cols-2 @3xl:grid-cols-3">
        <PlainInput label={t.chequeNo} value={no} onChange={(v) => setNo(v.trim())} mono maxLength={20} invalid={Boolean(errors.no)} />
        <PlainInput label={t.bankName} value={bankName} onChange={setBankName} maxLength={100} />
        <PlainInput label={t.bankBranch} value={branch} onChange={setBranch} maxLength={100} />
        <DateInput label={t.chequeDate} value={chequeDate} onChange={setChequeDate} invalid={cIso === null} />
        <DateInput label={dir === 'received' ? t.receivedDate : t.paidDate} value={date} onChange={setDate} invalid={dIso === null} />
        <PlainInput label={t.amount} value={amount} onChange={setAmount} inputMode="decimal" invalid={Boolean(errors.amount)} />
        <PlainInput label={dir === 'received' ? t.drawer : t.payee} value={party} onChange={setParty} maxLength={160} />
        <AccountSelect label={dir === 'received' ? t.counterReceived : t.counterPaid} value={counter} onChange={setCounter} accounts={data.accounts} />
        {dir === 'paid' && <AccountSelect label={t.bankAccount} value={bank} onChange={setBank} accounts={data.bankAccounts} />}
        <PlainInput label={t.description} value={description} onChange={setDescription} maxLength={300} />
      </div>
      {(errors.no || errors.amount) && <p className="neg text-sm">{errors.no ?? errors.amount}</p>}
      <p className="font-num text-sm">{dir === 'received' ? t.entryHint(hold, counter) : t.entryHint(counter, hold)}{postdated ? ` · ${t.postdated}` : ''}</p>
      {done && <p role="status" className="text-[15px]">{done}</p>}
    </ConfirmPanel>
  );
}
