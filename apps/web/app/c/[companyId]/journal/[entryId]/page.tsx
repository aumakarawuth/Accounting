import Link from 'next/link';
import { notFound } from 'next/navigation';
import { EntryDocument } from '@/components/EntryDocument';
import { ReverseEntry } from '@/components/ReverseEntry';
import { serverApi } from '@/lib/server-api';
import type { ApiError, Company, JournalEntry } from '@/lib/api';
import { th } from '@/i18n/th';

// ใบสำคัญทั่วไปหนึ่งใบ: อ่านอย่างเดียว แก้ด้วยการกลับรายการเท่านั้น คอมเมนต์ครูอยู่ที่ขอบสมุด
export default async function EntryPage({ params }: { params: Promise<{ companyId: string; entryId: string }> }) {
  const { companyId, entryId } = await params;
  let entry: JournalEntry;
  try {
    entry = await serverApi<JournalEntry>(`/companies/${companyId}/journal/${entryId}`);
  } catch (e) {
    if ([400, 404].includes((e as ApiError).status)) notFound();
    throw e;
  }
  const company = await serverApi<Company>(`/companies/${companyId}`);
  const base = `/c/${companyId}/journal/`;

  return (
    <div className="flex flex-col gap-4 p-4 sm:p-6">
      <Link href={`/c/${companyId}/journal?month=${entry.date.slice(0, 7)}`} className="flex min-h-11 items-center self-start text-sm underline">
        ‹ {th.journal.backToList}
      </Link>
      <EntryDocument companyId={companyId} entry={entry} viewer="student" entryBase={base} />
      {company.can_write && (
        entry.reverses ? <p className="text-sm text-ink2">{th.journal.isReversal}</p>
          : entry.reversedBy ? null
          : <ReverseEntry companyId={companyId} entry={{ id: entry.id, docNo: entry.docNo, date: entry.date, periodClosed: entry.periodClosed }} locked={company.locked} />
      )}
    </div>
  );
}
