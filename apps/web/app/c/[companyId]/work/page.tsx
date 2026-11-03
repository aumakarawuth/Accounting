import Link from 'next/link';
import type { Company, EntryRow, Submission } from '@/lib/api';
import { SubmissionPanel } from '@/components/SubmissionPanel';
import { serverApi } from '@/lib/server-api';
import { isoToThai } from '@/lib/date';
import { th } from '@/i18n/th';

// งานของฉัน: สถานะการส่งงาน (โหมดส่งงาน) และรายการที่ครูคอมเมนต์ไว้ (200 รายการล่าสุด)
export default async function WorkPage({ params }: { params: Promise<{ companyId: string }> }) {
  const { companyId } = await params;
  const [company, entries] = await Promise.all([
    serverApi<Company>(`/companies/${companyId}`),
    serverApi<EntryRow[]>(`/companies/${companyId}/journal`),
  ]);
  const sub = company.mode === 'submit' ? await serverApi<Submission>(`/companies/${companyId}/submission`) : null;
  const commented = entries.filter((e) => e.comments > 0);
  return (
    <div className="flex flex-col gap-5 p-4 sm:p-6">
      <h1 className="border-b-2 border-ink pb-2.5 font-doc text-[22px] font-bold sm:text-2xl">{th.workPage.title} · {company.name}</h1>
      {sub ? <SubmissionPanel companyId={companyId} sub={sub} viewer="student" /> : <p className="border border-rule-strong bg-paper p-4">{th.workPage.practice}</p>}
      <section aria-label={th.workPage.commented} className="flex flex-col gap-2">
        <h2 className="text-[17px] font-semibold">{th.workPage.commented}</h2>
        {commented.length === 0 ? (
          <p className="text-ink2">{th.workPage.noComments}</p>
        ) : (
          <ul className="border-t border-rule-strong bg-paper">
            {commented.map((e) => (
              <li key={e.id} className="border-b border-rule">
                <Link href={`/c/${companyId}/journal/${e.id}`} className="grid min-h-14 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 px-4 py-2">
                  <span className="truncate">{e.reverses_doc_no ? th.journal.reversalOf(e.reverses_doc_no) : e.description}</span>
                  <span className="neg text-[13px] italic">{th.comment.count(e.comments)}</span>
                  <span className="font-num text-[13px] text-ink2">{e.doc_no} · {isoToThai(e.date)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
