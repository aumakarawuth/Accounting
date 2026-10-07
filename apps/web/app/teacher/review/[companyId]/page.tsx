import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Money } from '@/components/Money';
import { SubmissionPanel } from '@/components/SubmissionPanel';
import { StatementsView } from '@/components/reports/StatementsView';
import { serverApi } from '@/lib/server-api';
import type { ApiError, Company, EntryRow, Statements, Submission, TeacherSubmission } from '@/lib/api';
import { isoToThai, todayIso } from '@/lib/date';
import { th } from '@/i18n/th';

// ครูตรวจงาน: อ่านอย่างเดียว ทุกครั้งที่เปิดถูกบันทึก (API /submission บันทึกการเปิดดู)
export default async function ReviewPage({ params }: { params: Promise<{ companyId: string }> }) {
  const { companyId } = await params;
  let company: Company;
  try {
    company = await serverApi<Company>(`/companies/${companyId}`);
  } catch (e) {
    if ([400, 404].includes((e as ApiError).status)) notFound();
    throw e;
  }
  const month = todayIso().slice(0, 7);
  const [sub, entries, st, list] = await Promise.all([
    serverApi<Submission>(`/companies/${companyId}/submission`),
    serverApi<EntryRow[]>(`/companies/${companyId}/journal`),
    serverApi<Statements>(`/companies/${companyId}/statements?month=${month}&scope=ytd`),
    serverApi<TeacherSubmission[]>('/teacher/submissions'),
  ]);
  const me = list.find((s) => s.companyId === companyId);
  const cell = 'border border-rule px-2.5 py-2';
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5">
      <div className="border-b-2 border-ink pb-2.5">
        <Link href="/teacher/submissions" className="flex min-h-11 items-center text-sm underline">‹ {th.submission.list}</Link>
        <h1 className="font-doc text-[20px] font-bold sm:text-2xl">
          {th.submission.reviewTitle(me?.studentCode ?? '', me?.studentName ?? '', company.name)}
        </h1>
        <p className="text-sm text-ink2">{th.submission.viewLogged}</p>
      </div>
      <SubmissionPanel companyId={companyId} sub={sub} viewer="teacher" />
      <StatementsView st={st} company={company.name} />
      <section className="flex flex-col gap-2">
        <h2 className="text-[17px] font-semibold">{th.journal.title}</h2>
        {entries.length === 0 ? <p className="text-ink2">{th.journal.empty}</p> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] border-collapse bg-paper text-[15px]">
              <thead className="bg-band text-left text-sm">
                <tr>
                  <th className={`${cell} font-medium`}>{th.ledger.docNo}</th>
                  <th className={`${cell} font-medium`}>{th.ledger.date}</th>
                  <th className={`${cell} font-medium`}>{th.ledger.description}</th>
                  <th className={`${cell} text-right font-medium`}>{th.invoice.amount}</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.id}>
                    <td className={`${cell} font-num ${e.reverses_doc_no ? 'neg' : ''}`}>{e.doc_no}</td>
                    <td className={`${cell} font-num`}>{isoToThai(e.date)}</td>
                    <td className={cell}>{e.reverses_doc_no ? th.journal.reversalOf(e.reverses_doc_no) : e.description}</td>
                    <td className={`${cell} text-right`}><Money value={e.reverses_doc_no ? `-${e.total}` : e.total} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
