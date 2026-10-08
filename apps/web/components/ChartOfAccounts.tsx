'use client';

import { useState } from 'react';
import { Button } from '@/components/Button';
import { api, postJson, type AccountType, type ApiError, type ChartRow } from '@/lib/api';
import { th } from '@/i18n/th';

const TYPES: AccountType[] = ['asset', 'liability', 'equity', 'revenue', 'expense'];
const BY_DIGIT: Record<string, AccountType> = { 1: 'asset', 2: 'liability', 3: 'equity', 4: 'revenue', 5: 'expense' };
const CODE = /^[0-9]{3,10}$/;

const patch = (path: string, data: unknown) =>
  api<ChartRow>(path, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });

// ผังบัญชี: เพิ่ม/แก้ชื่อ/ปิดใช้ (บัญชีที่มีรายการแล้วปิดใช้ไม่ได้ ตรวจซ้ำที่ DB)
export function ChartOfAccounts({ companyId, initial, editable }: { companyId: string; initial: ChartRow[]; editable: boolean }) {
  const [rows, setRows] = useState(initial);
  const [showInactive, setShowInactive] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const replace = (row: ChartRow) => setRows((rs) => rs.map((r) => (r.code === row.code ? row : r)));
  const report = (e: unknown) => {
    const err = e as ApiError;
    setMessage({ ok: false, text: err.code === 'server' ? th.error.server(err.ref ?? '-') : err.message });
  };
  const inactive = rows.filter((r) => !r.active).length;
  const visible = rows.filter((r) => showInactive || r.active);

  return (
    <div className="flex flex-col gap-4">
      {editable && (
        <AddAccount
          companyId={companyId}
          onAdded={(row) => {
            setRows((rs) => [...rs, row].sort((a, b) => a.code.localeCompare(b.code)));
            setMessage({ ok: true, text: th.accounts.added(row.code, row.name) });
          }}
          onError={report}
        />
      )}
      {message && <p role={message.ok ? 'status' : 'alert'} className={message.ok ? 'text-[15px]' : 'neg text-[15px]'}>{message.text}</p>}
      {inactive > 0 && (
        <button type="button" className="flex min-h-11 items-center self-start text-sm underline" onClick={() => setShowInactive((v) => !v)}>
          {showInactive ? th.accounts.hideInactive : `${th.accounts.showInactive} (${inactive})`}
        </button>
      )}
      {TYPES.map((t) => {
        const list = visible.filter((r) => r.type === t);
        if (list.length === 0) return null;
        return (
          <section key={t} aria-label={th.accounts.types[t]} className="border border-rule-strong bg-paper">
            <h2 className="flex items-baseline justify-between bg-band px-3 py-2 text-[15px] font-semibold">
              <span>{th.accounts.types[t]}</span>
              <span className="text-[13px] font-normal text-ink2">{th.accounts.normal[t === 'asset' || t === 'expense' ? 'debit' : 'credit']} · {th.accounts.count(list.length)}</span>
            </h2>
            <ul>
              {list.map((r) => (
                <AccountRow
                  key={r.code}
                  row={r}
                  editable={editable}
                  onSave={async (data) => {
                    setMessage(null);
                    try { replace(await patch(`/companies/${companyId}/accounts/${r.code}`, { ...data, version: r.version })); return true; }
                    catch (e) { report(e); return false; }
                  }}
                />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function AccountRow({ row, editable, onSave }: {
  row: ChartRow; editable: boolean; onSave: (data: { name?: string; active?: boolean }) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(row.name);
  const [busy, setBusy] = useState(false);
  const run = async (data: { name?: string; active?: boolean }) => {
    setBusy(true);
    const ok = await onSave(data);
    setBusy(false);
    if (ok) setEditing(false);
  };
  const link = 'min-h-11 px-1 text-sm underline disabled:text-ink2 disabled:no-underline';

  return (
    <li className={`grid grid-cols-[72px_minmax(0,1fr)] items-center gap-x-3 border-t border-rule px-3 py-1.5 sm:grid-cols-[88px_minmax(0,1fr)_auto] ${row.active ? '' : 'text-ink2'}`}>
      <span className="font-num">{row.code}</span>
      {editing ? (
        <form className="col-span-2 flex flex-wrap items-center gap-2 max-sm:row-start-2 sm:col-span-2" onSubmit={(e) => { e.preventDefault(); void run({ name }); }}>
          <label className="flex min-w-0 flex-1 flex-col text-sm">
            <span className="sr-only">{th.accounts.name} {row.code}</span>
            <input className="h-11 min-w-48 border-b border-rule-input bg-transparent px-0.5 text-base" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
          </label>
          <Button type="submit" disabled={busy || !name.trim()}>{th.accounts.save}</Button>
          <Button type="button" variant="secondary" disabled={busy} onClick={() => { setEditing(false); setName(row.name); }}>{th.accounts.cancel}</Button>
        </form>
      ) : (
        <>
          <span className="min-w-0">
            {row.name}
            {(row.used || !row.active) && (
              <span className="ml-2 text-[13px] text-ink2">{[row.used && th.accounts.used, !row.active && th.accounts.inactive].filter(Boolean).join(' · ')}</span>
            )}
          </span>
          {editable && (
            <span className="col-span-2 flex justify-end gap-3 sm:col-span-1">
              <button type="button" className={link} disabled={busy} onClick={() => setEditing(true)}>{th.accounts.edit}</button>
              {!row.used && (
                <button type="button" className={link} disabled={busy} onClick={() => void run({ active: !row.active })}>
                  {row.active ? th.accounts.deactivate : th.accounts.activate}
                </button>
              )}
            </span>
          )}
        </>
      )}
    </li>
  );
}

function AddAccount({ companyId, onAdded, onError }: { companyId: string; onAdded: (r: ChartRow) => void; onError: (e: unknown) => void }) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [type, setType] = useState<AccountType | ''>('');
  const [busy, setBusy] = useState(false);
  const codeOk = CODE.test(code);
  const suggested = BY_DIGIT[code[0] ?? ''];
  const chosen = type || suggested || '';
  const mismatch = codeOk && suggested && chosen && suggested !== chosen;

  if (!open) {
    return <div><Button type="button" variant="secondary" onClick={() => setOpen(true)} className="max-sm:w-full">{th.accounts.add}</Button></div>;
  }

  async function submit() {
    if (!codeOk || !name.trim() || !chosen) return;
    setBusy(true);
    try {
      const row = await postJson<ChartRow>(`/companies/${companyId}/accounts`, { code, name, type: chosen });
      onAdded(row);
      setCode(''); setName(''); setType('');
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="flex flex-col gap-3 border border-rule-strong bg-paper p-4" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <h2 className="text-[17px] font-semibold">{th.accounts.addTitle}</h2>
      <div className="grid gap-3 sm:grid-cols-[140px_minmax(0,1fr)_180px] sm:gap-5">
        <label className="flex flex-col text-sm">
          {th.accounts.code}
          <input className="h-11 border-b border-rule-input bg-transparent px-0.5 font-num text-base" inputMode="numeric" value={code}
            onChange={(e) => setCode(e.target.value.trim())} aria-invalid={code !== '' && !codeOk} aria-describedby="coa-code-hint" />
        </label>
        <label className="flex flex-col text-sm">
          {th.accounts.name}
          <input className="h-11 border-b border-rule-input bg-transparent px-0.5 text-base" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="flex flex-col text-sm">
          {th.accounts.type}
          <select className="h-11 border-b border-rule-input bg-transparent text-base" value={chosen} onChange={(e) => setType(e.target.value as AccountType)}>
            <option value="" disabled>—</option>
            {TYPES.map((t) => <option key={t} value={t}>{th.accounts.types[t]}</option>)}
          </select>
        </label>
      </div>
      <p id="coa-code-hint" className={`text-[13px] ${code !== '' && !codeOk ? 'neg' : 'text-ink2'}`}>
        {code !== '' && !codeOk ? th.accounts.codeInvalid : th.accounts.codeHint}
      </p>
      {mismatch && <p className="text-[13px]">{th.accounts.typeMismatch(code[0]!, th.accounts.types[suggested]!)}</p>}
      <div className="flex flex-wrap gap-3">
        <Button type="submit" disabled={busy || !codeOk || !name.trim() || !chosen} className="max-sm:w-full">{th.accounts.add}</Button>
        <Button type="button" variant="secondary" disabled={busy} onClick={() => setOpen(false)} className="max-sm:w-full">{th.accounts.cancel}</Button>
      </div>
    </form>
  );
}
