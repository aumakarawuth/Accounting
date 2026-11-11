import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Money } from '@/components/Money';
import { DocumentActions, type ActionLink } from '@/components/docs/DocumentActions';
import { CertificatePaper, RecordPaper, VoucherPaper } from '@/components/purchases/PurchasePapers';
import { serverApi } from '@/lib/server-api';
import type { ApiError, Company, PurchaseDocument } from '@/lib/api';
import { isoToThai } from '@/lib/date';
import { formatMoney } from '@/lib/money';
import { th } from '@/i18n/th';

// เอกสารซื้อที่บันทึกแล้ว: ซื้อเชื่อ/ซื้อสด/ใบลดหนี้ แสดงเป็นบันทึกจากเอกสารผู้ขาย · จ่ายชำระเป็นใบสำคัญจ่าย
// มีหัก ณ ที่จ่ายแสดง 50 ทวิ ต่อท้าย (พิมพ์แยกหน้า) แก้ไม่ได้ ยกเลิกแล้วบันทึกใหม่แทน
export default async function PurchaseDocumentPage({ params }: { params: Promise<{ companyId: string; documentId: string }> }) {
  const { companyId, documentId } = await params;
  let d: PurchaseDocument;
  try {
    d = await serverApi<PurchaseDocument>(`/companies/${companyId}/purchases/documents/${documentId}`);
  } catch (e) {
    if ([400, 404].includes((e as ApiError).status)) notFound();
    throw e;
  }
  const company = await serverApi<Company>(`/companies/${companyId}`);
  const c = (p: string) => `/c/${companyId}${p}`;
  const payable = d.kind === 'purchase_invoice' || d.kind === 'purchase_debit_note';
  const open = payable && Number(d.open ?? 0) > 0;
  const waiting = d.kind === 'goods_receipt' && !d.voidedAt && d.lines.some((l) => Number(l.invoiced) < Number(l.qty));
  const links: ActionLink[] = [
    ...(open && d.kind === 'purchase_invoice' ? [{ href: c(`/purchases/new?kind=credit-note&ref=${d.id}`), label: th.purchases.issueCreditNote }] : []),
    ...(d.kind === 'purchase_invoice' && !d.voidedAt ? [{ href: c(`/purchases/new?kind=debit-note&ref=${d.id}`), label: th.purchases.issueDebitNote }] : []),
    ...(open ? [{ href: c(`/purchases/payments/new?party=${encodeURIComponent(d.partyCode)}&doc=${d.id}`), label: th.purchases.payThis, primary: true }] : []),
    ...(waiting ? [{ href: c(`/purchases/new?kind=invoice&receipt=${d.id}`), label: th.purchases.invoiceFromReceipt, primary: true }] : []),
  ];
  const back = d.kind === 'payment' ? [c('/purchases/payments'), th.purchases.backToPayments]
    : d.kind === 'goods_receipt' ? [c('/purchases/receipts'), th.goodsReceipts.title]
    : d.kind === 'deposit' ? [c('/purchases/deposits'), th.purchaseDeposits.title]
    : [c(`/purchases?month=${d.date.slice(0, 7)}`), th.purchases.backToList];
  const related = [
    ...d.settles.map((s) => ({ id: s.id, docNo: s.docNo, label: `${th.purchases.settles} ${s.vendorDocNo ?? ''}`, amount: s.amount, voided: false })),
    ...d.settledBy.map((s) => ({ id: s.id, docNo: s.docNo, label: `${th.purchases.kinds[s.kind]} ${isoToThai(s.date)}`, amount: s.amount, voided: s.voided })),
    ...d.notes.map((n) => ({ id: n.id, docNo: n.docNo, label: th.purchases.kinds[n.kind] ?? '', amount: n.total, voided: n.voided })),
  ];

  return (
    <div className="flex flex-col gap-4 p-4 sm:p-6 print:p-0">
      <Link href={back[0]!} className="flex min-h-11 items-center self-start text-sm underline print:hidden">‹ {back[1]}</Link>
      {d.voidedAt
        ? <p role="status" className="neg border border-rule-strong bg-band px-4 py-2.5 print:hidden">{th.sales.voidedNote(isoToThai(d.voidedAt.slice(0, 10)), d.voidReason ?? '', d.voidDocNo ?? '')}</p>
        : <p className="text-sm text-ink2 print:hidden">{th.purchases.postedLocked}</p>}
      <DocumentActions companyId={companyId} doc={d} writable={company.can_write && !company.locked}
        voidPath={`/companies/${companyId}/purchases/documents/${d.id}/void`} links={links} />
      <div className="max-w-4xl">{d.kind === 'payment' ? <VoucherPaper doc={d} /> : <RecordPaper doc={d} />}</div>
      {open && <p className="print:hidden">{th.sales.open} <Money value={d.open!} /></p>}
      {payable && !open && !d.voidedAt && <p className="print:hidden">{th.purchases.paid}</p>}
      {d.kind === 'deposit' && !d.voidedAt && d.depositRemaining && <p className="print:hidden">{th.purchases.depositRemaining(formatMoney(d.depositRemaining))}</p>}
      {d.warehouse && <p className="print:hidden">{th.inventory.warehouse} {d.warehouse}</p>}
      {d.order && (
        <p className="print:hidden">
          <Link href={c(`/purchases/orders/${d.order.id}`)} className="underline">{th.purchases.fromOrderLink(d.order.docNo)}</Link>
        </p>
      )}
      {d.kind === 'goods_receipt' && (
        <ul className="flex max-w-4xl flex-col text-sm print:hidden">
          {d.lines.map((l) => (
            <li key={l.lineNo} className="flex min-h-11 items-center justify-between gap-3 border-b border-rule">
              <span>{l.description}</span><span className="num">{th.purchases.invoicedQty(String(Number(l.invoiced)), `${Number(l.qty)} ${l.unit}`)}</span>
            </li>
          ))}
        </ul>
      )}
      {d.matches.length > 0 && (
        <section className="flex max-w-4xl flex-col gap-1 print:hidden" aria-label={th.purchases.matchedTo}>
          <h2 className="border-b border-rule-strong pb-1.5 font-doc text-[17px] font-bold">{th.purchases.matchedTo}</h2>
          <ul>
            {d.matches.map((m) => (
              <li key={`${m.id}-${m.invoiceLineNo}-${m.receiptLineNo}`} className={`grid min-h-11 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-b border-rule ${m.voided ? 'text-ink2 line-through' : ''}`}>
                <Link href={c(`/purchases/documents/${m.id}`)} className="font-num underline">{m.docNo}</Link>
                <span className="num text-sm">{Number(m.qty)}</span>
                <Money value={m.amount} />
              </li>
            ))}
          </ul>
        </section>
      )}
      {d.certificate && <div className="max-w-4xl"><CertificatePaper cert={d.certificate} /></div>}
      {related.length > 0 && (
        <section className="flex max-w-4xl flex-col gap-1 print:hidden" aria-label={th.purchases.payments}>
          <h2 className="border-b border-rule-strong pb-1.5 font-doc text-[17px] font-bold">{d.kind === 'payment' ? th.purchases.settles : th.purchases.payments}</h2>
          <ul>
            {related.map((r) => (
              <li key={`${r.id}-${r.label}`} className="grid min-h-11 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-b border-rule">
                <Link href={c(`/purchases/documents/${r.id}`)} className="font-num underline">{r.docNo}</Link>
                <span className="text-sm text-ink2">{r.label}{r.voided ? ` · ${th.sales.voided}` : ''}</span>
                <Money value={r.amount} className={r.voided ? 'line-through' : ''} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
