import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AssignmentActions, ExtendOne } from '@/components/exercises/AssignmentActions';
import { ExportLinks } from '@/components/ExportLinks';
import { serverApi } from '@/lib/server-api';
import type { ApiError, AssignmentOverview, OverviewStudent } from '@/lib/api';
import { th } from '@/i18n/th';

const a = th.assignment;
const time = (iso: string) => new Date(iso).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bangkok' });
const when = (iso: string) => new Date(iso).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok' });

function status(s: OverviewStudent, exam: boolean) {
  if (!s.companyId) return a.noCompany;
  if (s.lockReason) return a.lock[s.lockReason];
  if (exam) return s.deadline ? a.exam.running(time(s.deadline)) : a.exam.notStarted;
  return s.status ? th.work.state[s.status] : '';
}

// ภาพรวมงาน: คะแนนตรวจอัตโนมัติรายคน/รายข้อ (คิดจากรายการล่าสุดทุกครั้งที่เปิด) + ปุ่มควบคุมงาน/สอบ + ส่งออกคะแนน
export default async function AssignmentPage({ params }: { params: Promise<{ assignmentId: string }> }) {
  const { assignmentId } = await params;
  const ov = await serverApi<AssignmentOverview>(`/teacher/assignments/${assignmentId}`).catch((e: ApiError) => {
    if ([400, 404].includes(e.status)) notFound();
    throw e;
  });
  const as = ov.assignment;
  const exam = as.mode === 'exam';
  const cell = 'border border-rule px-2.5 py-2';
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3 border-b-2 border-ink pb-2.5">
        <div className="min-w-0">
          <Link href="/teacher/exercises" className="flex min-h-11 items-center text-sm underline">‹ {a.back}</Link>
          <h1 className="font-doc text-[20px] font-bold sm:text-2xl">{a.heading(as.title, as.classroom ?? '')}</h1>
          <p className="text-sm text-ink2">
            {a.settings(th.assign.modes[as.mode], th.assign.feedbacks[as.feedback], th.assign.reveals[as.reveal])}
            {as.durationMinutes ? ` · ${a.duration(as.durationMinutes)}` : ''}
            {as.opensAt || as.closesAt ? ` · ${a.window(as.opensAt ? when(as.opensAt) : '-', as.closesAt ? when(as.closesAt) : '-')}` : ''}
          </p>
          <p className="text-sm">{as.releasedAt ? a.released : a.notReleased}{as.closedAt ? ` · ${a.closed}` : ''}</p>
        </div>
        <div className="sm:ml-auto"><ExportLinks base={`/export/assignment/${as.id}/scores`} label={a.export} /></div>
      </div>

      <AssignmentActions ov={ov} />

      <section aria-label={a.students} className="flex flex-col gap-2">
        <h2 className="text-[17px] font-semibold">{a.students} · {a.count(ov.students.length)}</h2>
        <div className="overflow-x-auto max-sm:hidden">
          <table className="w-full min-w-[720px] border-collapse bg-paper text-[15px]">
            <thead className="bg-band text-left text-sm">
              <tr>
                <th className={`${cell} font-medium`}>{a.code}</th>
                <th className={`${cell} font-medium`}>{a.name}</th>
                <th className={`${cell} text-right font-medium`}>{a.score}</th>
                <th className={`${cell} font-medium`}>{a.status}</th>
                <th className={`${cell} font-medium`}>{a.items}</th>
                <th className={cell} />
              </tr>
            </thead>
            <tbody>
              {ov.students.map((s) => (
                <tr key={s.studentId}>
                  <td className={`${cell} font-num`}>{s.studentCode}</td>
                  <td className={cell}>{s.name}</td>
                  <td className={`${cell} text-right font-num`}>
                    {s.grade ? `${s.grade.score}/${s.grade.maxScore}` : ''}
                    {s.teacherScore && <span className="block text-[13px] text-ink2">{a.teacherScore} {s.teacherScore}</span>}
                  </td>
                  <td className={cell}>{status(s, exam)}{s.grade && s.grade.extra > 0 ? <span className="block text-[13px] text-ink2">{a.extra} {s.grade.extra}</span> : null}</td>
                  <td className={`${cell} font-num text-sm`}>
                    {s.grade?.items.map((g) => (
                      <span key={g.no} title={`${a.item(g.no)} ${a.itemStatus[g.status]}`} className={`inline-block w-6 text-center ${g.status === 'correct' ? '' : 'font-semibold'}`}>
                        {a.itemShort[g.status]}
                      </span>
                    ))}
                  </td>
                  <td className={cell}>
                    <div className="flex gap-2">
                      {s.companyId && <Link href={`/teacher/review/${s.companyId}`} className="flex min-h-11 items-center justify-center rounded-doc border border-ink px-3 text-sm">{a.review}</Link>}
                      {exam && s.companyId && s.startedAt && !as.closedAt && <ExtendOne assignmentId={as.id} companyId={s.companyId} label={a.extendFor(s.studentCode, 10)} />}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <ul className="border-t border-rule-strong bg-paper sm:hidden">
          {ov.students.map((s) => {
            const body = (
              <>
                <span><span className="font-num">{s.studentCode}</span> {s.name}</span>
                <span className="font-num">{s.grade ? `${s.grade.score}/${s.grade.maxScore}` : ''}</span>
                <span className="text-[13px] text-ink2">{status(s, exam)}</span>
                <span className="text-right font-num text-[13px]">{s.grade?.items.map((g) => a.itemShort[g.status]).join(' ')}</span>
              </>
            );
            const cls = 'grid min-h-14 grid-cols-[minmax(0,1fr)_auto] gap-x-3 px-4 py-2';
            return (
              <li key={s.studentId} className="border-b border-rule">
                {s.companyId ? <Link href={`/teacher/review/${s.companyId}`} className={cls}>{body}</Link> : <div className={cls}>{body}</div>}
              </li>
            );
          })}
        </ul>
        <p className="text-[13px] text-ink2">{a.legend}</p>
      </section>

      <section aria-label={th.exercises.title} className="flex flex-col gap-2">
        <h2 className="text-[17px] font-semibold">{th.exercises.title}</h2>
        <ol className="border-t border-rule-strong bg-paper">
          {ov.items.map((i) => (
            <li key={i.no} className="border-b border-rule px-4 py-2 text-[15px]">
              <span className="font-semibold">{a.item(i.no)}</span> · {i.narrative}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
