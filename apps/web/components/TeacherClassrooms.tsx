'use client';

import { useState } from 'react';
import { postJson, type ApiError, type Classroom } from '@/lib/api';
import { th } from '@/i18n/th';
import { nextSlipKey, PasswordSlips, type Slip } from './PasswordSlips';
import { OpenCompanies } from './OpenCompanies';
import { StudentImport } from './StudentImport';

type RowState = { confirm?: boolean; busy?: boolean; note?: string; error?: string };

// รีเซ็ตรหัส: กดสองจังหวะ (ปุ่มเปลี่ยนเป็น "ยืนยัน" ในที่เดิม ไม่ใช้ popup) รหัสชั่วคราวไปรวมที่ใบรหัสผ่านด้านล่าง
export function TeacherClassrooms({ rooms }: { rooms: Classroom[] }) {
  const [state, setState] = useState<Record<string, RowState>>({});
  const [importing, setImporting] = useState<string | null>(null);
  const [slips, setSlips] = useState<Slip[]>([]);
  const set = (id: string, s: RowState) => setState((x) => ({ ...x, [id]: s }));
  const btn = 'min-h-11 rounded-doc border border-ink px-3 text-sm';
  const addSlips = (s: Slip[]) => setSlips((x) => [...x, ...s]);

  async function reset(room: Classroom, s: Classroom['students'][number]) {
    if (state[s.id]?.busy) return;
    if (!state[s.id]?.confirm) return set(s.id, { confirm: true });
    set(s.id, { confirm: true, busy: true }); // กันกดยืนยันซ้ำระหว่างรอ (จะได้รหัสสองชุด)
    try {
      const r = await postJson<{ tempPassword: string }>(`/teacher/students/${s.id}/reset-password`, {});
      set(s.id, { note: th.teacher.tempPassword(r.tempPassword) });
      addSlips([{ key: nextSlipKey(), idLabel: th.slips.studentCode, id: s.studentCode, name: s.name, room: room.name, temp: r.tempPassword }]);
    } catch (e) {
      set(s.id, { error: (e as ApiError).message });
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
      <div className="flex flex-col gap-6 print:hidden">
        {rooms.map((room) => (
          <section key={room.id} className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-3">
              <h2 className="text-[17px] font-semibold">
                {room.name} <span className="font-normal text-ink2">· {th.teacher.students(room.students.length)}</span>
              </h2>
              <button type="button" className={`${btn} ml-auto`} aria-expanded={importing === room.id}
                onClick={() => setImporting(importing === room.id ? null : room.id)}>
                {importing === room.id ? th.import.close : th.import.open}
              </button>
            </div>
            {importing === room.id && (
              <StudentImport classroomId={room.id} roomName={room.name} existingCodes={room.students.map((s) => s.studentCode)} onIssued={addSlips} />
            )}
            {room.students.length > 0 && <OpenCompanies classroomId={room.id} />}
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
                      <span className={`text-sm ${s.companies === 0 ? 'text-ink2' : ''}`}>{th.teacher.companyCount(s.companies)}</span>
                      <button type="button" disabled={st.busy} className={`${btn} ${st.confirm ? 'bg-ink text-paper' : ''} disabled:bg-disabled disabled:text-ink2`} onClick={() => reset(room, s)}>
                        {st.confirm ? th.teacher.confirmReset : th.teacher.resetPassword}
                      </button>
                      <button type="button" className={btn} onClick={() => kick(s.id)}>{th.teacher.kickDevice}</button>
                      {(st.note || st.error) && (
                        <p role="status" className={`basis-full text-sm ${st.error ? 'neg' : ''}`}>{st.note ?? st.error}</p>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        ))}
      </div>
      <PasswordSlips slips={slips} onClear={() => setSlips([])} />
    </div>
  );
}
