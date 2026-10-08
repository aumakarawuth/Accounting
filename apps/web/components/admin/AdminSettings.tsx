'use client';

import { useState } from 'react';
import { Button } from '@/components/Button';
import { CheckField } from '@/components/Fields';
import { postJson, type ApiError } from '@/lib/api';
import { th } from '@/i18n/th';

// ค่าตั้งของโรงเรียน: แบบกระดาษทำการที่เปิดให้ครู/นักเรียนใช้
export function AdminSettings({ worksheetFormats }: { worksheetFormats: number[] }) {
  const [formats, setFormats] = useState(worksheetFormats);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const t = th.adminSettings;
  const toggle = (f: number, on: boolean) => { setMsg(null); setFormats((x) => (on ? [...x, f] : x.filter((y) => y !== f)).sort((a, b) => a - b)); };
  const save = async () => {
    setBusy(true);
    try {
      const r = await postJson<{ worksheetFormats: number[] }>('/admin/settings/worksheet', { formats });
      setFormats(r.worksheetFormats);
      setMsg({ ok: true, text: t.saved });
    } catch (e) {
      const err = e as ApiError;
      setMsg({ ok: false, text: err.code === 'server' ? th.error.server(err.ref ?? '-') : err.message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="flex flex-col gap-3 print:hidden" aria-label={t.title}>
      <h2 className="text-[17px] font-semibold">{t.title}</h2>
      <div className="flex flex-col gap-2 border border-rule-strong bg-paper p-4">
        <p className="text-[15px] font-medium">{t.worksheet}</p>
        <div className="flex flex-wrap gap-x-8">
          {[6, 8, 10].map((f) => (
            <CheckField key={f} label={`${th.worksheet.title} ${th.worksheet.format(f)}`} checked={formats.includes(f)} onChange={(on) => toggle(f, on)} />
          ))}
        </div>
        <p className="text-[13px] text-ink2">{t.worksheetNote}</p>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" disabled={busy} onClick={() => void save()}>{t.save}</Button>
          {msg && <p role={msg.ok ? 'status' : 'alert'} className={msg.ok ? 'text-sm' : 'neg text-sm'}>{msg.text}</p>}
        </div>
      </div>
    </section>
  );
}
