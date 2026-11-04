import Link from 'next/link';
import { DemoCreate } from '@/components/exercises/DemoCreate';
import { serverApi } from '@/lib/server-api';
import type { AssignmentSummary, ExerciseSetSummary } from '@/lib/api';
import { th } from '@/i18n/th';

// สาธิตหน้าห้อง: บริษัทของครูเอง (ไม่ผูกห้อง) ตัวอักษรใหญ่ เห็นเฉลยของชุดโจทย์ที่เลือก
export default async function DemoPage() {
  const { sets, assignments } = await serverApi<{ sets: ExerciseSetSummary[]; assignments: AssignmentSummary[] }>('/teacher/exercises');
  const demos = assignments.filter((a) => a.mode === 'demo' && a.demoCompanyId);
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-5">
      <div className="border-b-2 border-ink pb-2.5">
        <h1 className="font-doc text-[22px] font-bold sm:text-2xl">{th.demo.title}</h1>
        <p className="text-sm text-ink2">{th.demo.note}</p>
      </div>
      <DemoCreate sets={sets.map((s) => ({ id: s.id, title: s.title, companyName: s.companyName }))} />
      <section aria-label={th.demo.list} className="flex flex-col gap-2">
        <h2 className="text-[17px] font-semibold">{th.demo.list}</h2>
        {demos.length === 0 ? <p className="text-ink2">{th.demo.none}</p> : (
          <ul className="border-t border-rule-strong bg-paper">
            {demos.map((d) => (
              <li key={d.id} className="border-b border-rule">
                <Link href={`/c/${d.demoCompanyId}/work`} className="flex min-h-14 flex-col justify-center px-4 py-2">
                  <span className="font-medium">{d.companyName}</span>
                  <span className="text-[13px] text-ink2">{d.title}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
