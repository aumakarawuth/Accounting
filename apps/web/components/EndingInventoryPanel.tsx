'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/Button';
import { errText, useAction } from '@/components/ConfirmPanel';
import { api, type EndingInventory } from '@/lib/api';
import { monthEndLabel, monthLabel } from '@/lib/date';
import { formatMoney, fromCents, toCents } from '@/lib/money';
import { th } from '@/i18n/th';

// ระบบสินค้าสิ้นงวด: ใส่ยอดตรวจนับ ณ สิ้นเดือน → AJ ปรับ 1310 คู่ 5130 (acc.record_ending_inventory)
// บริษัทที่ติดตามสต็อกรายสินค้าเห็นคำอธิบายแทนฟอร์ม · ส่วนต่างคำนวณซ้ำที่ DB ตอนบันทึก
export function EndingInventoryPanel({ companyId, months, writable }: { companyId: string; months: string[]; writable: boolean }) {
  const t = th.yearEnd;
  const [month, setMonth] = useState(months[months.length - 1] ?? '');
  const [info, setInfo] = useState<EndingInventory | null>(null);
  const [amount, setAmount] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const action = useAction();

  useEffect(() => {
    if (!month) return;
    let live = true;
    api<EndingInventory>(`/companies/${companyId}/ending-inventory?month=${month}`)
      .then((x) => { if (live) setInfo(x); }, (e) => { if (live) action.setError(errText(e)); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, month, done]);

  if (months.length === 0) return null;
  const counted = toCents(amount.replace(/,/g, ''));
  const gl = info ? toCents(info.glBalance) : null;
  const diff = counted !== null && gl !== null ? counted - gl : null;

  async function save() {
    const r = await action.run<{ docNo: string }>(`/companies/${companyId}/ending-inventory`, { month, amount: fromCents(counted!) });
    if (r) { setDone(t.endingOk(r.docNo)); setAmount(''); }
  }

  return (
    <section aria-labelledby="ending-inventory" className="flex flex-col gap-3 border border-rule-strong bg-paper p-4">
      <h2 id="ending-inventory" className="font-doc text-[18px] font-bold">{t.endingTitle}</h2>
      {info?.perpetual ? <p className="text-[15px]">{t.endingPerpetual}</p> : (
        <>
          <p className="text-[15px]">{t.endingNote}</p>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex min-w-40 flex-col text-sm">
              {t.endingMonth}
              <select className="h-11 border-b border-rule-input bg-transparent text-base" value={month}
                onChange={(e) => { setMonth(e.target.value); setDone(null); }}>
                {months.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
              </select>
            </label>
            {writable && (
              <label className="flex min-w-48 flex-col text-sm">
                {t.endingAmount}
                <input className="num h-11 border-b border-rule-input bg-transparent text-base" inputMode="decimal" value={amount}
                  onChange={(e) => { setAmount(e.target.value); setDone(null); }} aria-invalid={amount !== '' && counted === null} />
              </label>
            )}
          </div>
          {info && <p className="text-sm">{t.endingGl(monthEndLabel(month), formatMoney(info.glBalance))}</p>}
          {diff !== null && amount !== '' && (
            <p className="text-sm">{diff === 0n ? t.endingSame : t.endingPreview(formatMoney(fromCents(diff < 0n ? -diff : diff)), diff > 0n)}</p>
          )}
          {writable && info?.canWrite && (
            <Button type="button" disabled={action.busy || diff === null || diff === 0n || counted === null || counted < 0n}
              onClick={() => void save()} className="self-start max-sm:w-full">
              {t.endingSave}
            </Button>
          )}
        </>
      )}
      {action.error && <p role="alert" className="neg text-[15px]">{action.error}</p>}
      {done && <p role="status" className="text-[15px]">{done}</p>}
    </section>
  );
}
