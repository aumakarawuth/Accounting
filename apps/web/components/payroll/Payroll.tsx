'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/Button';
import { Money } from '@/components/Money';
import { CheckField, TextField } from '@/components/Fields';
import { AccountSelect, ConfirmPanel, DateInput, PlainInput, errText, useAction } from '@/components/ConfirmPanel';
import { api, type PayrollPage } from '@/lib/api';
import { isoToThai, monthLabel, thaiToIso, todayIso } from '@/lib/date';
import { formatMoney, fromCents, toCents } from '@/lib/money';
import { ssoCents } from '@/lib/payroll';
import { th } from '@/i18n/th';

const t = th.payroll;
type Employee = PayrollPage['employees'][number];
const cell = 'border border-rule px-2 py-1.5';
const lastDay = (month: string) => { const [y, m] = month.split('-').map(Number) as [number, number]; return `${month}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`; };

export function Payroll({ companyId, data }: { companyId: string; data: PayrollPage }) {
  const writable = data.canWrite && !data.locked;
  const run = data.runs.find((r) => !r.voided);
  return (
    <div className="flex flex-col gap-6">
      {!data.canWrite && <p className="text-sm text-ink2">{th.cheques.readOnly}</p>}
      {data.locked && <p role="status" className="border border-rule-strong bg-band px-4 py-2.5">{th.submission.lockedNote}</p>}
      <Employees companyId={companyId} employees={data.employees} writable={writable} />
      {run ? <PostedRun companyId={companyId} data={data} writable={writable} /> : writable && <RunForm companyId={companyId} data={data} />}
      {run && <Remittances companyId={companyId} data={data} writable={writable} />}
      <YearSummary data={data} />
    </div>
  );
}

function Employees({ companyId, employees, writable }: { companyId: string; employees: Employee[]; writable: boolean }) {
  const [editing, setEditing] = useState<Employee | 'new' | null>(null);
  return (
    <section aria-label={t.employees} className="flex flex-col gap-2">
      <h2 className="text-[17px] font-semibold">{t.employees}</h2>
      {employees.length === 0 ? <p className="text-ink2">{t.noEmployees}</p> : (
        <ul className="border-t border-rule-strong bg-paper">
          {employees.map((e) => (
            <li key={e.id} className={`flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-rule px-4 py-2.5 ${e.active ? '' : 'text-ink2'}`}>
              <span className="font-num">{e.code}</span>
              <span className="min-w-0 flex-1">{e.name}{e.position ? ` · ${e.position}` : ''}{e.active ? '' : ` (${t.resigned})`}</span>
              <span className="text-sm">{t.ssoShort}: {e.sso ? t.yes : t.no}</span>
              <Money value={e.salary} />
              {writable && <Button type="button" variant="secondary" className="min-h-11 px-3 text-sm" onClick={() => setEditing(e)}>{t.edit}</Button>}
              {editing !== null && editing !== 'new' && editing.id === e.id && <EmployeeForm companyId={companyId} initial={e} onDone={() => setEditing(null)} />}
            </li>
          ))}
        </ul>
      )}
      {writable && (editing === 'new' ? <EmployeeForm companyId={companyId} onDone={() => setEditing(null)} />
        : <div><Button type="button" variant="secondary" onClick={() => setEditing('new')} className="max-sm:w-full">{t.addEmployee}</Button></div>)}
    </section>
  );
}

function EmployeeForm({ companyId, initial, onDone }: { companyId: string; initial?: Employee; onDone: () => void }) {
  const router = useRouter();
  const [code, setCode] = useState(initial?.code ?? '');
  const [name, setName] = useState(initial?.name ?? '');
  const [position, setPosition] = useState(initial?.position ?? '');
  const [salary, setSalary] = useState(initial?.salary ?? '');
  const [sso, setSso] = useState(initial?.sso ?? true);
  const [active, setActive] = useState(initial?.active ?? true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const valid = /^[A-Za-z0-9-]{1,20}$/.test(code.trim()) && name.trim() !== '' && toCents(salary.trim()) !== null;
  return (
    <form aria-label={initial ? t.editEmployee(initial.code) : t.addEmployee} className="flex w-full flex-col gap-3 border border-ink bg-paper p-4"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!valid) return;
        setBusy(true); setErr(null);
        try {
          const body = JSON.stringify({ code: code.trim(), name: name.trim(), position: position.trim(), salary: fromCents(toCents(salary.trim())!), sso, active, ...(initial ? { version: initial.version } : {}) });
          await api(`/companies/${companyId}/employees${initial ? `/${initial.id}` : ''}`, { method: initial ? 'PUT' : 'POST', headers: { 'content-type': 'application/json' }, body });
          router.refresh();
          onDone();
        } catch (x) { setErr(errText(x)); } finally { setBusy(false); }
      }}>
      <h3 className="font-doc text-[17px] font-bold">{initial ? t.editEmployee(initial.code) : t.addEmployee}</h3>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <TextField label={t.code} value={code} onChange={(v) => setCode(v.toUpperCase())} maxLength={20} mono />
        <TextField label={t.name} value={name} onChange={setName} maxLength={120} />
        <TextField label={t.position} value={position} onChange={setPosition} maxLength={120} />
        <TextField label={t.salary} value={salary} onChange={setSalary} inputMode="decimal" mono />
      </div>
      <div className="flex flex-wrap gap-x-6">
        <CheckField label={t.sso} checked={sso} onChange={setSso} />
        {initial && <CheckField label={t.active} checked={active} onChange={setActive} />}
      </div>
      {err && <p role="alert" className="neg text-sm">{err}</p>}
      <div className="flex gap-3 max-sm:grid max-sm:grid-cols-2">
        <Button type="submit" disabled={busy || !valid}>{t.save}</Button>
        <Button type="button" variant="secondary" onClick={onDone}>{t.cancel}</Button>
      </div>
    </form>
  );
}

type Draft = { code: string; salary: string; other: string; wht: string };
function RunForm({ companyId, data }: { companyId: string; data: PayrollPage }) {
  const active = data.employees.filter((e) => e.active);
  // ร่างรายคนตามรหัส: พนักงานที่เพิ่มหลังเปิดหน้าได้แถวตั้งต้นจากเงินเดือนในทะเบียน
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const rows: Draft[] = active.map((e) => drafts[e.code] ?? { code: e.code, salary: e.salary, other: '0', wht: '0' });
  const [date, setDate] = useState(isoToThai(lastDay(data.month)));
  const [cash, setCash] = useState(data.cashAccounts[0]?.code ?? '');
  const [done, setDone] = useState<string | null>(null);
  const a = useAction();
  const iso = thaiToIso(date);
  const calc = rows.map((r) => {
    const e = active.find((x) => x.code === r.code)!;
    const sal = toCents(r.salary.trim()), oth = toCents(r.other.trim() || '0'), wht = toCents(r.wht.trim() || '0');
    if (sal === null || oth === null || wht === null) return null;
    const wage = sal + oth, ss = e.sso ? ssoCents(wage, data.ceiling) : 0n;
    return { wage, ss, wht, net: wage - ss - wht };
  });
  const ok = calc.every((c) => c !== null && c.net >= 0) && rows.length > 0 && iso !== null && cash !== '';
  const sum = (k: 'wage' | 'ss' | 'wht' | 'net') => calc.reduce((s, c) => s + (c?.[k] ?? 0n), 0n);
  const set = (i: number, p: Partial<Draft>) => setDrafts((d) => ({ ...d, [rows[i]!.code]: { ...rows[i]!, ...p } }));
  const m = (c: bigint) => formatMoney(fromCents(c));
  if (active.length === 0) return <p className="text-ink2">{t.noActive}</p>;
  return (
    <form aria-label={t.run(monthLabel(data.month))} className="flex flex-col gap-4 border border-rule-strong bg-paper p-4 sm:p-6"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!ok) return;
        const r = await a.run<{ docNo: string }>(`/companies/${companyId}/payroll`, {
          month: data.month, payDate: iso, cashAccount: cash,
          lines: rows.map((x) => ({ employee: x.code, salary: fromCents(toCents(x.salary.trim())!), otherIncome: fromCents(toCents(x.other.trim() || '0')!), wht: fromCents(toCents(x.wht.trim() || '0')!) })),
        });
        if (r) setDone(t.posted(r.docNo));
      }}>
      <h2 className="font-doc text-[18px] font-bold">{t.run(monthLabel(data.month))}</h2>
      <ol className="flex flex-col gap-3">
        {rows.map((r, i) => {
          const e = active.find((x) => x.code === r.code)!;
          const c = calc[i];
          return (
            <li key={r.code} aria-label={`${e.code} ${e.name}`} className="grid gap-3 border-t border-rule pt-2 sm:grid-cols-3 lg:grid-cols-[minmax(0,1.4fr)_repeat(3,minmax(0,1fr))_minmax(0,1.6fr)]">
              <div className="flex flex-col justify-center text-[15px] sm:col-span-3 lg:col-span-1">
                <span><span className="font-num">{e.code}</span> {e.name}</span>
                <span className="text-[13px] text-ink2">{e.sso ? t.ssoShort : `${t.ssoShort}: ${t.no}`}</span>
              </div>
              <TextField label={t.salary} value={r.salary} onChange={(v) => set(i, { salary: v })} inputMode="decimal" mono />
              <TextField label={t.otherIncome} value={r.other} onChange={(v) => set(i, { other: v })} inputMode="decimal" mono />
              <TextField label={t.wht} value={r.wht} onChange={(v) => set(i, { wht: v })} inputMode="decimal" mono error={c && c.net < 0 ? t.whtTooHigh : null} />
              <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 text-[14px] sm:col-span-3 lg:col-span-1">
                <dt className="text-ink2">{t.ssoEmployee}</dt><dd className="text-right">{c ? <Money value={fromCents(c.ss)} /> : '—'}</dd>
                <dt className="text-ink2">{t.net}</dt><dd className="text-right font-medium">{c ? <Money value={fromCents(c.net)} /> : '—'}</dd>
              </dl>
            </li>
          );
        })}
      </ol>
      <div className="grid gap-3 sm:grid-cols-2">
        <DateInput label={t.payDate} value={date} onChange={setDate} invalid={iso === null} />
        <AccountSelect label={t.cashAccount} value={cash} onChange={setCash} accounts={data.cashAccounts} />
      </div>
      <p className="text-sm">{t.entry(m(sum('wage')), m(sum('ss')), m(sum('ss') * 2n), m(sum('wht')), m(sum('net')))}</p>
      {a.error && <p role="alert" className="neg text-[15px]">{a.error}</p>}
      {done && <p role="status" className="text-[15px]">{done}</p>}
      <div><Button type="submit" disabled={a.busy || !ok} className="max-sm:w-full">{t.post}</Button></div>
    </form>
  );
}

function PostedRun({ companyId, data, writable }: { companyId: string; data: PayrollPage; writable: boolean }) {
  const run = data.runs.find((r) => !r.voided)!;
  const lines = data.lines.filter((l) => l.runId === run.id);
  const [voiding, setVoiding] = useState(false);
  return (
    <section aria-label={t.run(monthLabel(data.month))} className="flex flex-col gap-2 border border-rule-strong bg-paper p-4 sm:p-6">
      <h2 className="font-doc text-[18px] font-bold">{t.run(monthLabel(data.month))}</h2>
      <p className="text-[15px]"><Link href={`/c/${companyId}/journal/${run.entryId}`} className="font-num underline decoration-rule-input">{run.docNo}</Link> {t.paidOn(isoToThai(run.payDate))}</p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[44rem] border-collapse text-[14px]">
          <thead className="bg-band"><tr>
            <th className={`${cell} text-left font-medium`}>{t.name}</th>
            <th className={`${cell} text-right font-medium`}>{t.salary}</th>
            <th className={`${cell} text-right font-medium`}>{t.otherIncome}</th>
            <th className={`${cell} text-right font-medium`}>{t.ssoEmployee}</th>
            <th className={`${cell} text-right font-medium`}>{t.ssoEmployer}</th>
            <th className={`${cell} text-right font-medium`}>{t.wht}</th>
            <th className={`${cell} text-right font-medium`}>{t.net}</th>
          </tr></thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.code}>
                <th scope="row" className={`${cell} text-left font-normal`}><span className="font-num">{l.code}</span> {l.name}</th>
                <td className={`${cell} text-right`}><Money value={l.salary} /></td>
                <td className={`${cell} text-right`}><Money value={l.otherIncome} /></td>
                <td className={`${cell} text-right`}><Money value={l.ssoEmployee} /></td>
                <td className={`${cell} text-right`}><Money value={l.ssoEmployer} /></td>
                <td className={`${cell} text-right`}><Money value={l.wht} /></td>
                <td className={`${cell} text-right`}><Money value={l.net} /></td>
              </tr>
            ))}
            <tr className="font-semibold">
              <th scope="row" className={`${cell} text-left`}>{t.total}</th>
              <td colSpan={2} className={`${cell} text-right`}><Money value={run.wages} /></td>
              <td className={`${cell} text-right`}><Money value={run.ssoEmployee} /></td>
              <td className={`${cell} text-right`}><Money value={run.ssoEmployer} /></td>
              <td className={`${cell} text-right`}><Money value={run.wht} /></td>
              <td className={`${cell} text-right`}><Money value={run.net} /></td>
            </tr>
          </tbody>
        </table>
      </div>
      {writable && !voiding && <div><Button type="button" variant="secondary" className="min-h-11 px-3 text-sm" onClick={() => setVoiding(true)}>{t.voidRun}</Button></div>}
      {voiding && <VoidPanel companyId={companyId} kind="run" id={run.id} docNo={run.docNo} base={run.payDate} onDone={() => setVoiding(false)} />}
    </section>
  );
}

function Remittances({ companyId, data, writable }: { companyId: string; data: PayrollPage; writable: boolean }) {
  const run = data.runs.find((r) => !r.voided)!;
  const [open, setOpen] = useState<string | null>(null);
  const kinds = [
    { kind: 'sso' as const, label: t.remitSso, amount: fromCents((toCents(run.ssoEmployee) ?? 0n) + (toCents(run.ssoEmployer) ?? 0n)), account: '2260' },
    { kind: 'pnd1' as const, label: t.remitPnd1, amount: run.wht, account: '2231' },
  ];
  return (
    <section aria-label={t.remit} className="flex flex-col gap-2">
      <h2 className="text-[17px] font-semibold">{t.remit}</h2>
      <ul className="border-t border-rule-strong bg-paper">
        {kinds.map((k) => {
          const done = data.remittances.find((r) => r.kind === k.kind && !r.voided);
          return (
            <li key={k.kind} aria-label={k.label} className="flex flex-col gap-1 border-b border-rule px-4 py-3">
              <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3"><span>{k.label}</span><Money value={k.amount} /></div>
              <span className="text-[13px]">{done ? t.remitted(done.docNo, isoToThai(done.date)) : k.amount === '0.00' ? t.nothing : ''}</span>
              {writable && k.amount !== '0.00' && (
                <div className="flex gap-2">
                  {done
                    ? <Button type="button" variant="secondary" className="min-h-11 px-3 text-sm" onClick={() => setOpen(`void:${k.kind}`)}>{t.voidRemit}</Button>
                    : <Button type="button" className="min-h-11 px-3 text-sm" onClick={() => setOpen(k.kind)}>{t.remitBtn}</Button>}
                </div>
              )}
              {open === k.kind && <RemitPanel companyId={companyId} data={data} kind={k.kind} label={k.label} account={k.account} base={run.payDate} onDone={() => setOpen(null)} />}
              {open === `void:${k.kind}` && done && <VoidPanel companyId={companyId} kind="remittance" id={done.id} docNo={done.docNo} base={done.date} onDone={() => setOpen(null)} />}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function RemitPanel({ companyId, data, kind, label, account, base, onDone }: {
  companyId: string; data: PayrollPage; kind: 'sso' | 'pnd1'; label: string; account: string; base: string; onDone: () => void;
}) {
  const [date, setDate] = useState(isoToThai(todayIso() > base ? todayIso() : base));
  const [cash, setCash] = useState(data.cashAccounts[0]?.code ?? '');
  const a = useAction();
  const iso = thaiToIso(date);
  return (
    <ConfirmPanel title={t.remitTitle(label)} explain={t.remitExplain(account)} ready={iso !== null && cash !== ''} busy={a.busy} error={a.error} onCancel={onDone}
      onConfirm={async () => { if (await a.run(`/companies/${companyId}/payroll/remit`, { month: data.month, kind, date: iso, cashAccount: cash })) onDone(); }}>
      <div className="grid gap-3 @md:grid-cols-2">
        <DateInput label={t.remitDate} value={date} onChange={setDate} invalid={iso === null} />
        <AccountSelect label={t.cashAccount} value={cash} onChange={setCash} accounts={data.cashAccounts} />
      </div>
    </ConfirmPanel>
  );
}

function VoidPanel({ companyId, kind, id, docNo, base, onDone }: { companyId: string; kind: 'run' | 'remittance'; id: string; docNo: string; base: string; onDone: () => void }) {
  const [date, setDate] = useState(isoToThai(todayIso() > base ? todayIso() : base));
  const [reason, setReason] = useState('');
  const a = useAction();
  const iso = thaiToIso(date);
  return (
    <ConfirmPanel title={t.voidTitle(docNo)} explain={t.voidExplain} ready={iso !== null && reason.trim() !== ''} busy={a.busy} error={a.error} onCancel={onDone}
      onConfirm={async () => { if (await a.run(`/companies/${companyId}/payroll/${kind}/${id}/void`, { date: iso, reason: reason.trim() })) onDone(); }}>
      <div className="grid gap-3 @md:grid-cols-2">
        <DateInput label={t.voidDate} value={date} onChange={setDate} invalid={iso === null} />
        <PlainInput label={t.reason} value={reason} onChange={setReason} maxLength={300} />
      </div>
    </ConfirmPanel>
  );
}

function YearSummary({ data }: { data: PayrollPage }) {
  const y = String(Number(data.month.slice(0, 4)) + 543);
  return (
    <section aria-label={t.year(y)} className="flex flex-col gap-2">
      <h2 className="text-[17px] font-semibold">{t.year(y)}</h2>
      {data.year.length === 0 ? <p className="text-ink2">{t.noYear}</p> : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[32rem] border-collapse bg-paper text-[14px]">
            <thead className="bg-band"><tr>
              <th className={`${cell} text-left font-medium`}>{t.name}</th>
              <th className={`${cell} text-right font-medium`}>{t.months}</th>
              <th className={`${cell} text-right font-medium`}>{t.income}</th>
              <th className={`${cell} text-right font-medium`}>{t.ssoEmployee}</th>
              <th className={`${cell} text-right font-medium`}>{t.wht}</th>
            </tr></thead>
            <tbody>
              {data.year.map((r) => (
                <tr key={r.code}>
                  <th scope="row" className={`${cell} text-left font-normal`}><span className="font-num">{r.code}</span> {r.name}</th>
                  <td className={`${cell} text-right font-num`}>{r.months}</td>
                  <td className={`${cell} text-right`}><Money value={r.income} /></td>
                  <td className={`${cell} text-right`}><Money value={r.sso} /></td>
                  <td className={`${cell} text-right`}><Money value={r.wht} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
