import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CancelPanel } from '@/components/CancelPanel';
import { serverApi } from '@/lib/server-api';
import type { ApiError, BillingNoteDetail, Company } from '@/lib/api';
import { bahtText } from '@/lib/bahttext';
import { isoToThai } from '@/lib/date';
import { formatMoney } from '@/lib/money';
import { formatTaxId } from '@/lib/taxid';
import { th } from '@/i18n/th';

// ใบวางบิลแบบกระดาษ (พิมพ์ได้) + สถานะ/ยอดค้างตอนนี้ + ยกเลิก
export default async function BillingNotePage({ params }: { params: Promise<{ companyId: string; noteId: string }> }) {
  const { companyId, noteId } = await params;
  if (!/^[0-9a-f-]{36}$/.test(noteId)) notFound();
  let n: BillingNoteDetail;
  try {
    n = await serverApi<BillingNoteDetail>(`/companies/${companyId}/billing-notes/${noteId}`);
  } catch (e) {
    if ([400, 404].includes((e as ApiError).status)) notFound();
    throw e;
  }
  const company = await serverApi<Company>(`/companies/${companyId}`);
  const t = th.billing;
  const cell = 'border border-rule px-2 py-1.5';
  const canPost = company.can_write && !company.locked;
  return (
    <div className="grid gap-5 p-4 sm:p-6 lg:grid-cols-[minmax(0,1fr)_320px]">
      <article className="flex flex-col gap-3 border border-rule-strong bg-paper p-4 text-sm sm:p-8 print:border-0 print:p-0">
        <div className="flex flex-wrap justify-between gap-3">
          <div>
            <div className="font-doc text-[17px] font-bold sm:text-xl">{n.sellerName}</div>
            {n.sellerAddress && <div className="whitespace-pre-line">{n.sellerAddress}</div>}
            {n.sellerTaxId && <div>{th.sales.taxId} <span className="font-num">{formatTaxId(n.sellerTaxId)}</span></div>}
          </div>
          <div className="text-right">
            <div className="font-doc text-[17px] font-bold sm:text-xl">{t.paperTitle}</div>
            <div className="font-num">{n.docNo}</div>
            <div>{th.sales.date} <span className="font-num">{isoToThai(n.date)}</span></div>
            <div>{t.due} <span className="font-num">{isoToThai(n.dueDate)}</span></div>
          </div>
        </div>
        <div className="border border-rule-input px-3 py-2">
          <div className="text-[12px] text-ink2">{th.sales.customer}</div>
          <div>{n.partyName}</div>
          {n.partyAddress && <div className="whitespace-pre-line">{n.partyAddress}</div>}
          {n.partyTaxId && <div>{th.sales.taxId} <span className="font-num">{formatTaxId(n.partyTaxId)}</span></div>}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead className="bg-band text-left"><tr>
              <th className={`${cell} font-medium`}>{t.docNo}</th>
              <th className={`${cell} font-medium`}>{t.docDate}</th>
              <th className={`${cell} font-medium`}>{t.due}</th>
              <th className={`${cell} text-right font-medium`}>{t.billed}</th>
            </tr></thead>
            <tbody>{n.items.map((x) => (
              <tr key={x.id}>
                <td className={`${cell} font-num`}>{x.docNo}</td>
                <td className={`${cell} font-num`}>{isoToThai(x.date)}</td>
                <td className={`${cell} font-num`}>{isoToThai(x.dueDate)}</td>
                <td className={`${cell} num`}>{formatMoney(x.amount)}</td>
              </tr>
            ))}</tbody>
            <tfoot><tr className="font-semibold">
              <td colSpan={3} className={`${cell} text-right`}>{t.total}</td>
              <td className={`${cell} num border-b-[3px] border-double border-b-ink`}>{formatMoney(n.total)}</td>
            </tr></tfoot>
          </table>
        </div>
        <p>({bahtText(n.total)})</p>
        <div className="mt-6 grid grid-cols-2 gap-6 text-center text-[12px]">
          <div><div className="h-9 border-b border-dotted border-ink" />{th.sales.receivedBy}</div>
          <div><div className="h-9 border-b border-dotted border-ink" />{th.sales.authorized}</div>
        </div>
      </article>
      <aside className="flex flex-col gap-4 print:hidden">
        <p role="status" className="border border-rule-strong px-4 py-2.5">
          {n.status === 'cancelled' && n.cancelReason ? th.orders.cancelled(n.cancelReason) : t.status[n.status]} · {t.openNow} {formatMoney(n.open)}
        </p>
        {canPost && n.status === 'open' && (
          <Link href={`/c/${companyId}/sales/receipts/new?party=${n.partyCode}`} className="inline-flex min-h-11 items-center justify-center rounded-doc bg-ink px-4 font-medium text-paper">{t.receive}</Link>
        )}
        {canPost && n.status !== 'cancelled' && (
          <CancelPanel path={`/companies/${companyId}/billing-notes/${n.id}/cancel`} title={th.orders.cancel} explain={th.orders.cancelExplain} />
        )}
      </aside>
    </div>
  );
}
