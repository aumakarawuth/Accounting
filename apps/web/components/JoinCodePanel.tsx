'use client';

import { useState } from 'react';
import Link from 'next/link';
import { postJson, type ApiError } from '@/lib/api';
import { th } from '@/i18n/th';

// รหัสห้องของครู: สร้าง / เปลี่ยน (กดสองจังหวะ เพราะรหัสเดิมใช้ไม่ได้ทันที) / ปิด และลิงก์ไปหน้า QR ขึ้นจอ
export function JoinCodePanel({ classroomId, initial }: { classroomId: string; initial: string | null }) {
  const [code, setCode] = useState(initial);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const btn = 'min-h-11 rounded-doc border border-ink px-3 text-sm disabled:border-disabled disabled:text-ink2';

  async function set(enabled: boolean) {
    if (enabled && code && !confirm) { setConfirm(true); return; }
    setBusy(true);
    setError(null);
    try {
      const r = await postJson<{ joinCode: string | null }>(`/classrooms/${classroomId}/join-code`, { enabled });
      setCode(r.joinCode);
      setConfirm(false);
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 border border-rule-strong bg-paper px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="text-sm text-ink2">{th.teacher.joinCode}</span>
        {code ? <span className="font-num text-[22px] font-medium tracking-[0.2em]" aria-live="polite">{code}</span>
          : <span className="text-ink2">{th.teacher.joinCodeOff}</span>}
        <span className="flex flex-wrap gap-2 sm:ml-auto">
          {code && <Link href={`/teacher/classrooms/${classroomId}/qr`} className={`${btn} inline-flex items-center bg-ink text-paper`}>{th.teacher.showQr}</Link>}
          <button type="button" disabled={busy} className={`${btn} ${confirm ? 'bg-ink text-paper' : ''}`} onClick={() => void set(true)}>
            {!code ? th.teacher.joinCodeCreate : confirm ? th.teacher.joinCodeConfirmRenew : th.teacher.joinCodeRenew}
          </button>
          {code && <button type="button" disabled={busy} className={btn} onClick={() => void set(false)}>{th.teacher.joinCodeDisable}</button>}
        </span>
      </div>
      <p className="text-[13px] text-ink2">{th.teacher.joinCodeNote}</p>
      {error && <p role="alert" className="neg text-sm">{error}</p>}
    </div>
  );
}
