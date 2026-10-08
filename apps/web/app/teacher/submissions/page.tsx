import Link from 'next/link';
import { serverApi } from '@/lib/server-api';
import type { TeacherSubmission } from '@/lib/api';
import { th } from '@/i18n/th';

const when = (iso: string) =>
  new Date(iso).toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Bangkok' });

// งานที่ส่ง: เรียงงานที่รอตรวจก่อน (API เรียงให้)
export default async function SubmissionsPage() {
  const list = await serverApi<TeacherSubmission[]>('/teacher/submissions');
  const cell = 'border border-rule px-3 py-2';
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4">
      <h1 className="border-b-2 border-ink pb-2.5 font-doc text-[22px] font-bold sm:text-2xl">{th.submission.list}</h1>
      {list.length === 0 ? (
        <p className="text-ink2">{th.submission.noSubmissions}</p>
      ) : (
        <>
          <table className="w-full border-collapse bg-paper text-[15px] max-sm:hidden">
            <thead className="bg-band text-left text-sm">
              <tr>
                <th className={`${cell} font-medium`}>{th.slips.studentCode}</th>
                <th className={`${cell} font-medium`}>{th.slips.name}</th>
                <th className={`${cell} font-medium`}>{th.company.name}</th>
                <th className={`${cell} font-medium`}>{th.work.status}</th>
                <th className={`${cell} font-medium`}>{th.submission.updated}</th>
                <th className={cell} />
              </tr>
            </thead>
            <tbody>
              {list.map((s) => (
                <tr key={s.companyId}>
                  <td className={`${cell} font-num`}>{s.studentCode}</td>
                  <td className={cell}>{s.studentName}</td>
                  <td className={cell}>{s.company}<span className="block text-[13px] text-ink2">{th.company.classroom(s.classroom)}</span></td>
                  <td className={`${cell} ${s.status === 'submitted' ? 'font-semibold' : ''}`}>
                    {th.work.state[s.status]}{s.round > 0 && <span className="block text-[13px] text-ink2">{th.submission.round(s.round)}</span>}
                    {s.score && <span className="block text-[13px]">{th.submission.score(s.score, s.maxScore)}</span>}
                  </td>
                  <td className={`${cell} font-num text-sm`}>{when(s.updatedAt)}</td>
                  <td className={cell}>
                    <Link href={`/teacher/review/${s.companyId}`} className="flex min-h-11 items-center justify-center rounded-doc border border-ink px-3 text-sm">{th.submission.open}</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <ul className="border-t border-rule-strong bg-paper sm:hidden">
            {list.map((s) => (
              <li key={s.companyId}>
                <Link href={`/teacher/review/${s.companyId}`} className="grid min-h-14 grid-cols-[minmax(0,1fr)_auto] gap-x-3 border-b border-rule px-4 py-2">
                  <span><span className="font-num">{s.studentCode}</span> {s.studentName}</span>
                  <span className={s.status === 'submitted' ? 'font-semibold' : ''}>{th.work.state[s.status]}</span>
                  <span className="text-[13px] text-ink2">{s.company}</span>
                  <span className="text-right text-[13px] text-ink2">{s.round > 0 ? th.submission.round(s.round) : ''}</span>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
