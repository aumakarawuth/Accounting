import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CancelPanel } from '@/components/CancelPanel';
import { DocumentPaper, type Paper } from '@/components/sales/DocumentPaper';
import { serverApi } from '@/lib/server-api';
import type { ApiError, Company, SalesOrderDetail } from '@/lib/api';
import { isoToThai } from '@/lib/date';
import { formatMoney } from '@/lib/money';
import { th } from '@/i18n/th';

// ใบเสนอราคา / ใบสั่งขาย: กระดาษ + สถานะ + จำนวนที่ส่งแล้ว + เอกสารที่ต่อจากใบนี้
export default async function OrderPage({ params }: { params: Promise<{ companyId: string; orderId: string }> }) {
  const { companyId, orderId } = await params;
  if (!/^[0-9a-f-]{36}$/.test(orderId)) notFound();
  let o: SalesOrderDetail;
  try {
    o = await serverApi<SalesOrderDetail>(`/companies/${companyId}/sales-orders/${orderId}`);
  } catch (e) {
    if ([400, 404].includes((e as ApiError).status)) notFound();
    throw e;
  }
  const company = await serverApi<Company>(`/companies/${companyId}`);
  const t = th.orders;
  const canPost = company.can_write && !company.locked && o.status !== 'cancelled';
  const isQuote = o.kind === 'quotation';
  const paper: Paper = {
    kind: o.kind, isTaxInvoice: false,
    seller: { name: o.sellerName, taxId: o.sellerTaxId, branchNo: o.sellerBranchNo, address: o.sellerAddress },
    party: { name: o.partyName, taxId: o.partyTaxId, branchNo: o.partyBranchNo, address: o.partyAddress },
    docNo: o.docNo, date: o.date, untilDate: o.untilDate, refDocNo: o.source?.docNo ?? null,
    lines: o.lines.map((l) => ({ description: l.description, qty: l.qty, unit: l.unit, unitPrice: l.unitPrice, amount: l.amount })),
    gross: o.gross, discount: o.discount, base: o.base, vat: o.vat, total: o.total, vatRate: o.vatRate, priceMode: o.priceMode, whtAmount: '0',
  };
  const link = 'inline-flex min-h-11 items-center justify-center rounded-doc border border-ink px-4 font-medium max-sm:w-full';
  const related = (title: string, rows: { id: string; docNo: string; href: string; note: string; off: boolean }[]) => rows.length > 0 && (
    <div className="flex flex-col gap-1">
      <h3 className="font-medium">{title}</h3>
      <ul className="flex flex-col">
        {rows.map((r) => (
          <li key={r.id} className={`flex min-h-11 flex-wrap items-center gap-x-3 border-b border-rule ${r.off ? 'text-ink2 line-through' : ''}`}>
            <Link href={r.href} className="font-num underline">{r.docNo}</Link><span className="text-sm">{r.note}</span>
          </li>
        ))}
      </ul>
    </div>
  );
  const status = !isQuote && o.status === 'open' ? t.statusOpenOrder : t.status[o.status];

  return (
    <div className="grid gap-5 p-4 sm:p-6 lg:grid-cols-[minmax(0,1fr)_340px]">
      <DocumentPaper p={paper} />
      <aside className="flex flex-col gap-4">
        <p role="status" className={`border border-rule-strong px-4 py-2.5 ${o.status === 'cancelled' ? 'text-ink2' : ''}`}>
          {o.status === 'cancelled' && o.cancelReason ? t.cancelled(o.cancelReason) : status} · {t.noPost}
        </p>
        {!isQuote && (
          <table className="w-full border-collapse text-[15px]">
            <thead className="bg-band text-left text-sm"><tr>
              <th className="border border-rule px-2 py-1.5 font-medium">{th.sales.description}</th>
              <th className="border border-rule px-2 py-1.5 text-right font-medium">{t.delivered}</th>
            </tr></thead>
            <tbody>{o.lines.map((l) => (
              <tr key={l.lineNo}>
                <td className="border border-rule px-2 py-1.5">{l.description}</td>
                <td className="border border-rule px-2 py-1.5 num">{Number(l.delivered)} / {Number(l.qty)} {l.unit}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
        {canPost && isQuote && o.status !== 'accepted' && (
          <Link href={`/c/${companyId}/sales/new?kind=sales-order&from=${o.id}`} className={link}>{t.toOrder}</Link>
        )}
        {canPost && !isQuote && o.status !== 'closed' && (
          <>
            <Link href={`/c/${companyId}/sales/new?kind=invoice&order=${o.id}`} className={link}>{t.toInvoice}</Link>
            <Link href={`/c/${companyId}/sales/deposits/new?order=${o.id}`} className={link}>{t.toDeposit}</Link>
          </>
        )}
        <section aria-label={t.related} className="flex flex-col gap-3">
          {o.source && related(th.orders.tabs.quotation, [{ id: o.source.id, docNo: o.source.docNo, href: `/c/${companyId}/sales/orders/${o.source.id}`, note: '', off: false }])}
          {related(t.orders, o.orders.map((x) => ({ id: x.id, docNo: x.docNo, href: `/c/${companyId}/sales/orders/${x.id}`, note: x.cancelled ? t.voided : '', off: x.cancelled })))}
          {related(t.invoices, o.invoices.map((x) => ({ id: x.id, docNo: x.docNo, href: `/c/${companyId}/sales/documents/${x.id}`,
            note: `${isoToThai(x.date)} · ${formatMoney(x.total)}${x.voided ? ` · ${t.voided}` : ''}`, off: x.voided })))}
          {related(t.deposits, o.deposits.map((x) => ({ id: x.id, docNo: x.docNo, href: `/c/${companyId}/sales/documents/${x.id}`,
            note: `${formatMoney(x.total)} · ${x.voided ? t.voided : t.remaining(formatMoney(x.remaining))}`, off: x.voided })))}
        </section>
        {canPost && <CancelPanel path={`/companies/${companyId}/sales-orders/${o.id}/cancel`} title={t.cancel} explain={t.cancelExplain} />}
      </aside>
    </div>
  );
}
