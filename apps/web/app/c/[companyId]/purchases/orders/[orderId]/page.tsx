import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CancelPanel } from '@/components/CancelPanel';
import { serverApi } from '@/lib/server-api';
import type { ApiError, Company, PurchaseOrderDetail } from '@/lib/api';
import { isoToThai } from '@/lib/date';
import { formatMoney } from '@/lib/money';
import { formatTaxId } from '@/lib/taxid';
import { th } from '@/i18n/th';

// ใบสั่งซื้อ: กระดาษ + สถานะ + จำนวนที่รับแล้ว + เอกสารที่ต่อจากใบนี้
export default async function PurchaseOrderPage({ params }: { params: Promise<{ companyId: string; orderId: string }> }) {
  const { companyId, orderId } = await params;
  if (!/^[0-9a-f-]{36}$/.test(orderId)) notFound();
  let o: PurchaseOrderDetail;
  try {
    o = await serverApi<PurchaseOrderDetail>(`/companies/${companyId}/purchase-orders/${orderId}`);
  } catch (e) {
    if ([400, 404].includes((e as ApiError).status)) notFound();
    throw e;
  }
  const company = await serverApi<Company>(`/companies/${companyId}`);
  const t = th.purchaseOrders;
  const c = (p: string) => `/c/${companyId}${p}`;
  const canPost = company.can_write && !company.locked && o.status !== 'cancelled';
  const link = 'inline-flex min-h-11 items-center justify-center rounded-doc border border-ink px-4 font-medium max-sm:w-full';
  const cell = '[&_td]:border [&_td]:border-rule [&_td]:px-2 [&_td]:py-1.5 [&_th]:border [&_th]:border-rule [&_th]:bg-band [&_th]:px-2 [&_th]:py-1.5 [&_th]:text-left [&_th]:font-medium';
  const totals: [string, string, boolean?][] = [[th.sales.subtotal, o.gross]];
  if (Number(o.discount) > 0) totals.push([th.sales.discount, o.discount]);
  if (o.priceMode !== 'none') totals.push([th.sales.base, o.base], [th.sales.vat(String(Number(o.vatRate))), o.vat]);
  totals.push([th.sales.total, o.total, true]);

  return (
    <div className="grid gap-5 p-4 sm:p-6 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="@container">
        <article className="flex flex-col gap-3 border border-rule-strong bg-paper p-4 text-[13px] @2xl:p-8 @2xl:text-sm">
          <div className="flex flex-wrap justify-between gap-x-6 gap-y-2">
            <div className="min-w-0">
              <div className="text-[12px] text-ink2">{t.buyer}</div>
              <div className="font-doc text-[17px] font-bold @2xl:text-xl">{o.buyerName}</div>
              {o.buyerAddress && <div className="whitespace-pre-line">{o.buyerAddress}</div>}
              {o.buyerTaxId && <div>{th.sales.taxId} <span className="font-num">{formatTaxId(o.buyerTaxId)}</span></div>}
            </div>
            <div className="font-doc text-[17px] font-bold @2xl:text-xl">{t.paperTitle}</div>
          </div>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 border border-rule-input px-3 py-2">
            <dt className="text-ink2">{th.purchases.vendor}</dt><dd>{o.partyName}{o.partyTaxId ? <> · <span className="font-num">{formatTaxId(o.partyTaxId)}</span></> : null}</dd>
            <dt className="text-ink2">{th.sales.docNo}</dt><dd className="font-num">{o.docNo}</dd>
            <dt className="text-ink2">{th.sales.date}</dt><dd className="font-num">{isoToThai(o.date)}</dd>
            {o.untilDate && <><dt className="text-ink2">{t.until}</dt><dd className="font-num">{isoToThai(o.untilDate)}</dd></>}
          </dl>
          <div className="overflow-x-auto">
            <table className={`w-full border-collapse ${cell}`}>
              <thead><tr>
                <th>{th.sales.description}</th><th className="w-24 !text-right">{th.sales.qty}</th>
                <th className="w-24 !text-right">{th.sales.unitPrice}</th><th className="w-28 !text-right">{th.sales.amount}</th>
              </tr></thead>
              <tbody>{o.lines.map((l) => (
                <tr key={l.lineNo}>
                  <td>{l.description}</td><td className="num">{Number(l.qty)} {l.unit}</td>
                  <td className="num">{formatMoney(l.unitPrice)}</td><td className="num">{formatMoney(l.amount)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          <dl className="grid grid-cols-[minmax(0,1fr)_auto] @2xl:w-[320px] @2xl:self-end">
            {totals.map(([label, value, strong]) => (
              <div key={label} className="contents">
                <dt className={`px-2 py-1 ${strong ? 'border-t border-ink font-semibold' : ''}`}>{label}</dt>
                <dd className={`num px-2 py-1 ${strong ? 'border-t border-ink font-semibold' : ''}`}>{formatMoney(value)}</dd>
              </div>
            ))}
          </dl>
        </article>
      </div>
      <aside className="flex flex-col gap-4">
        <p role="status" className={`border border-rule-strong px-4 py-2.5 ${o.status === 'cancelled' ? 'text-ink2' : ''}`}>
          {o.status === 'cancelled' && o.cancelReason ? th.orders.cancelled(o.cancelReason) : t.status[o.status]} · {th.orders.noPost}
        </p>
        <table className="w-full border-collapse text-[15px]">
          <thead className="bg-band text-left text-sm"><tr>
            <th className="border border-rule px-2 py-1.5 font-medium">{th.sales.description}</th>
            <th className="border border-rule px-2 py-1.5 text-right font-medium">{t.received}</th>
          </tr></thead>
          <tbody>{o.lines.map((l) => (
            <tr key={l.lineNo}>
              <td className="border border-rule px-2 py-1.5">{l.description}</td>
              <td className="border border-rule px-2 py-1.5 num">{Number(l.received)} / {Number(l.qty)} {l.unit}</td>
            </tr>
          ))}</tbody>
        </table>
        {canPost && o.status !== 'closed' && (
          <>
            {!o.isService && <Link href={c(`/purchases/receipts/new?order=${o.id}`)} className={link}>{t.toReceipt}</Link>}
            <Link href={c(`/purchases/new?kind=invoice&order=${o.id}`)} className={link}>{t.toInvoice}</Link>
            <Link href={c(`/purchases/deposits/new?order=${o.id}`)} className={link}>{t.toDeposit}</Link>
          </>
        )}
        <section aria-label={th.orders.related} className="flex flex-col gap-3">
          {[[t.documents, o.documents.map((x) => ({ ...x, note: `${th.purchases.kinds[x.kind]} ${isoToThai(x.date)} · ${formatMoney(x.total)}` }))],
            [t.deposits, o.deposits.map((x) => ({ ...x, note: `${formatMoney(x.total)} · ${x.voided ? '' : th.orders.remaining(formatMoney(x.remaining))}` }))]]
            .filter(([, rows]) => (rows as unknown[]).length > 0)
            .map(([title, rows]) => (
              <div key={title as string} className="flex flex-col gap-1">
                <h3 className="font-medium">{title as string}</h3>
                <ul>{(rows as { id: string; docNo: string; note: string; voided: boolean }[]).map((r) => (
                  <li key={r.id} className={`flex min-h-11 flex-wrap items-center gap-x-3 border-b border-rule ${r.voided ? 'text-ink2 line-through' : ''}`}>
                    <Link href={c(`/purchases/documents/${r.id}`)} className="font-num underline">{r.docNo}</Link>
                    <span className="text-sm">{r.note}{r.voided ? ` · ${th.orders.voided}` : ''}</span>
                  </li>
                ))}</ul>
              </div>
            ))}
        </section>
        {canPost && <CancelPanel path={`/companies/${companyId}/purchase-orders/${o.id}/cancel`} title={th.orders.cancel} explain={th.orders.cancelExplain} />}
      </aside>
    </div>
  );
}
