'use client';

import { useState } from 'react';
import { postJson, type ApiError } from '@/lib/api';
import { th } from '@/i18n/th';
import { nextSlipKey, type Slip } from '../PasswordSlips';

// ผู้ดูแลรีเซ็ตรหัสนักเรียนคนไหนก็ได้ในโรงเรียน ด้วยรหัสนักเรียน (ว่าง = สุ่ม)
export function AdminResetStudent({ onIssued }: { onIssued: (s: Slip[]) => void }) {
  const t = th.admin.resetStudent;
  const [code, setCode] = useState('');
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const input = 'h-11 w-full rounded-doc border border-rule-input bg-paper px-3 text-base';
  return (
    <section className="flex flex-col gap-3 print:hidden">
      <h2 className="text-[17px] font-semibold">{t.title}</h2>
      <form
        className="grid gap-3 border border-rule-strong bg-paper p-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end"
        onSubmit={async (e) => {
          e.preventDefault();
          if (busy) return;
          setBusy(true);
          setMsg(null);
          try {
            const r = await postJson<{ studentCode: string; name: string; tempPassword: string }>('/admin/students/reset-password',
              { studentCode: code.trim(), ...(pw.trim() ? { password: pw.trim() } : {}) });
            setMsg({ ok: true, text: t.done(r.name, r.tempPassword) });
            onIssued([{ key: nextSlipKey(), idLabel: th.slips.studentCode, id: r.studentCode, name: r.name, temp: r.tempPassword }]);
            setCode('');
            setPw('');
          } catch (err) {
            setMsg({ ok: false, text: (err as ApiError).message });
          } finally {
            setBusy(false);
          }
        }}
      >
        <label className="flex flex-col gap-1 text-sm">{t.code}
          <input className={`${input} font-num`} required autoCapitalize="none" value={code} onChange={(e) => setCode(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-sm">{th.admin.newPassword}
          <input className={input} placeholder={th.admin.newPasswordHint} value={pw} onChange={(e) => setPw(e.target.value)} />
        </label>
        <button disabled={busy} className="min-h-11 rounded-doc bg-ink px-4 text-sm font-medium text-paper disabled:bg-disabled disabled:text-ink2">{t.submit}</button>
        {msg && <p role="status" className={`text-sm sm:col-span-3 ${msg.ok ? '' : 'neg'}`}>{msg.text}</p>}
      </form>
    </section>
  );
}
