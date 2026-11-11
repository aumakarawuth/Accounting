import Link from 'next/link';
import { serverApi } from '@/lib/server-api';
import type { Company, OpenReceiptLine, PurchaseRow } from '@/lib/api';
import { isoToThai } from '@/lib/date';
import { formatMoney } from '@/lib/money';
import { th } from '@/i18n/th';

// ใบรับสินค้าทั้งหมด: รอใบแจ้งหนี้ = ยังมีบรรทัดที่ยังไม่ได้บันทึกซื้อ
export default async function GoodsReceiptsPage({ params }: { params: Promise<{ companyId: string }> }) {
  const { companyId } = await params;
  const [company, rows, open] = await Promise.all([
    serverApi<Company>(`/companies/${companyId}`),
    serverApi<PurchaseRow[]>(`/companies/${companyId}/purchases?kind=goods_receipt`),
    serverApi<OpenReceiptLine[]>(`/companies/${companyId}/goods-receipts/open`),
  ]);
  const waiting = new Set(open.map((l) => l.receiptId));
  const t = th.goodsReceipts;
  const status = (r: PurchaseRow) => (r.voidedAt ? t.status.voided : waiting.has(r.id) ? t.status.waiting : t.status.done);
  const cell = 'border border-rule px-2.5 py-2';
  const href = (r: PurchaseRow) => `/c/${companyId}/purchases/documents/${r.id}`;
  return (
    <div className="flex min-h-full flex-col gap-4 p-4 sm:p-6">
      <div className="border-b-2 border-ink pb-2.5">
        <h1 className="font-doc text-[20px] font-bold sm:text-2xl">{t.title} {company.name}</h1>
        <p className="text-sm text-ink2">{t.note}</p>
      </div>
      {rows.length === 0 ? <p className="text-ink2">{t.empty}</p> : (
        <>
          <table className="w-full border-collapse bg-paper text-[15px] max-sm:hidden">
            <thead className="bg-band text-left text-sm"><tr>
              <th className={`${cell} font-medium`}>{th.sales.docNo}</th>
              <th className={`${cell} font-medium`}>{t.vendorDocNo}</th>
              <th className={`${cell} font-medium`}>{th.sales.date}</th>
              <th className={`${cell} font-medium`}>{th.purchases.vendor}</th>
              <th className={`${cell} text-right font-medium`}>{th.sales.total}</th>
              <th className={`${cell} font-medium`}>{th.closing.status}</th>
            </tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.id} className={r.voidedAt ? 'text-ink2 line-through' : ''}>
                <td className={`${cell} font-num`}><Link href={href(r)} className="underline">{r.docNo}</Link></td>
                <td className={`${cell} font-num`}>{r.vendorDocNo}</td>
                <td className={`${cell} font-num`}>{isoToThai(r.date)}</td>
                <td className={cell}>{r.partyCode} {r.partyName}</td>
                <td className={`${cell} num`}>{formatMoney(r.total)}</td>
                <td className={cell}>{status(r)}</td>
              </tr>
            ))}</tbody>
          </table>
          <ul className="border-t border-rule-strong bg-paper sm:hidden">
            {rows.map((r) => (
              <li key={r.id} className="border-b border-rule">
                <Link href={href(r)} className="grid min-h-12 grid-cols-[minmax(0,1fr)_auto] gap-x-3 px-4 py-2">
                  <span className="font-num">{r.docNo}</span><span className="num">{formatMoney(r.total)}</span>
                  <span className="text-sm">{r.partyName}</span><span className="text-right text-sm text-ink2">{status(r)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
      {company.can_write && !company.locked && (
        <Link href={`/c/${companyId}/purchases/receipts/new`} className="inline-flex min-h-11 items-center justify-center self-start rounded-doc bg-ink px-4 font-medium text-paper max-sm:w-full max-sm:min-h-13">{t.new}</Link>
      )}
    </div>
  );
}
