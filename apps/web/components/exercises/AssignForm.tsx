'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { postJson, type ApiError, type AssignmentMode, type Feedback, type Reveal } from '@/lib/api';
import { th } from '@/i18n/th';

const a = th.assign;
const field = 'h-11 w-full rounded-doc border border-rule-input bg-paper px-2 text-base';

/** datetime-local (เวลาเครื่องผู้ใช้) → ISO มีเขตเวลา */
const toIso = (v: string) => (v ? new Date(v).toISOString() : null);

// มอบหมายชุดโจทย์ให้ห้อง (หรือสร้างบริษัทสาธิต) แล้วเปิดบริษัทให้ทันที
export function AssignForm({ setId, defaultCompany, classrooms }: { setId: string; defaultCompany: string; classrooms: { id: string; name: string }[] }) {
  const router = useRouter();
  const [mode, setMode] = useState<AssignmentMode>('submit');
  const [classroomId, setClassroomId] = useState(classrooms[0]?.id ?? '');
  const [companyName, setCompanyName] = useState(defaultCompany);
  const [feedback, setFeedback] = useState<Feedback>('items');
  const [reveal, setReveal] = useState<Reveal>('after_submit');
  const [checkDate, setCheckDate] = useState(true);
  const [duration, setDuration] = useState('50');
  const [opensAt, setOpensAt] = useState('');
  const [closesAt, setClosesAt] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const demo = mode === 'demo';
  const exam = mode === 'exam';
  const reveals: Reveal[] = mode === 'practice' ? ['anytime', 'after_release'] : ['anytime', 'after_submit', 'after_release'];

  function pickMode(m: AssignmentMode) {
    setMode(m);
    if (m === 'practice' && reveal === 'after_submit') setReveal('anytime');
    if (m === 'exam') setReveal('after_release');
  }

  async function submit() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await postJson<{ assignmentId: string; companies: number; companyId: string | null }>(`/teacher/exercises/${setId}/assign`, {
        mode, classroomId: demo ? null : classroomId, companyName, feedback, reveal: exam ? 'after_release' : reveal, checkDate,
        ...(exam ? { durationMinutes: Number(duration) } : {}),
        ...(demo ? {} : { opensAt: toIso(opensAt), closesAt: toIso(closesAt) }),
      });
      if (demo && r.companyId) { router.push(`/c/${r.companyId}/work`); return; }
      setMsg({ ok: true, text: a.created(r.companies) });
      router.push(`/teacher/assignments/${r.assignmentId}`);
    } catch (e) {
      setMsg({ ok: false, text: (e as ApiError).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="flex flex-col gap-3 border border-rule-strong bg-paper p-4" aria-label={a.title}
      onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <h2 className="text-[17px] font-semibold">{a.title}</h2>
      <fieldset className="flex flex-col gap-1">
        <legend className="text-sm">{a.mode}</legend>
        <div className="grid grid-cols-2 sm:grid-cols-4">
          {(['practice', 'submit', 'exam', 'demo'] as const).map((m) => (
            <label key={m} className={`flex min-h-11 cursor-pointer items-center justify-center border border-rule-strong px-2 text-[15px] has-[:checked]:bg-ink has-[:checked]:text-paper has-[:focus-visible]:outline-2`}>
              <input type="radio" name="mode" value={m} checked={mode === m} onChange={() => pickMode(m)} className="sr-only text-base" />
              {a.modes[m]}
            </label>
          ))}
        </div>
        <p className="text-[13px] text-ink2">{a.modeNote[mode]}</p>
      </fieldset>

      <div className="grid gap-3 sm:grid-cols-2">
        {!demo && (
          classrooms.length === 0 ? <p className="text-sm text-ink2">{a.noClassrooms}</p> : (
            <label className="flex flex-col gap-1 text-sm">{a.classroom}
              <select className={field} value={classroomId} onChange={(e) => setClassroomId(e.target.value)}>
                {classrooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </label>
          )
        )}
        <label className="flex flex-col gap-1 text-sm">{a.companyName}
          <input className={field} required maxLength={120} value={companyName} onChange={(e) => setCompanyName(e.target.value)} />
        </label>
        {!demo && (
          <>
            <label className="flex flex-col gap-1 text-sm">{a.feedback}
              <select className={field} value={feedback} onChange={(e) => setFeedback(e.target.value as Feedback)}>
                {(['none', 'score', 'items', 'answers'] as const).map((f) => <option key={f} value={f}>{a.feedbacks[f]}</option>)}
              </select>
            </label>
            {exam ? <p className="self-end text-[13px] text-ink2">{a.examReveal}</p> : (
              <label className="flex flex-col gap-1 text-sm">{a.reveal}
                <select className={field} value={reveal} onChange={(e) => setReveal(e.target.value as Reveal)}>
                  {reveals.map((r) => <option key={r} value={r}>{a.reveals[r]}</option>)}
                </select>
              </label>
            )}
            {exam && (
              <label className="flex flex-col gap-1 text-sm">{a.duration}
                <input className={`${field} font-num`} inputMode="numeric" required pattern="[0-9]{1,3}" value={duration} onChange={(e) => setDuration(e.target.value)} />
              </label>
            )}
            <label className="flex flex-col gap-1 text-sm">{a.opensAt}
              <input type="datetime-local" className={field} value={opensAt} onChange={(e) => setOpensAt(e.target.value)} />
            </label>
            <label className="flex flex-col gap-1 text-sm">{a.closesAt}
              <input type="datetime-local" className={field} value={closesAt} onChange={(e) => setClosesAt(e.target.value)} />
            </label>
            <label className="flex min-h-11 items-center gap-3 text-[15px]">
              <input type="checkbox" className="size-5 text-base accent-ink" checked={checkDate} onChange={(e) => setCheckDate(e.target.checked)} />
              {a.checkDate}
            </label>
          </>
        )}
      </div>
      <button type="submit" disabled={busy || (!demo && !classroomId)}
        className="min-h-11 self-start rounded-doc bg-ink px-4 font-medium text-paper disabled:bg-disabled disabled:text-ink2 max-sm:min-h-13 max-sm:self-stretch">
        {demo ? a.demoSubmit : a.submit}
      </button>
      {msg && <p role={msg.ok ? 'status' : 'alert'} className={`text-sm ${msg.ok ? '' : 'neg'}`}>{msg.text}</p>}
    </form>
  );
}
