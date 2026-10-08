import Link from 'next/link';
import { notFound } from 'next/navigation';
import { EntryDocument } from '@/components/EntryDocument';
import { serverApi } from '@/lib/server-api';
import type { ApiError, JournalEntry } from '@/lib/api';
import { th } from '@/i18n/th';

// ครูตรวจรายการทีละใบ: อ่านอย่างเดียว + ติดคอมเมนต์ปากกาแดง (การเปิดดูถูกบันทึกที่ API)
export default async function TeacherEntryPage({ params }: { params: Promise<{ companyId: string; entryId: string }> }) {
  const { companyId, entryId } = await params;
  let entry: JournalEntry;
  try {
    entry = await serverApi<JournalEntry>(`/companies/${companyId}/journal/${entryId}`);
  } catch (e) {
    if ([400, 404].includes((e as ApiError).status)) notFound();
    throw e;
  }
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4">
      <Link href={`/teacher/review/${companyId}`} className="flex min-h-11 items-center self-start text-sm underline">‹ {th.teacher.review.back}</Link>
      <EntryDocument companyId={companyId} entry={entry} viewer="teacher" entryBase={`/teacher/review/${companyId}/entry/`} />
    </div>
  );
}
