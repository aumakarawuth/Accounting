'use client';

import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { postJson, type ApiError } from '@/lib/api';
import { decodeCsv, parseCsv, toStudentRows, type StudentRow } from '@/lib/csv';
import { th } from '@/i18n/th';
import type { Slip } from './PasswordSlips';

type Result = { studentCode: string; name: string; status: 'created' | 'enrolled' | 'already'; tempPassword?: string };

// นำเข้าทั้งชุดหรือไม่นำเข้าเลย: ถ้ามีแถวมีปัญหาต้องแก้ในไฟล์ก่อน (ตรงกับที่ API ตรวจ)
export function StudentImport({
  classroomId, roomName, existingCodes, onIssued,
}: { classroomId: string; roomName: string; existingCodes?: string[]; onIssued: (s: Slip[]) => void }) {
  const router = useRouter();
  const fileId = useId();
  const [rows, setRows] = useState<StudentRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  // ไม่รู้รายชื่อเดิม (หน้าผู้ดูแล) = บอกแค่ "พร้อมนำเข้า" ผลจริงดูหลังนำเข้า
  const inRoom = existingCodes ? new Set(existingCodes) : null;
  const bad = rows?.filter((r) => r.problems.length > 0).length ?? 0;
  const cell = 'border border-rule px-2 py-1.5';

  async function submit() {
    if (!rows || bad) return;
    setBusy(true);
    setMessage(null);
    try {
      const r = await postJson<{ results: Result[] }>(`/classrooms/${classroomId}/import`, {
        rows: rows.map(({ studentCode, name }) => ({ studentCode, name })),
      });
      const count = (s: Result['status']) => r.results.filter((x) => x.status === s).length;
      setMessage({ ok: true, text: th.import.done(count('created'), count('enrolled'), count('already')) });
      onIssued(r.results.filter((x) => x.tempPassword).map((x) => ({
        key: `${x.studentCode}-${Date.now()}`, idLabel: th.slips.studentCode, id: x.studentCode, name: x.name,
        room: roomName, temp: x.tempPassword!,
      })));
      setRows(null);
      router.refresh();
    } catch (e) {
      setMessage({ ok: false, text: (e as ApiError).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 border border-rule-strong bg-paper p-4">
      <p className="text-sm text-ink2">{th.import.help}</p>
      <label htmlFor={fileId} className="flex min-h-11 w-fit cursor-pointer items-center rounded-doc border border-ink px-4">
        {th.import.chooseFile}
      </label>
      <input
        id={fileId}
        type="file"
        accept=".csv,text/csv,text/plain"
        className="sr-only"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (!f) return;
          setMessage(null);
          setRows(toStudentRows(parseCsv(decodeCsv(await f.arrayBuffer()))).rows);
        }}
      />
      {rows && rows.length === 0 && <p className="neg text-sm">{th.import.empty}</p>}
      {rows && rows.length > 0 && (
        <>
          <p className={`text-sm ${bad ? 'neg' : ''}`}>{th.import.summary(rows.length - bad, bad)}</p>
          <div className="max-h-80 overflow-auto">
            <table className="w-full min-w-[420px] border-collapse text-sm">
              <thead className="sticky top-0 bg-band text-left">
                <tr>
                  <th className={`${cell} font-medium`}>{th.import.line}</th>
                  <th className={`${cell} font-medium`}>{th.slips.studentCode}</th>
                  <th className={`${cell} font-medium`}>{th.slips.name}</th>
                  <th className={`${cell} font-medium`}>{th.import.status}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.line} className={r.problems.length ? 'neg' : ''}>
                    <td className={`${cell} font-num`}>{r.line}</td>
                    <td className={`${cell} font-num whitespace-nowrap`}>{r.studentCode}</td>
                    <td className={`${cell} whitespace-nowrap`}>{r.name}</td>
                    <td className={cell}>
                      {r.problems.length
                        ? r.problems.map((p) => th.import.problem[p]).join(' · ')
                        : !inRoom ? th.import.ready : inRoom.has(r.studentCode) ? th.import.inRoom : th.import.willCreate}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button
            type="button"
            disabled={busy || bad > 0}
            onClick={submit}
            className="min-h-11 w-fit rounded-doc bg-ink px-4 font-medium text-paper disabled:bg-disabled disabled:text-ink2"
          >
            {busy ? th.import.importing : th.import.submit(rows.length)}
          </button>
        </>
      )}
      {message && <p role={message.ok ? 'status' : 'alert'} className={`text-sm ${message.ok ? '' : 'neg'}`}>{message.text}</p>}
    </div>
  );
}
