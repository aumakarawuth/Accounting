import Link from 'next/link';
import { serverApi } from '@/lib/server-api';
import type { Company, OpenDeposit, SalesRow } from '@/lib/api';
import { isoToThai } from '@/lib/date';
import { formatMoney } from '@/lib/money';
import { th } from '@/i18n/th';

// เงินมัดจำทั้งหมด (ยอดคงเหลือ = ยังไม่ได้หักในใบขายเชื่อ)
export default async function DepositsPage({ params }: { params: Promise<{ companyId: string }> }) {
  const { companyId } = await params;
  const [company, rows, open] = await Promise.all([
    serverApi<Company>(`/companies/${companyId}`),
    serverApi<SalesRow[]>(`/companies/${companyId}/sales?kind=deposit`),
    serverApi<OpenDeposit[]>(`/companies/${companyId}/deposits`),
  ]);
  const left = new Map(open.map((d) => [d.id, d.remaining]));
  const cell = 'border border-rule px-2.5 py-2';
  const canPost = company.can_write && !company.locked;
  return (
    <div className="flex min-h-full flex-col gap-4 p-4 sm:p-6">
      <div className="border-b-2 border-ink pb-2.5">
        <h1 className="font-doc text-[20px] font-bold sm:text-2xl">{th.deposits.list} {company.name}</h1>
        <p className="text-sm text-ink2">{th.deposits.note}</p>
      </div>
      {rows.length === 0 ? <p className="text-ink2">{th.deposits.empty}</p> : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse bg-paper text-[15px]">
            <thead className="bg-band text-left text-sm"><tr>
              <th className={`${cell} font-medium`}>{th.sales.docNo}</th>
              <th className={`${cell} font-medium`}>{th.sales.date}</th>
              <th className={`${cell} font-medium`}>{th.sales.customer}</th>
              <th className={`${cell} text-right font-medium`}>{th.sales.total}</th>
              <th className={`${cell} text-right font-medium`}>{th.deposits.remaining}</th>
            </tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.id} className={r.voidedAt ? 'text-ink2 line-through' : ''}>
                <td className={`${cell} font-num`}><Link href={`/c/${companyId}/sales/documents/${r.id}`} className="underline">{r.docNo}</Link></td>
                <td className={`${cell} font-num`}>{isoToThai(r.date)}</td>
                <td className={cell}>{r.partyName}</td>
                <td className={`${cell} num`}>{formatMoney(r.total)}</td>
                <td className={`${cell} num`}>{r.voidedAt ? '' : formatMoney(left.get(r.id) ?? '0')}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {canPost && (
        <Link href={`/c/${companyId}/sales/deposits/new`} className="inline-flex min-h-11 items-center justify-center self-start rounded-doc bg-ink px-4 font-medium text-paper max-sm:w-full max-sm:min-h-13">{th.deposits.new}</Link>
      )}
    </div>
  );
}
