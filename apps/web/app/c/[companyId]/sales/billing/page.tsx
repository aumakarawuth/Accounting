import Link from 'next/link';
import { serverApi } from '@/lib/server-api';
import type { BillingNoteRow, Company } from '@/lib/api';
import { isoToThai } from '@/lib/date';
import { formatMoney } from '@/lib/money';
import { th } from '@/i18n/th';

export default async function BillingPage({ params }: { params: Promise<{ companyId: string }> }) {
  const { companyId } = await params;
  const [company, rows] = await Promise.all([
    serverApi<Company>(`/companies/${companyId}`),
    serverApi<BillingNoteRow[]>(`/companies/${companyId}/billing-notes`),
  ]);
  const t = th.billing;
  const cell = 'border border-rule px-2.5 py-2';
  return (
    <div className="flex min-h-full flex-col gap-4 p-4 sm:p-6">
      <div className="border-b-2 border-ink pb-2.5">
        <h1 className="font-doc text-[20px] font-bold sm:text-2xl">{t.title} {company.name}</h1>
        <p className="text-sm text-ink2">{t.note}</p>
      </div>
      {rows.length === 0 ? <p className="text-ink2">{t.empty}</p> : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse bg-paper text-[15px]">
            <thead className="bg-band text-left text-sm"><tr>
              <th className={`${cell} font-medium`}>{th.sales.docNo}</th>
              <th className={`${cell} font-medium`}>{th.sales.customer}</th>
              <th className={`${cell} font-medium`}>{t.due}</th>
              <th className={`${cell} text-right font-medium`}>{t.billed}</th>
              <th className={`${cell} font-medium`}>{th.closing.status}</th>
            </tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.id}>
                <td className={`${cell} font-num`}><Link href={`/c/${companyId}/sales/billing/${r.id}`} className="underline">{r.docNo}</Link></td>
                <td className={cell}>{r.partyName}</td>
                <td className={`${cell} font-num`}>{isoToThai(r.dueDate)}</td>
                <td className={`${cell} num`}>{formatMoney(r.total)}</td>
                <td className={cell}>{t.status[r.status]}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {company.can_write && !company.locked && (
        <Link href={`/c/${companyId}/sales/billing/new`} className="inline-flex min-h-11 items-center justify-center self-start rounded-doc bg-ink px-4 font-medium text-paper max-sm:w-full max-sm:min-h-13">{t.new}</Link>
      )}
    </div>
  );
}
