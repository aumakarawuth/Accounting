'use client';

import { useState } from 'react';
import { postJson, type ApiError, type Classroom } from '@/lib/api';
import { th } from '@/i18n/th';

type RowState = { confirm?: boolean; temp?: string; note?: string; error?: string };

// รีเซ็ตรหัส: กดสองจังหวะ (ปุ่มเปลี่ยนเป็น "ยืนยัน" ในที่เดิม ไม่ใช้ popup) แล้วแสดงรหัสชั่วคราวครั้งเดียว
export function TeacherClassrooms({ rooms }: { rooms: Classroom[] }) {
  const [state, setState] = useState<Record<string, RowState>>({});
  const set = (id: string, s: RowState) => setState((x) => ({ ...x, [id]: s }));
  const btn = 'min-h-11 rounded-doc border border-ink px-3 text-sm';

  async function reset(id: string) {
    if (!state[id]?.confirm) return set(id, { confirm: true });
    try {
      const r = await postJson<{ tempPassword: string }>(`/teacher/students/${id}/reset-password`, {});
      set(id, { temp: r.tempPassword });
    } catch (e) {
      set(id, { error: (e as ApiError).message });
    }
  }
  async function kick(id: string) {
    try {
      const r = await postJson<{ revoked: number }>(`/teacher/students/${id}/revoke-sessions`, {});
      set(id, { note: th.teacher.kicked(r.revoked) });
    } catch (e) {
      set(id, { error: (e as ApiError).message });
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {rooms.map((room) => (
        <section key={room.id} className="flex flex-col gap-2">
          <h2 className="text-[17px] font-semibold">
            {room.name} <span className="font-normal text-ink2">· {th.teacher.students(room.students.length)}</span>
          </h2>
          {room.students.length === 0 ? (
            <p className="text-ink2">{th.teacher.noStudents}</p>
          ) : (
            <ul className="border-t border-rule-strong bg-paper">
              {room.students.map((s) => {
                const st = state[s.id] ?? {};
                return (
                  <li key={s.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-rule px-4 py-2.5">
                    <span className="font-num">{s.studentCode}</span>
                    <span className="min-w-0 flex-1">{s.name}</span>
                    <button type="button" className={`${btn} ${st.confirm ? 'bg-ink text-paper' : ''}`} onClick={() => reset(s.id)}>
                      {st.confirm ? th.teacher.confirmReset : th.teacher.resetPassword}
                    </button>
                    <button type="button" className={btn} onClick={() => kick(s.id)}>{th.teacher.kickDevice}</button>
                    {(st.temp || st.note || st.error) && (
                      <p role="status" className={`basis-full text-sm ${st.error ? 'neg' : ''}`}>
                        {st.temp ? (
                          <>{th.teacher.tempPassword(st.temp).split(st.temp)[0]}<strong className="font-num text-base">{st.temp}</strong>{th.teacher.tempPassword(st.temp).split(st.temp)[1]}</>
                        ) : (st.note ?? st.error)}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}
