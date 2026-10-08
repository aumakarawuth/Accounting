'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { postJson, type AdminClassroom, type ApiError, type Staff } from '@/lib/api';
import { th } from '@/i18n/th';
import type { Slip } from '../PasswordSlips';
import { StudentImport } from '../StudentImport';

export function AdminClassrooms({ rooms, teachers, onIssued }: { rooms: AdminClassroom[]; teachers: Staff[]; onIssued: (s: Slip[]) => void }) {
  const router = useRouter();
  const [form, setForm] = useState({ name: '', teacherId: '' });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [rowMsg, setRowMsg] = useState<Record<string, string>>({});
  const [importing, setImporting] = useState<string | null>(null);
  const input = 'h-11 w-full rounded-doc border border-rule-input bg-paper px-3 text-base';
  const cell = 'border border-rule px-3 py-2';

  return (
    <section className="flex flex-col gap-3 print:hidden">
      <h2 className="text-[17px] font-semibold">{th.admin.classrooms}</h2>
      {teachers.length === 0 ? (
        <p className="text-ink2">{th.admin.noTeachers}</p>
      ) : (
        <form
          className="grid gap-3 border border-rule-strong bg-paper p-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,2fr)_auto] sm:items-end"
          onSubmit={async (e) => {
            e.preventDefault();
            setMsg(null);
            try {
              await postJson('/admin/classrooms', form);
              setMsg({ ok: true, text: th.admin.saved });
              setForm({ name: '', teacherId: '' });
              router.refresh();
            } catch (err) {
              setMsg({ ok: false, text: (err as ApiError).message });
            }
          }}
        >
          <label className="flex flex-col gap-1 text-sm">{th.admin.classroomName}
            <input className={input} required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </label>
          <label className="flex flex-col gap-1 text-sm">{th.admin.teacher}
            <select className={input} required value={form.teacherId} onChange={(e) => setForm({ ...form, teacherId: e.target.value })}>
              <option value="" disabled>{th.admin.chooseTeacher}</option>
              {teachers.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </label>
          <button type="submit" className="min-h-11 rounded-doc bg-ink px-4 font-medium text-paper">{th.admin.addClassroom}</button>
          {msg && <p role={msg.ok ? 'status' : 'alert'} className={`text-sm sm:col-span-3 ${msg.ok ? '' : 'neg'}`}>{msg.text}</p>}
        </form>
      )}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] border-collapse bg-paper text-[15px]">
          <thead className="bg-band text-left text-sm">
            <tr>
              <th className={`${cell} font-medium`}>{th.admin.classroomName}</th>
              <th className={`${cell} font-medium`}>{th.admin.teacher}</th>
              <th className={`${cell} text-right font-medium`}>{th.admin.students}</th>
              <th className={cell} />
            </tr>
          </thead>
          <tbody>
            {rooms.map((r) => (
              <tr key={r.id}>
                <td className={cell}>{r.name}</td>
                <td className={cell}>
                  <select
                    aria-label={`${th.admin.teacher} ${r.name}`}
                    className="h-11 w-full rounded-doc border border-rule-input bg-paper px-2 text-base"
                    defaultValue={r.teacherId}
                    onChange={async (e) => {
                      try {
                        await postJson(`/admin/classrooms/${r.id}/teacher`, { teacherId: e.target.value });
                        setRowMsg((x) => ({ ...x, [r.id]: th.admin.saved }));
                        router.refresh();
                      } catch (err) {
                        setRowMsg((x) => ({ ...x, [r.id]: (err as ApiError).message }));
                      }
                    }}
                  >
                    {teachers.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                  {rowMsg[r.id] && <p role="status" className="mt-1 text-sm">{rowMsg[r.id]}</p>}
                </td>
                <td className={`${cell} num`}>{r.students}</td>
                <td className={cell}>
                  <button type="button" className="min-h-11 rounded-doc border border-ink px-3 text-sm" aria-expanded={importing === r.id}
                    onClick={() => setImporting(importing === r.id ? null : r.id)}>
                    {importing === r.id ? th.import.close : th.import.open}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {importing && (
        <StudentImport
          classroomId={importing}
          roomName={rooms.find((r) => r.id === importing)?.name ?? ''}
          onIssued={onIssued}
        />
      )}
    </section>
  );
}
