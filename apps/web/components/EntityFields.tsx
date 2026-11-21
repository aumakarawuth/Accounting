'use client';

import { SelectField, TextField } from '@/components/Fields';
import type { Account, EntityType } from '@/lib/api';
import { formatMoney, fromCents, toCents } from '@/lib/money';
import { th } from '@/i18n/th';

const t = th.entity;
export type PartnerDraft = { name: string; ratio: string; interestRate: string; salary: string };
export type EntityDraft = { type: EntityType; partners: PartnerDraft[]; parValue: string; registeredShares: string };
export const emptyPartner = (): PartnerDraft => ({ name: '', ratio: '1', interestRate: '0', salary: '0' });
export const defaultEntity = (): EntityDraft => ({ type: 'sole', partners: [emptyPartner(), emptyPartner()], parValue: '10', registeredShares: '' });

const MONEY = /^\d{1,16}(\.\d{1,2})?$/;
/** ตรวจก่อนส่ง (DB ตรวจซ้ำที่ acc.normalize_entity) */
export function entityError(e: EntityDraft): string | null {
  if (e.type === 'partnership') {
    const bad = e.partners.length < 2 || e.partners.length > 9 || e.partners.some((p) =>
      !p.name.trim() || !/^\d{1,5}(\.\d{1,4})?$/.test(p.ratio) || Number(p.ratio) <= 0
      || !/^\d{1,3}(\.\d{1,3})?$/.test(p.interestRate) || Number(p.interestRate) > 100 || !MONEY.test(p.salary));
    return bad ? t.invalidPartners : null;
  }
  if (e.type === 'company') {
    return !MONEY.test(e.parValue) || Number(e.parValue) <= 0 || (e.registeredShares !== '' && !/^\d{1,15}$/.test(e.registeredShares)) ? t.invalidShares : null;
  }
  return null;
}

/** รูปแบบที่ API รับ (EntityInput) */
export function entityBody(e: EntityDraft) {
  if (e.type === 'partnership') return { type: e.type, partners: e.partners.map((p) => ({ ...p, name: p.name.trim() })) };
  if (e.type === 'company') return { type: e.type, parValue: e.parValue, ...(e.registeredShares ? { registeredShares: e.registeredShares } : {}) };
  return { type: e.type };
}

/** ค่าจากข้อมูลที่บันทึกไว้ (acc.normalize_entity) */
export function entityFromJson(j: Record<string, unknown> | null | undefined): EntityDraft {
  const d = defaultEntity();
  if (!j || typeof j.type !== 'string') return d;
  const partners = Array.isArray(j.partners)
    ? (j.partners as Record<string, unknown>[]).map((p) => ({ name: String(p.name ?? ''), ratio: String(p.ratio ?? '1'), interestRate: String(p.interest_rate ?? '0'), salary: String(p.salary ?? '0') }))
    : d.partners;
  return { type: j.type as EntityType, partners, parValue: j.par_value !== null && j.par_value !== undefined ? String(j.par_value) : d.parValue, registeredShares: j.registered_shares !== null && j.registered_shares !== undefined ? String(j.registered_shares) : '' };
}

/** บัญชีส่วนของเจ้าของที่ประเภทกิจการนี้จะมี (ใช้ตรวจเฉลยในชุดโจทย์) */
export function entityAccounts(e: EntityDraft): Account[] {
  const eq = (code: string, name: string): Account => ({ code, name, type: 'equity', normal_side: 'credit' });
  if (e.type === 'partnership') {
    return e.partners.flatMap((p, i) => {
      const n = i + 1, who = p.name.trim() || t.partner(n);
      return [eq(`31${n}0`, `ทุน – ${who}`), eq(`32${n}0`, `กระแสทุน – ${who}`), eq(`33${n}0`, `ถอนใช้ – ${who}`)];
    });
  }
  if (e.type === 'company') {
    return [eq('3110', 'ทุนเรือนหุ้นสามัญ'), eq('3120', 'ส่วนเกินมูลค่าหุ้นสามัญ'), eq('3210', 'กำไรสะสม – ยังไม่ได้จัดสรร'),
      eq('3220', 'กำไรสะสม – จัดสรรเป็นทุนสำรองตามกฎหมาย'), { code: '2320', name: 'เงินปันผลค้างจ่าย', type: 'liability', normal_side: 'credit' }];
  }
  return [];
}

/** ช่องเลือกประเภทกิจการ + สัญญาหุ้นส่วน / ข้อมูลหุ้น (ใช้ในหน้าครูเปิดบริษัท ชุดโจทย์ และตั้งค่าบริษัท) */
export function EntityFields({ value, onChange, typeLocked = false, minPartners = 2 }: {
  value: EntityDraft; onChange: (v: EntityDraft) => void; typeLocked?: boolean; minPartners?: number;
}) {
  const setPartner = (i: number, patch: Partial<PartnerDraft>) =>
    onChange({ ...value, partners: value.partners.map((p, j) => (j === i ? { ...p, ...patch } : p)) });
  const regCap = value.type === 'company' && /^\d+$/.test(value.registeredShares) && MONEY.test(value.parValue)
    ? formatMoney(fromCents(BigInt(value.registeredShares) * (toCents(value.parValue) ?? 0n))) : null;
  return (
    <div className="flex flex-col gap-3">
      {typeLocked ? (
        <p className="text-[15px]"><span className="text-ink2">{t.type}</span> {t.types[value.type]}</p>
      ) : (
        <SelectField label={t.type} value={value.type} onChange={(v) => onChange({ ...value, type: v as EntityType })}>
          {(['sole', 'partnership', 'company'] as const).map((k) => <option key={k} value={k}>{t.types[k]}</option>)}
        </SelectField>
      )}
      <p className="text-[13px] text-ink2">{t.typeNotes[value.type]}</p>
      {value.type === 'partnership' && (
        <fieldset className="flex flex-col gap-3">
          <legend className="pb-1 text-[15px] font-semibold">{t.partners}</legend>
          <ol className="flex flex-col gap-3">
            {value.partners.map((p, i) => (
              <li key={i} aria-label={t.partner(i + 1)} className="grid gap-3 border-t border-rule pt-2 sm:grid-cols-[minmax(0,1fr)_7rem_8rem_9rem]">
                <div className="sm:col-span-4 flex flex-wrap items-center gap-3 text-sm">
                  <span className="font-medium">{t.partner(i + 1)}</span>
                  <span className="font-num text-[13px] text-ink2">{t.accounts(i + 1)}</span>
                  {value.partners.length > Math.max(2, minPartners) && i >= minPartners && (
                    <button type="button" className="ml-auto min-h-11 rounded-doc border border-ink px-3 text-sm"
                      onClick={() => onChange({ ...value, partners: value.partners.filter((_, j) => j !== i) })}>{t.removePartner}</button>
                  )}
                </div>
                <TextField label={t.partnerName} value={p.name} onChange={(v) => setPartner(i, { name: v })} maxLength={100} />
                <TextField label={t.ratio} value={p.ratio} onChange={(v) => setPartner(i, { ratio: v.trim() })} inputMode="decimal" mono />
                <TextField label={t.interestRate} value={p.interestRate} onChange={(v) => setPartner(i, { interestRate: v.trim() })} inputMode="decimal" mono />
                <TextField label={t.salary} value={p.salary} onChange={(v) => setPartner(i, { salary: v.replace(/,/g, '').trim() })} inputMode="decimal" mono />
              </li>
            ))}
          </ol>
          {value.partners.length < 9 && (
            <div>
              <button type="button" className="min-h-11 rounded-doc border border-ink px-3 text-sm"
                onClick={() => onChange({ ...value, partners: [...value.partners, emptyPartner()] })}>{t.addPartner}</button>
            </div>
          )}
          <p className="text-[13px] text-ink2">{t.allocationNote}</p>
        </fieldset>
      )}
      {value.type === 'company' && (
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField label={t.parValue} value={value.parValue} onChange={(v) => onChange({ ...value, parValue: v.trim() })} inputMode="decimal" mono />
          <TextField label={t.registeredShares} value={value.registeredShares} onChange={(v) => onChange({ ...value, registeredShares: v.replace(/\D/g, '') })}
            inputMode="numeric" mono hint={regCap ? t.registeredCapital(regCap) : undefined} />
        </div>
      )}
    </div>
  );
}
