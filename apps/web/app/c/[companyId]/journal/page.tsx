import Link from 'next/link';
import { MonthNav } from '@/components/MonthNav';
import { Money } from '@/components/Money';
import { serverApi } from '@/lib/server-api';
import type { Company, EntryRow } from '@/lib/api';
import { isMonth, isoToThai, monthLabel, todayIso } from '@/lib/date';
import { th } from '@/i18n/th';

// สมุดรายวันรายเดือน: แตะรายการเพื่อดูบรรทัดและกลับรายการ
export default async function JournalList({
  params, searchParams,
}: { params: Promise<{ companyId: string }>; searchParams: Promise<{ month?: string }> }) {
  const { companyId } = await params;
  const sp = await searchParams;
  const month = isMonth(sp.month) ? sp.month : todayIso().slice(0, 7);
  const [company, entries] = await Promise.all([
    serverApi<Company>(`/companies/${companyId}`),
    serverApi<EntryRow[]>(`/companies/${companyId}/journal?month=${month}`),
  ]);
  const href = (id: string) => `/c/${companyId}/journal/${id}`;
  const rows = [...entries].reverse(); // เรียงตามวันที่และเลขที่ เหมือนสมุดจริง
  const cell = 'h-11 border border-rule px-2.5';
  const canPost = company.can_write && !company.locked;

  return (
    <div className="flex min-h-full flex-col gap-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-end gap-3 border-b-2 border-ink pb-2.5">
        <div className="min-w-0">
          <h1 className="font-doc text-[20px] font-bold sm:text-2xl">{th.journal.listHeading(company.name, monthLabel(month))}</h1>
          <p className="text-sm text-ink2">{th.journal.entriesCount(entries.length)}</p>
        </div>
        <div className="flex flex-wrap items-center gap-3 sm:ml-auto">
          <MonthNav month={month} href={(m) => `/c/${companyId}/journal?month=${m}`} />
          {canPost && (
            <Link href={`/c/${companyId}/journal/new`} className="inline-flex min-h-11 items-center rounded-doc bg-ink px-4 font-medium text-paper max-sm:hidden">
              {th.keys.newJournal}
            </Link>
          )}
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="text-ink2">{th.journal.empty}</p>
      ) : (
        <>
          <table className="w-full border-collapse bg-paper text-[15px] max-sm:hidden">
            <thead className="bg-band text-left text-sm">
              <tr>
                <th className={`${cell} w-28 font-medium`}>{th.journal.date}</th>
                <th className={`${cell} w-28 font-medium`}>{th.invoice.docNo}</th>
                <th className={`${cell} font-medium`}>{th.journal.description}</th>
                <th className={`${cell} w-40 text-right font-medium`}>{th.invoice.amount}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id}>
                  <td className={`${cell} font-num`}>{isoToThai(e.date)}</td>
                  <td className={`${cell} font-num`}>
                    <Link href={href(e.id)} aria-label={th.journal.open(e.doc_no)} className={`underline decoration-rule-input ${e.reverses_doc_no ? 'neg' : ''}`}>{e.doc_no}</Link>
                  </td>
                  <td className={cell}>{e.reverses_doc_no ? th.journal.reversalOf(e.reverses_doc_no) : e.description}</td>
                  <td className={`${cell} text-right`}><Money value={e.reverses_doc_no ? `-${e.total}` : e.total} /></td>
                </tr>
              ))}
            </tbody>
          </table>

          <ul className="border-t border-rule-strong bg-paper sm:hidden">
            {rows.map((e) => (
              <li key={e.id} className="border-b border-rule">
                <Link href={href(e.id)} aria-label={th.journal.open(e.doc_no)} className="grid min-h-14 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 px-4 py-2">
                  <span className="truncate">{e.reverses_doc_no ? th.journal.reversalOf(e.reverses_doc_no) : e.description || '—'}</span>
                  <Money value={e.reverses_doc_no ? `-${e.total}` : e.total} />
                  <span className={`font-num text-[13px] ${e.reverses_doc_no ? 'neg' : 'text-ink2'}`}>{e.doc_no}</span>
                  <span className="text-right font-num text-[13px] text-ink2">{isoToThai(e.date)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}

      {canPost && (
        <div className="sticky bottom-0 -mx-4 -mb-4 mt-auto border-t border-rule-strong bg-paper px-4 py-2.5 sm:hidden">
          <Link href={`/c/${companyId}/journal/new`} className="flex min-h-13 items-center justify-center rounded-doc bg-ink font-medium text-paper">
            {th.keys.newJournal}
          </Link>
        </div>
      )}
    </div>
  );
}
