'use client';

import { useState } from 'react';
import { Button } from '@/components/Button';
import { CheckField, SelectField, TextField } from '@/components/Fields';
import { patchJson, postJson, type ApiError, type Party, type WhtKind } from '@/lib/api';
import { MASTER_CODE, validTaxId } from '@/lib/taxid';
import { th } from '@/i18n/th';

type Filter = 'all' | 'customer' | 'vendor';
const KINDS: WhtKind[] = ['transport', 'advertising', 'service', 'professional', 'rent', 'other'];
const RATE = /^\d{1,2}(\.\d{1,2})?$/;

const errText = (e: unknown) => {
  const err = e as ApiError;
  return err.code === 'server' ? th.error.server(err.ref ?? '-') : err.message;
};

// ลูกค้า/ผู้ขาย: รายการ + เพิ่ม/แก้ในหน้าเดียว (มือถือแสดงทีละรายการเป็นแถวซ้อน)
export function Parties({ companyId, initial, editable }: { companyId: string; initial: Party[]; editable: boolean }) {
  const [rows, setRows] = useState(initial);
  const [filter, setFilter] = useState<Filter>('all');
  const [showInactive, setShowInactive] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const upsert = (p: Party) => setRows((rs) => [...rs.filter((r) => r.code !== p.code), p].sort((a, b) => a.code.localeCompare(b.code)));
  const inactive = rows.filter((r) => !r.active).length;
  const visible = rows.filter((r) => (showInactive || r.active)
    && (filter === 'all' || (filter === 'customer' ? r.isCustomer : r.isVendor)));
  const tabs: [Filter, string][] = [['all', th.parties.all], ['customer', th.parties.customers], ['vendor', th.parties.vendors]];

  return (
    <div className="flex flex-col gap-4">
      {editable && !adding && (
        <div><Button type="button" variant="secondary" onClick={() => { setAdding(true); setEditing(null); setMessage(null); }} className="max-sm:w-full">{th.parties.add}</Button></div>
      )}
      {adding && (
        <PartyForm
          companyId={companyId}
          onDone={(p) => { if (p) { upsert(p); setMessage({ ok: true, text: th.master.added(p.code, p.name) }); } setAdding(false); }}
        />
      )}
      {message && <p role={message.ok ? 'status' : 'alert'} className={message.ok ? 'text-[15px]' : 'neg text-[15px]'}>{message.text}</p>}

      <div className="flex flex-wrap items-center gap-x-1 gap-y-2">
        {tabs.map(([f, label]) => (
          <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)}
            className="min-h-11 border border-rule-strong px-4 text-[15px] aria-pressed:bg-ink aria-pressed:text-paper">
            {label}
          </button>
        ))}
        {inactive > 0 && (
          <button type="button" className="ml-auto flex min-h-11 items-center text-sm underline" onClick={() => setShowInactive((v) => !v)}>
            {showInactive ? th.master.hideInactive : `${th.master.showInactive} (${inactive})`}
          </button>
        )}
      </div>

      <ul className="border border-rule-strong bg-paper" aria-label={th.parties.title}>
        {visible.length === 0 && <li className="px-3 py-4 text-ink2">{th.master.empty}</li>}
        {visible.map((p) => editing === p.code ? (
          <li key={p.code} className="border-t border-rule first:border-t-0">
            <PartyForm companyId={companyId} party={p}
              onDone={(saved) => { if (saved) { upsert(saved); setMessage({ ok: true, text: th.master.saved }); } setEditing(null); }} />
          </li>
        ) : (
          <li key={p.code} className={`grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 border-t border-rule px-3 py-2.5 first:border-t-0 ${p.active ? '' : 'text-ink2'}`}>
            <div className="min-w-0">
              <p><span className="font-num">{p.code}</span> <span className="font-medium">{p.name}</span></p>
              <p className="text-[13px] text-ink2">
                {[p.isCustomer && th.parties.customer, p.isVendor && th.parties.vendor,
                  p.vatRegistered ? th.master.vatRegistered : th.master.notVatRegistered,
                  p.creditDays > 0 ? th.parties.creditShort(p.creditDays) : th.parties.cash,
                  p.whtRate && th.parties.whtShort(String(Number(p.whtRate))),
                  !p.active && th.master.inactive].filter(Boolean).join(' · ')}
              </p>
              {p.taxId && (
                <p className="text-[13px] text-ink2">
                  {th.master.taxId} <span className="font-num">{p.taxId}</span> · {p.branchNo === '00000' ? th.master.headOffice : th.master.branch(p.branchNo)}
                </p>
              )}
            </div>
            {editable && (
              <span className="flex items-start gap-3">
                <button type="button" className="min-h-11 px-1 text-sm underline" onClick={() => { setEditing(p.code); setAdding(false); setMessage(null); }}>{th.master.edit}</button>
                <button type="button" className="min-h-11 px-1 text-sm underline"
                  onClick={async () => {
                    setMessage(null);
                    try { upsert(await patchJson<Party>(`/companies/${companyId}/parties/${p.code}`, { version: p.version, active: !p.active })); }
                    catch (e) { setMessage({ ok: false, text: errText(e) }); }
                  }}>
                  {p.active ? th.master.deactivate : th.master.activate}
                </button>
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function PartyForm({ companyId, party, onDone }: { companyId: string; party?: Party; onDone: (p: Party | null) => void }) {
  const [code, setCode] = useState(party?.code ?? '');
  const [name, setName] = useState(party?.name ?? '');
  const [isCustomer, setIsCustomer] = useState(party?.isCustomer ?? true);
  const [isVendor, setIsVendor] = useState(party?.isVendor ?? false);
  const [taxId, setTaxId] = useState(party?.taxId ?? '');
  const [branchNo, setBranchNo] = useState(party?.branchNo ?? '00000');
  const [address, setAddress] = useState(party?.address ?? '');
  const [vat, setVat] = useState(party?.vatRegistered ?? false);
  const [credit, setCredit] = useState(String(party?.creditDays ?? 0));
  const [whtKind, setWhtKind] = useState<WhtKind | ''>(party?.whtKind ?? '');
  const [whtRate, setWhtRate] = useState(party?.whtKind === 'other' && party.whtRate ? String(Number(party.whtRate)) : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const errors = {
    code: !party && code !== '' && !MASTER_CODE.test(code) ? th.master.codeInvalid : null,
    role: !isCustomer && !isVendor ? th.parties.roleRequired : null,
    taxId: taxId !== '' && !validTaxId(taxId) ? th.master.taxIdInvalid : vat && taxId === '' ? th.parties.vatNeedsTaxId : null,
    branch: !/^\d{5}$/.test(branchNo) ? th.master.branchInvalid : null,
    credit: !/^\d{1,3}$/.test(credit) || Number(credit) > 365 ? th.parties.creditDaysInvalid : null,
    whtRate: whtKind === 'other' && (!RATE.test(whtRate) || Number(whtRate) <= 0 || Number(whtRate) > 15) ? th.parties.whtRateInvalid : null,
  };
  const valid = (party || MASTER_CODE.test(code)) && name.trim() !== '' && Object.values(errors).every((e) => !e);

  async function submit() {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    const body = {
      name: name.trim(), isCustomer, isVendor, taxId: taxId || null, branchNo, address: address.trim(), vatRegistered: vat,
      creditDays: Number(credit), whtKind: whtKind || null, whtRate: whtKind === 'other' ? whtRate : null,
    };
    try {
      if (party) {
        // ส่งเฉพาะช่องที่เปลี่ยน (ประเภทหัก ณ ที่จ่ายมาตรฐานไม่ส่งอัตรา ให้ API ใส่อัตรามาตรฐาน)
        const changed: Record<string, unknown> = { version: party.version };
        const before: Record<string, unknown> = { ...party, whtRate: party.whtKind === 'other' ? party.whtRate && String(Number(party.whtRate)) : null };
        for (const [k, v] of Object.entries(body)) if (v !== before[k]) changed[k] = v;
        if (changed.whtKind !== undefined && whtKind !== 'other') delete changed.whtRate;
        onDone(await patchJson<Party>(`/companies/${companyId}/parties/${party.code}`, changed));
      } else {
        onDone(await postJson<Party>(`/companies/${companyId}/parties`, { code, ...body, whtRate: body.whtRate ?? undefined }));
      }
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="flex flex-col gap-4 border border-rule-strong bg-paper p-4 sm:p-6" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <h2 className="text-[17px] font-semibold">{party ? th.parties.editTitle(party.code) : th.parties.addTitle}</h2>
      <div className="grid gap-4 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-6">
        <TextField label={th.master.code} value={code} onChange={(v) => setCode(v.toUpperCase().trim())} mono maxLength={20}
          readOnly={Boolean(party)} hint={party ? undefined : th.master.codeHint} error={errors.code} />
        <TextField label={th.parties.name} value={name} onChange={setName} maxLength={160} />
      </div>
      <fieldset className="flex flex-col">
        <legend className="text-sm">{th.parties.role}</legend>
        <div className="flex flex-wrap gap-x-8">
          <CheckField label={th.parties.customer} checked={isCustomer} onChange={setIsCustomer} />
          <CheckField label={th.parties.vendor} checked={isVendor} onChange={setIsVendor} />
        </div>
        {errors.role && <span className="neg text-[13px]">{errors.role}</span>}
      </fieldset>
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_10rem] sm:gap-6">
        <TextField label={th.master.taxId} value={taxId} onChange={(v) => setTaxId(v.replace(/\D/g, '').slice(0, 13))}
          inputMode="numeric" mono hint={th.master.taxIdHint} error={errors.taxId} />
        <TextField label={th.master.branchNo} value={branchNo} onChange={(v) => setBranchNo(v.replace(/\D/g, '').slice(0, 5))}
          inputMode="numeric" mono hint={th.master.branchHint} error={errors.branch} />
      </div>
      <TextField label={th.master.address} value={address} onChange={setAddress} maxLength={400} multiline />
      <CheckField label={th.master.vatRegistered} checked={vat} onChange={setVat} />
      <div className="grid gap-4 sm:grid-cols-[10rem_minmax(0,1fr)_8rem] sm:items-start sm:gap-6">
        <TextField label={th.parties.creditDays} value={credit} onChange={(v) => setCredit(v.replace(/\D/g, '').slice(0, 3))}
          inputMode="numeric" mono error={errors.credit} />
        <SelectField label={th.parties.wht} value={whtKind} onChange={(v) => setWhtKind(v as WhtKind | '')}>
          <option value="">{th.parties.whtNone}</option>
          {KINDS.map((k) => <option key={k} value={k}>{th.parties.whtKinds[k]}</option>)}
        </SelectField>
        {whtKind === 'other' && (
          <TextField label={th.parties.whtRate} value={whtRate} onChange={setWhtRate} inputMode="decimal" mono error={errors.whtRate} />
        )}
      </div>
      {error && <p role="alert" className="neg text-[15px]">{error}</p>}
      <div className="flex flex-wrap gap-3">
        <Button type="submit" disabled={!valid || busy} className="max-sm:w-full">{th.master.save}</Button>
        <Button type="button" variant="secondary" disabled={busy} onClick={() => onDone(null)} className="max-sm:w-full">{th.master.cancel}</Button>
      </div>
    </form>
  );
}
