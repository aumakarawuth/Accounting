import Link from 'next/link';
import type { Company, EntryRow, Submission } from '@/lib/api';
import { SubmissionPanel } from '@/components/SubmissionPanel';
import { serverApi } from '@/lib/server-api';
import { isoToThai, monthLabel, todayIso } from '@/lib/date';
import { Money } from '@/components/Money';
import { th } from '@/i18n/th';

export default async function CompanyHome({ params }: { params: Promise<{ companyId: string }> }) {
  const { companyId } = await params;
  const month = todayIso().slice(0, 7);
  const [company, entries] = await Promise.all([
    serverApi<Company>(`/companies/${companyId}`),
    serverApi<EntryRow[]>(`/companies/${companyId}/journal?month=${month}`),
  ]);
  const sub = company.mode === 'submit' ? await serverApi<Submission>(`/companies/${companyId}/submission`) : null;

  return (
    <div className="flex flex-col gap-5 p-4 sm:p-6">
      <div className="flex items-end gap-3 border-b-2 border-ink pb-2.5">
        <div>
          <h1 className="font-doc text-[22px] font-bold sm:text-2xl">{th.journal.heading(company.name, monthLabel(month))}</h1>
          <p className="text-[15px] text-ink2">{th.journal.entriesCount(entries.length)}</p>
        </div>
        <Link href={`/c/${companyId}/journal/new`} className="ml-auto inline-flex min-h-11 items-center gap-3.5 rounded-doc bg-ink px-4 font-medium text-paper max-sm:hidden">
          {th.keys.newJournal}
        </Link>
      </div>
      {sub && <SubmissionPanel companyId={companyId} sub={sub} viewer="student" />}
      <section className="flex flex-col gap-2">
        <h2 className="text-[17px] font-semibold">{th.journal.recent}</h2>
        {entries.length === 0 ? (
          <p className="text-ink2">{th.journal.empty}</p>
        ) : (
          <table className="w-full border-collapse bg-paper text-[15px]">
            <thead>
              <tr className="bg-band text-left text-sm">
                <th className="h-10 border border-rule px-2.5 font-medium">{th.invoice.docNo}</th>
                <th className="h-10 border border-rule px-2.5 font-medium max-sm:hidden">{th.journal.date}</th>
                <th className="h-10 border border-rule px-2.5 font-medium">{th.journal.description}</th>
                <th className="h-10 border border-rule px-2.5 text-right font-medium">{th.invoice.amount}</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id}>
                  <td className={`h-11 border border-rule px-2.5 font-num ${e.reverses_doc_no ? 'neg' : ''}`}>{e.doc_no}</td>
                  <td className="h-11 border border-rule px-2.5 font-num max-sm:hidden">{isoToThai(e.date)}</td>
                  <td className="h-11 border border-rule px-2.5">{e.reverses_doc_no ? th.journal.reversalOf(e.reverses_doc_no) : e.description}</td>
                  <td className="h-11 border border-rule px-2.5 text-right">
                    <Money value={e.reverses_doc_no ? `-${e.total}` : e.total} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
