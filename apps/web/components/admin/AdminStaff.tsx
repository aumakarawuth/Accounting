'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { postJson, type ApiError, type Staff } from '@/lib/api';
import { th } from '@/i18n/th';
import type { Slip } from '../PasswordSlips';

type RowState = { confirm?: 'reset' | 'deactivate'; busy?: boolean; note?: string; error?: string };

export function AdminStaff({ staff, onIssued }: { staff: Staff[]; onIssued: (s: Slip[]) => void }) {
  const router = useRouter();
  const [form, setForm] = useState({ email: '', name: '', role: 'teacher' as 'teacher' | 'admin' });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const set = (id: string, s: RowState) => setRows((x) => ({ ...x, [id]: s }));
  const input = 'h-11 w-full rounded-doc border border-rule-input bg-paper px-3 text-base';
  const btn = 'min-h-11 rounded-doc border border-ink px-3 text-sm';
  const cell = 'border border-rule px-3 py-2';
  const slip = (s: { email: string; name: string }, temp: string): Slip =>
    ({ key: `${s.email}-${Date.now()}`, idLabel: th.admin.email, id: s.email, name: s.name, temp, staff: true });

  async function act(s: Staff, kind: 'reset' | 'deactivate' | 'activate') {
    if (rows[s.id]?.busy) return;
    if (kind !== 'activate' && rows[s.id]?.confirm !== kind) return set(s.id, { confirm: kind });
    set(s.id, { confirm: rows[s.id]?.confirm, busy: true }); // กันกดซ้ำระหว่างรอ
    try {
      if (kind === 'reset') {
        const r = await postJson<{ tempPassword: string }>(`/admin/users/${s.id}/reset-password`, {});
        set(s.id, { note: th.admin.tempFor(s.name, r.tempPassword) });
        onIssued([slip(s, r.tempPassword)]);
      } else {
        await postJson(`/admin/users/${s.id}/active`, { active: kind === 'activate' });
        set(s.id, { note: th.admin.saved });
        router.refresh();
      }
    } catch (e) {
      set(s.id, { error: (e as ApiError).message });
    }
  }

  return (
    <section className="flex flex-col gap-3 print:hidden">
      <h2 className="text-[17px] font-semibold">{th.admin.staff}</h2>
      <form
        className="grid gap-3 border border-rule-strong bg-paper p-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,2fr)_160px_auto] sm:items-end"
        onSubmit={async (e) => {
          e.preventDefault();
          setMsg(null);
          try {
            const r = await postJson<{ tempPassword: string }>('/admin/staff', form);
            setMsg({ ok: true, text: th.admin.created(form.name, r.tempPassword) });
            onIssued([slip(form, r.tempPassword)]);
            setForm({ email: '', name: '', role: 'teacher' });
            router.refresh();
          } catch (err) {
            setMsg({ ok: false, text: (err as ApiError).message });
          }
        }}
      >
        <label className="flex flex-col gap-1 text-sm">{th.admin.email}
          <input className={input} type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </label>
        <label className="flex flex-col gap-1 text-sm">{th.admin.name}
          <input className={input} required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </label>
        <label className="flex flex-col gap-1 text-sm">{th.admin.role}
          <select className={input} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as 'teacher' | 'admin' })}>
            <option value="teacher">{th.admin.roles.teacher}</option>
            <option value="admin">{th.admin.roles.admin}</option>
          </select>
        </label>
        <button type="submit" className="min-h-11 rounded-doc bg-ink px-4 font-medium text-paper">{th.admin.addStaff}</button>
        {msg && <p role={msg.ok ? 'status' : 'alert'} className={`text-sm sm:col-span-4 ${msg.ok ? '' : 'neg'}`}>{msg.text}</p>}
      </form>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] border-collapse bg-paper text-[15px]">
          <thead className="bg-band text-left text-sm">
            <tr>
              <th className={`${cell} font-medium`}>{th.admin.name}</th>
              <th className={`${cell} font-medium`}>{th.admin.email}</th>
              <th className={`${cell} font-medium`}>{th.admin.role}</th>
              <th className={`${cell} text-right font-medium`}>{th.admin.classroomCount}</th>
              <th className={`${cell} font-medium`}>{th.admin.status}</th>
              <th className={cell} />
            </tr>
          </thead>
          <tbody>
            {staff.map((s) => {
              const st = rows[s.id] ?? {};
              return (
                <tr key={s.id} className={s.active ? '' : 'text-ink2'}>
                  <td className={cell}>{s.name}</td>
                  <td className={`${cell} font-num text-sm`}>{s.email}</td>
                  <td className={cell}>{th.admin.roles[s.role]}</td>
                  <td className={`${cell} num`}>{s.classrooms}</td>
                  <td className={cell}>{s.active ? th.admin.active : th.admin.inactive}</td>
                  <td className={cell}>
                    <div className="flex flex-wrap gap-2">
                      <button type="button" disabled={st.busy} className={`${btn} ${st.confirm === 'reset' ? 'bg-ink text-paper' : ''} disabled:bg-disabled disabled:text-ink2`} onClick={() => act(s, 'reset')}>
                        {st.confirm === 'reset' ? th.admin.confirmReset : th.admin.resetPassword}
                      </button>
                      {s.active ? (
                        <button type="button" disabled={st.busy} className={`${btn} ${st.confirm === 'deactivate' ? 'bg-ink text-paper' : ''} disabled:bg-disabled disabled:text-ink2`} onClick={() => act(s, 'deactivate')}>
                          {st.confirm === 'deactivate' ? th.admin.confirmDeactivate : th.admin.deactivate}
                        </button>
                      ) : (
                        <button type="button" disabled={st.busy} className={btn} onClick={() => act(s, 'activate')}>{th.admin.activate}</button>
                      )}
                    </div>
                    {(st.note || st.error) && <p role="status" className={`mt-1 text-sm ${st.error ? 'neg' : ''}`}>{st.note ?? st.error}</p>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
