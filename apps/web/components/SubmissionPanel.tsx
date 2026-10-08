'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { postJson, type ApiError, type Submission } from '@/lib/api';
import { th } from '@/i18n/th';

const when = (iso: string) =>
  new Date(iso).toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Bangkok' });

// วงจรงาน: นักเรียนส่งตรวจ (กดสองจังหวะ), ครูเริ่มตรวจ/ส่งกลับ/ให้ผ่าน/ปิด
// ส่ง expected = สถานะที่เห็นอยู่ ถ้าอีกฝั่งเปลี่ยนไปก่อน DB ตอบ 409 แล้วโหลดใหม่
export function SubmissionPanel({ companyId, sub, viewer }: { companyId: string; sub: Submission; viewer: 'student' | 'teacher' }) {
  const router = useRouter();
  const [confirm, setConfirm] = useState(false);
  const [note, setNote] = useState('');
  const [score, setScore] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const status = sub.status ?? 'draft';

  async function act(action: string, extra: object = {}) {
    setBusy(true);
    setError(null);
    try {
      await postJson(`/companies/${companyId}/submission`, { action, expected: status, ...extra });
      setConfirm(false); setNote(''); setScore('');
      router.refresh();
    } catch (e) {
      const err = e as ApiError;
      setError(err.message);
      if (err.code === '40001') router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const btn = 'min-h-11 rounded-doc px-4 font-medium disabled:bg-disabled disabled:text-ink2';
  const primary = `${btn} bg-ink text-paper`;
  const secondary = `${btn} border border-ink`;
  const lastReturn = [...sub.events].reverse().find((e) => e.action === 'return');
  const actor = (e: Submission['events'][number]) => e.actorName ?? (e.byOwner ? th.submission.student : th.submission.teacher);

  return (
    <section className="flex flex-col gap-3 border border-rule-strong bg-paper p-4" aria-label={th.submission.title}>
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h2 className="text-[17px] font-semibold">{th.submission.title}</h2>
        <span className={status === 'returned' ? 'neg font-semibold' : 'font-semibold'}>{th.work.state[status]}</span>
        {sub.round > 0 && <span className="text-sm text-ink2">{th.submission.round(sub.round)}</span>}
        {sub.score !== null && <span className="text-sm">{th.submission.score(sub.score, sub.maxScore)}</span>}
      </div>

      {viewer === 'student' && ['submitted', 'reviewing', 'passed', 'closed'].includes(status) && (
        <p className="text-sm text-ink2">{th.submission.lockedNote}</p>
      )}
      {viewer === 'student' && status === 'returned' && lastReturn?.note && (
        <div className="flex flex-col gap-1">
          <p className="text-sm">{th.submission.returnedNote}</p>
          <p className="neg italic">{lastReturn.note} · {actor(lastReturn)}</p>
        </div>
      )}

      {viewer === 'student' && (status === 'draft' || status === 'returned') && (
        <div>
          <button type="button" disabled={busy} className={confirm ? primary : secondary}
            onClick={() => (confirm ? act('submit') : setConfirm(true))}>
            {confirm ? th.submission.confirmSubmit : th.work.submit}
          </button>
        </div>
      )}

      {viewer === 'teacher' && (
        <div className="flex flex-col gap-3">
          {status === 'submitted' && (
            <div><button type="button" disabled={busy} className={secondary} onClick={() => act('review')}>{th.submission.actions.review}</button></div>
          )}
          {(status === 'submitted' || status === 'reviewing') && (
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_200px]">
              <label className="flex flex-col gap-1 text-sm">{th.submission.noteLabel}
                <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3}
                  className="rounded-doc border border-rule-input bg-paper p-2 text-base" />
              </label>
              <label className="flex flex-col gap-1 text-sm">{th.submission.scoreLabel(sub.maxScore)}
                <input value={score} onChange={(e) => setScore(e.target.value)} inputMode="decimal"
                  className="num h-11 rounded-doc border border-rule-input bg-paper px-3 text-base" />
              </label>
              <div className="flex flex-wrap gap-3 sm:col-span-2">
                <button type="button" disabled={busy || !note.trim()} className={secondary} onClick={() => act('return', { note })}>
                  {th.submission.actions.return}
                </button>
                <button type="button" disabled={busy || !score.trim()} className={primary}
                  onClick={() => act('pass', { score: score.trim(), ...(note.trim() ? { note } : {}) })}>
                  {th.submission.actions.pass}
                </button>
              </div>
            </div>
          )}
          {(status === 'passed' || status === 'returned') && (
            <div><button type="button" disabled={busy} className={secondary} onClick={() => act('close')}>{th.submission.actions.close}</button></div>
          )}
        </div>
      )}

      {error && <p role="alert" className="neg text-sm">{error}</p>}

      {sub.events.length > 0 && (
        <details open={viewer === 'teacher'}>
          <summary className="min-h-11 cursor-pointer py-2 text-sm font-medium">{th.submission.history}</summary>
          <ol className="border-t border-rule text-sm">
            {sub.events.map((e) => (
              <li key={e.id} className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 border-b border-rule-faint py-1.5">
                <span className="font-num text-ink2">{when(e.at)}</span>
                <span>
                  {th.submission.actions[e.action] ?? e.action} → {th.work.state[e.to as keyof typeof th.work.state] ?? e.to}
                  {' · '}{th.submission.by(actor(e))}
                  {e.score && ` · ${th.submission.score(e.score, sub.maxScore)}`}
                  {e.note && <span className={`block italic ${e.action === 'return' ? 'neg' : ''}`}>{e.note}</span>}
                </span>
              </li>
            ))}
          </ol>
        </details>
      )}
    </section>
  );
}
