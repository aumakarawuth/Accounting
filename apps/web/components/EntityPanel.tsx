'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/Button';
import { errText } from '@/components/ConfirmPanel';
import { api, type EntityInfo } from '@/lib/api';
import { th } from '@/i18n/th';
import { entityBody, entityError, EntityFields, type EntityDraft } from './EntityFields';

const t = th.entity;
const draftOf = (e: EntityInfo): EntityDraft => ({
  type: e.type,
  partners: e.partners.length ? e.partners.map((p) => ({ name: p.name, ratio: p.ratio, interestRate: p.interestRate, salary: p.salary }))
    : [{ name: '', ratio: '1', interestRate: '0', salary: '0' }, { name: '', ratio: '1', interestRate: '0', salary: '0' }],
  parValue: e.parValue ?? '10', registeredShares: e.registeredShares ?? '',
});

/** ตั้งค่า → ข้อมูลกิจการ: เปลี่ยนประเภท (ก่อนลงรายการแรก) · สัญญาหุ้นส่วน · ข้อมูลหุ้น */
export function EntityPanel({ companyId, initial, editable }: { companyId: string; initial: EntityInfo; editable: boolean }) {
  const router = useRouter();
  const [saved, setSaved] = useState(initial);
  const [draft, setDraft] = useState(() => draftOf(initial));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const typeChanged = draft.type !== saved.type;

  async function save() {
    const bad = entityError(draft);
    if (bad) { setMsg({ ok: false, text: bad }); return; }
    setBusy(true);
    setMsg(null);
    try {
      const body = typeChanged || saved.canChangeType
        ? { method: 'PUT', payload: { entity: entityBody(draft), version: saved.version } }
        : { method: 'PATCH', payload: { version: saved.version, ...(draft.type === 'partnership' ? { partners: draft.partners }
            : { parValue: draft.parValue, registeredShares: draft.registeredShares || null }) } };
      const r = await api<EntityInfo>(`/companies/${companyId}/entity`, { method: body.method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body.payload) });
      setSaved(r);
      setDraft(draftOf(r));
      setMsg({ ok: true, text: t.saved });
      router.refresh();
    } catch (e) {
      setMsg({ ok: false, text: errText(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="entity-title" className="flex flex-col gap-3 border border-rule-strong bg-paper p-4 sm:p-6">
      <h2 id="entity-title" className="font-doc text-[18px] font-bold">{t.title}</h2>
      <p className="text-sm text-ink2">{saved.canChangeType ? t.changeTypeNote : t.typeLocked}</p>
      {editable ? (
        <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <EntityFields value={draft} onChange={setDraft} typeLocked={!saved.canChangeType}
            minPartners={saved.canChangeType ? 2 : saved.partners.length} />
          {msg && <p role={msg.ok ? 'status' : 'alert'} className={msg.ok ? 'text-[15px]' : 'neg text-[15px]'}>{msg.text}</p>}
          {(draft.type !== 'sole' || typeChanged) && <div><Button type="submit" disabled={busy} className="max-sm:w-full">{t.saveProfile}</Button></div>}
        </form>
      ) : (
        <EntityFields value={draft} onChange={() => {}} typeLocked />
      )}
    </section>
  );
}
