import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Money } from '@/components/Money';
import { ReverseEntry } from '@/components/ReverseEntry';
import { serverApi } from '@/lib/server-api';
import type { ApiError, Company, JournalEntry } from '@/lib/api';
import { isoToThai } from '@/lib/date';
import { formatMoney } from '@/lib/money';
import { th } from '@/i18n/th';

const when = (iso: string) =>
  new Date(iso).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok' });

// ใบสำคัญทั่วไปหนึ่งใบ: อ่านอย่างเดียว แก้ด้วยการกลับรายการเท่านั้น
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
  const c = (p: string) => `/c/${companyId}${p}`;
  const rv = entry.reverses !== null;
  const cell = 'border border-rule px-2.5 py-2';
  const amount = (v: string) => (v === '0.00' ? '' : formatMoney(v));
  const totalDr = entry.total;
  // แสดงแบบสมุดรายวัน: เดบิตก่อน เครดิตย่อหน้าตามหลัง (รายการกลับรายการเก็บลำดับบรรทัดตามรายการเดิม)
  const lines = [...entry.lines].sort((a, b) => Number(a.debit === '0.00') - Number(b.debit === '0.00') || a.lineNo - b.lineNo);

  return (
    <div className="flex flex-col gap-4 p-4 sm:p-6">
      <Link href={`${c('/journal')}?month=${entry.date.slice(0, 7)}`} className="flex min-h-11 items-center self-start text-sm underline">
        ‹ {th.journal.backToList}
      </Link>

      <article className="flex flex-col gap-4 border border-rule-strong bg-paper p-4 sm:p-6">
        <header className="flex flex-wrap items-start justify-between gap-2 border-b-2 border-ink pb-2.5">
          <div>
            <h1 className="font-doc text-[19px] font-bold sm:text-2xl">{th.journal.title}</h1>
            <p className="text-sm text-ink2">{th.journal.postedAt(when(entry.postedAt))}</p>
          </div>
          <dl className="grid grid-cols-[auto_auto] gap-x-3 text-[15px] sm:text-right">
            <dt className="text-ink2">{th.invoice.docNo}</dt>
            <dd className={`font-num font-semibold ${rv ? 'neg' : ''}`}>{entry.docNo}</dd>
            <dt className="text-ink2">{th.journal.date}</dt>
            <dd className="font-num">{isoToThai(entry.date)}</dd>
          </dl>
        </header>

        {entry.description && <p>{entry.description}</p>}
        {entry.reverses && (
          <p className="text-sm">
            {th.journal.reverses} <Link href={c(`/journal/${entry.reverses.id}`)} className="font-num underline">{entry.reverses.docNo}</Link>
          </p>
        )}
        {entry.reversedBy && (
          <p className="text-sm">
            {th.journal.reversedBy} <Link href={c(`/journal/${entry.reversedBy.id}`)} className="neg font-num underline">{entry.reversedBy.docNo}</Link>
          </p>
        )}

        {/* iPad/คอม: ตารางแบบสมุด เครดิตย่อหน้า */}
        <table className="w-full border-collapse text-[15px] max-sm:hidden">
          <thead className="bg-band text-left text-sm">
            <tr>
              <th className={`${cell} w-24 font-medium`}>{th.journal.accountCode}</th>
              <th className={`${cell} font-medium`}>{th.journal.accountName}</th>
              <th className={`${cell} font-medium`}>{th.journal.lineMemo}</th>
              <th className={`${cell} w-36 text-right font-medium`}>{th.money.debit}</th>
              <th className={`${cell} w-36 text-right font-medium`}>{th.money.credit}</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.lineNo}>
                <td className={`${cell} font-num`}>{l.code}</td>
                <td className={`${cell} ${l.credit !== '0.00' ? 'pl-7' : ''}`}>{l.name}</td>
                <td className={`${cell} text-ink2`}>{l.memo}</td>
                <td className={`${cell} num`}>{amount(l.debit)}</td>
                <td className={`${cell} num`}>{amount(l.credit)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot className="font-medium">
            <tr>
              <td colSpan={3} className={`${cell} border-t-2 border-t-ink text-right`}>{th.money.total}</td>
              <td className={`${cell} num border-t-2 border-b-[3px] border-t-ink border-b-ink border-double`}>{formatMoney(totalDr)}</td>
              <td className={`${cell} num border-t-2 border-b-[3px] border-t-ink border-b-ink border-double`}>{formatMoney(totalDr)}</td>
            </tr>
          </tfoot>
        </table>

        {/* มือถือ: รายการบรรทัด */}
        <ul className="border-t border-rule-strong sm:hidden">
          {lines.map((l) => (
            <li key={l.lineNo} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 border-b border-rule py-2">
              <span className={l.credit !== '0.00' ? 'pl-5' : ''}>{l.name}</span>
              <Money value={l.debit !== '0.00' ? l.debit : l.credit} />
              <span className={`font-num text-[13px] text-ink2 ${l.credit !== '0.00' ? 'pl-5' : ''}`}>{l.code}{l.memo ? ` · ${l.memo}` : ''}</span>
              <span className="text-right text-[13px] text-ink2">{l.debit !== '0.00' ? th.money.debit : th.money.credit}</span>
            </li>
          ))}
          <li className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 py-2 font-medium">
            <span>{th.money.debit}</span><span className="num">{formatMoney(totalDr)}</span>
            <span>{th.money.credit}</span><span className="num">{formatMoney(totalDr)}</span>
          </li>
        </ul>
        <p className="text-[15px]">{th.money.difference} 0.00 · {th.money.balanced}</p>
      </article>

      {company.can_write && (
        rv ? <p className="text-sm text-ink2">{th.journal.isReversal}</p>
          : entry.reversedBy ? null
          : <ReverseEntry companyId={companyId} entry={{ id: entry.id, docNo: entry.docNo, date: entry.date, periodClosed: entry.periodClosed }} locked={company.locked} />
      )}
    </div>
  );
}
