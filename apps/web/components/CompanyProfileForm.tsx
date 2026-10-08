'use client';

import { useState } from 'react';
import { Button } from '@/components/Button';
import { CheckField, TextField } from '@/components/Fields';
import { patchJson, type ApiError, type CompanyProfile } from '@/lib/api';
import { validTaxId } from '@/lib/taxid';
import { th } from '@/i18n/th';

const RATE = /^\d{1,2}(\.\d{1,2})?$/;

// ข้อมูลบริษัทและภาษี: พิมพ์บนใบกำกับภาษีที่ออก (เฟส 2.2) ส่งเฉพาะช่องที่เปลี่ยน + version
export function CompanyProfileForm({ companyId, initial, editable }: { companyId: string; initial: CompanyProfile; editable: boolean }) {
  const [saved, setSaved] = useState(initial);
  const [taxId, setTaxId] = useState(initial.taxId ?? '');
  const [branchNo, setBranchNo] = useState(initial.branchNo);
  const [address, setAddress] = useState(initial.address);
  const [vat, setVat] = useState(initial.vatRegistered);
  const [rate, setRate] = useState(String(Number(initial.vatRate)));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const taxErr = taxId !== '' && !validTaxId(taxId) ? th.master.taxIdInvalid : null;
  const branchErr = !/^\d{5}$/.test(branchNo) ? th.master.branchInvalid : null;
  const rateErr = !RATE.test(rate) ? th.profile.vatRateInvalid : null;
  const changes: Record<string, unknown> = {};
  if ((taxId || null) !== saved.taxId) changes.taxId = taxId || null;
  if (branchNo !== saved.branchNo) changes.branchNo = branchNo;
  if (address.trim() !== saved.address) changes.address = address.trim();
  if (vat !== saved.vatRegistered) changes.vatRegistered = vat;
  if (RATE.test(rate) && Number(rate) !== Number(saved.vatRate)) changes.vatRate = rate;
  const canSave = editable && !busy && !taxErr && !branchErr && !rateErr && Object.keys(changes).length > 0;

  async function submit() {
    if (!canSave) return;
    setBusy(true);
    setMessage(null);
    try {
      const p = await patchJson<CompanyProfile>(`/companies/${companyId}/profile`, { version: saved.version, ...changes });
      setSaved({ ...saved, ...p });
      setMessage({ ok: true, text: th.master.saved });
    } catch (e) {
      const err = e as ApiError;
      setMessage({ ok: false, text: err.code === 'server' ? th.error.server(err.ref ?? '-') : err.message });
    } finally {
      setBusy(false);
    }
  }

  if (!editable) {
    return (
      <dl className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] gap-x-4 gap-y-2 border border-rule-strong bg-paper p-4 text-[15px]">
        <dt className="text-ink2">{th.profile.companyName}</dt><dd>{saved.name}</dd>
        <dt className="text-ink2">{th.master.taxId}</dt><dd className="font-num">{saved.taxId ?? '—'}</dd>
        <dt className="text-ink2">{th.master.branchNo}</dt>
        <dd>{saved.branchNo === '00000' ? th.master.headOffice : th.master.branch(saved.branchNo)}</dd>
        <dt className="text-ink2">{th.master.address}</dt><dd className="whitespace-pre-line">{saved.address || '—'}</dd>
        <dt className="text-ink2">{th.master.vatRegistered}</dt>
        <dd>{saved.vatRegistered ? `${Number(saved.vatRate)}%` : th.master.notVatRegistered}</dd>
      </dl>
    );
  }

  return (
    <form className="flex flex-col gap-4 border border-rule-strong bg-paper p-4 sm:p-6" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <p className="text-[15px]"><span className="text-ink2">{th.profile.companyName}</span> {saved.name}</p>
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_10rem] sm:gap-6">
        <TextField label={th.master.taxId} value={taxId} onChange={(v) => setTaxId(v.replace(/\D/g, '').slice(0, 13))}
          inputMode="numeric" mono hint={th.master.taxIdHint} error={taxErr} />
        <TextField label={th.master.branchNo} value={branchNo} onChange={(v) => setBranchNo(v.replace(/\D/g, '').slice(0, 5))}
          inputMode="numeric" mono hint={th.master.branchHint} error={branchErr} />
      </div>
      <TextField label={th.master.address} value={address} onChange={setAddress} maxLength={400} multiline />
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_10rem] sm:items-start sm:gap-6">
        <CheckField label={th.master.vatRegistered} checked={vat} onChange={setVat} note={vat ? th.profile.vatOn : th.profile.vatOff} />
        {vat && <TextField label={th.profile.vatRate} value={rate} onChange={setRate} inputMode="decimal" mono error={rateErr} />}
      </div>
      {message && <p role={message.ok ? 'status' : 'alert'} className={message.ok ? 'text-[15px]' : 'neg text-[15px]'}>{message.text}</p>}
      <div><Button type="submit" disabled={!canSave} className="max-sm:w-full">{th.master.save}</Button></div>
    </form>
  );
}
