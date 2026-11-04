'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { postJson, type ApiError, type AssignmentOverview, type Feedback, type Reveal } from '@/lib/api';
import { th } from '@/i18n/th';

const a = th.assignment;
const btn = 'min-h-11 rounded-doc px-4 font-medium disabled:bg-disabled disabled:text-ink2';
const primary = `${btn} bg-ink text-paper`;
const secondary = `${btn} border border-ink`;
const field = 'h-11 rounded-doc border border-rule-input bg-paper px-2 text-base';

// ครู: เปิด/ซ่อนเฉลย ปิด/เปิดงาน เพิ่มเวลาสอบ เปิดบริษัทให้คนที่ยังไม่มี และแก้การแสดงผล (ทุกครั้งบันทึกใน assignment_events)
export function AssignmentActions({ ov }: { ov: AssignmentOverview }) {
  const router = useRouter();
  const as = ov.assignment;
  const exam = as.mode === 'exam';
  const [busy, setBusy] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [minutes, setMinutes] = useState('10');
  const [feedback, setFeedback] = useState<Feedback>(as.feedback);
  const [reveal, setReveal] = useState<Reveal>(as.reveal);
  const [checkDate, setCheckDate] = useState(as.checkDate);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function act(body: object, done?: (r: Record<string, number>) => string) {
    setBusy(true);
    setMsg(null);
    try {
      const r = await postJson<Record<string, number>>(`/teacher/assignments/${as.id}/actions`, body);
      if (done) setMsg({ ok: true, text: done(r) });
      setConfirmClose(false);
      router.refresh();
    } catch (e) {
      setMsg({ ok: false, text: (e as ApiError).message });
    } finally {
      setBusy(false);
    }
  }

  async function saveOptions() {
    setBusy(true);
    setMsg(null);
    try {
      await postJson(`/teacher/assignments/${as.id}/options`, { feedback, reveal, checkDate });
      setMsg({ ok: true, text: a.optionsSaved });
      router.refresh();
    } catch (e) {
      setMsg({ ok: false, text: (e as ApiError).message });
    } finally {
      setBusy(false);
    }
  }

  const reveals: Reveal[] = exam ? ['after_release'] : as.mode === 'practice' ? ['anytime', 'after_release'] : ['anytime', 'after_submit', 'after_release'];
  return (
    <section aria-label={a.options} className="flex flex-col gap-3 border border-rule-strong bg-paper p-4 print:hidden">
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={busy} className={as.releasedAt ? secondary : primary}
          onClick={() => act({ action: as.releasedAt ? 'hide' : 'release' })}>{as.releasedAt ? a.hide : a.release}</button>
        {as.closedAt ? (
          <button type="button" disabled={busy} className={secondary} onClick={() => act({ action: 'reopen' })}>{a.reopen}</button>
        ) : confirmClose ? (
          <button type="button" disabled={busy} className={primary} onClick={() => act({ action: 'close' })}>{a.confirmClose}</button>
        ) : (
          <button type="button" disabled={busy} className={secondary} onClick={() => setConfirmClose(true)}>{exam ? a.closeExam : a.close}</button>
        )}
        <button type="button" disabled={busy} className={secondary}
          onClick={() => act({ action: 'open-companies' }, (r) => a.openedCompanies(r.created ?? 0))}>{a.openCompanies}</button>
      </div>
      {exam && (
        <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => {
          e.preventDefault();
          void act({ action: 'extend', minutes: Number(minutes) }, (r) => a.extended(r.extended ?? 0, Number(minutes)));
        }}>
          <label className="flex flex-col gap-1 text-sm">{a.extendMinutes}
            <input className={`${field} w-24 text-right font-num`} inputMode="numeric" pattern="[0-9]{1,3}" required value={minutes} onChange={(e) => setMinutes(e.target.value)} />
          </label>
          <button type="submit" disabled={busy} className={secondary}>{a.extendAll}</button>
        </form>
      )}
      <form className="flex flex-wrap items-end gap-3 border-t border-rule pt-3" onSubmit={(e) => { e.preventDefault(); void saveOptions(); }}>
        <label className="flex flex-col gap-1 text-sm">{th.assign.feedback}
          <select className={field} value={feedback} onChange={(e) => setFeedback(e.target.value as Feedback)}>
            {(['none', 'score', 'items', 'answers'] as const).map((f) => <option key={f} value={f}>{th.assign.feedbacks[f]}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">{th.assign.reveal}
          <select className={field} value={reveal} disabled={exam} onChange={(e) => setReveal(e.target.value as Reveal)}>
            {reveals.map((r) => <option key={r} value={r}>{th.assign.reveals[r]}</option>)}
          </select>
        </label>
        <label className="flex min-h-11 items-center gap-3 text-[15px]">
          <input type="checkbox" className="size-5 text-base accent-ink" checked={checkDate} onChange={(e) => setCheckDate(e.target.checked)} />
          {th.assign.checkDate}
        </label>
        <button type="submit" disabled={busy} className={secondary}>{a.saveOptions}</button>
      </form>
      {msg && <p role={msg.ok ? 'status' : 'alert'} className={`text-sm ${msg.ok ? '' : 'neg'}`}>{msg.text}</p>}
    </section>
  );
}

/** เพิ่มเวลารายคน (แถวนักเรียนในตารางคะแนน) */
export function ExtendOne({ assignmentId, companyId, label }: { assignmentId: string; companyId: string; label: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button type="button" disabled={busy} aria-label={label} className="min-h-11 rounded-doc border border-ink px-3 text-sm disabled:text-ink2"
      onClick={async () => {
        setBusy(true);
        try { await postJson(`/teacher/assignments/${assignmentId}/actions`, { action: 'extend', minutes: 10, companyId }); router.refresh(); }
        finally { setBusy(false); }
      }}>
      {th.assignment.extendBy(10)}
    </button>
  );
}
