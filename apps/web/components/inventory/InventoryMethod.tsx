'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/Button';
import { putJson, type ApiError, type CostMethod } from '@/lib/api';
import { th } from '@/i18n/th';

const t = th.inventory;

// วิธีคิดต้นทุนตั้งต้นของบริษัท: DB ปฏิเสธเมื่อสินค้าที่ใช้วิธีนี้มีความเคลื่อนไหวแล้ว
export function InventoryMethod({ companyId, method, editable }: { companyId: string; method: CostMethod; editable: boolean }) {
  const router = useRouter();
  const [value, setValue] = useState<CostMethod>(method);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      await putJson(`/companies/${companyId}/inventory/method`, { method: value });
      setMsg({ ok: true, text: t.methodSaved });
      router.refresh();
    } catch (e) {
      setMsg({ ok: false, text: (e as ApiError).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-2 border border-rule-strong bg-paper p-4" aria-label={t.methodTitle}>
      <fieldset className="flex flex-col gap-1">
        <legend className="text-[17px] font-semibold">{t.methodTitle}</legend>
        <div className="flex flex-wrap gap-x-8">
          {(['average', 'fifo'] as const).map((m) => (
            <label key={m} className="flex min-h-11 items-center gap-3 text-[15px]">
              <input type="radio" name="inventory-method" className="size-5 text-base accent-ink" checked={value === m} disabled={!editable}
                onChange={() => setValue(m)} />
              {t.methods[m]}
            </label>
          ))}
        </div>
      </fieldset>
      <p className="text-sm text-ink2">{t.methodNote}</p>
      {editable && value !== method && (
        <Button type="button" disabled={busy} onClick={() => void save()} className="self-start max-sm:w-full">{t.methodSave}</Button>
      )}
      {msg && <p role={msg.ok ? 'status' : 'alert'} className={`text-sm ${msg.ok ? '' : 'neg'}`}>{msg.text}</p>}
    </section>
  );
}
