import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AssignForm } from '@/components/exercises/AssignForm';
import { DeleteSet } from '@/components/exercises/DeleteSet';
import { ExerciseEditor } from '@/components/exercises/ExerciseEditor';
import { serverApi } from '@/lib/server-api';
import type { Account, ApiError, ExerciseSetDetail } from '@/lib/api';
import { th } from '@/i18n/th';

const when = (iso: string) => new Date(iso).toLocaleDateString('th-TH', { dateStyle: 'medium', timeZone: 'Asia/Bangkok' });

export default async function ExerciseSetPage({ params }: { params: Promise<{ setId: string }> }) {
  const { setId } = await params;
  const [set, accounts] = await Promise.all([
    serverApi<ExerciseSetDetail>(`/teacher/exercises/${setId}`).catch((e: ApiError) => {
      if ([400, 404].includes(e.status)) notFound();
      throw e;
    }),
    serverApi<Account[]>('/teacher/coa-template'),
  ]);
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-5">
      <div className="border-b-2 border-ink pb-2.5">
        <Link href="/teacher/exercises" className="flex min-h-11 items-center text-sm underline">‹ {th.exercises.back}</Link>
        <h1 className="font-doc text-[22px] font-bold sm:text-2xl">{set.title}</h1>
        <p className="text-sm text-ink2">{set.companyName}</p>
      </div>
      <AssignForm setId={set.id} defaultCompany={set.companyName} classrooms={set.classrooms} />
      {set.assignments.length > 0 && (
        <section aria-label={th.exercises.assignments} className="flex flex-col gap-2">
          <h2 className="text-[17px] font-semibold">{th.exercises.assignments}</h2>
          <ul className="border-t border-rule-strong bg-paper">
            {set.assignments.map((a) => (
              <li key={a.id} className="border-b border-rule">
                <Link href={a.mode === 'demo' && a.demoCompanyId ? `/c/${a.demoCompanyId}/work` : `/teacher/assignments/${a.id}`}
                  className="grid min-h-12 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 px-4 py-2">
                  <span>{th.assign.modes[a.mode]} · {a.classroom ?? th.demo.title}</span>
                  <span className="font-num text-sm text-ink2">{when(a.createdAt)}</span>
                  <span className="text-[13px] text-ink2">{a.companyName}{a.closedAt ? ` · ${th.assignment.closed}` : ''}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      <h2 className="text-[17px] font-semibold">{th.exercises.edit}</h2>
      <ExerciseEditor set={set} accounts={accounts} />
      {set.assignments.length === 0 && <DeleteSet setId={set.id} />}
    </div>
  );
}
