import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Money } from '@/components/Money';
import { DocumentActions, type ActionLink } from '@/components/docs/DocumentActions';
import { DocumentPaper, type Paper } from '@/components/sales/DocumentPaper';
import { serverApi } from '@/lib/server-api';
import type { ApiError, Company, SalesDocument } from '@/lib/api';
import { isoToThai } from '@/lib/date';
import { th } from '@/i18n/th';

// เอกสารขายที่ผ่านรายการแล้ว: กระดาษพร้อมตราประทับ (พิมพ์ได้) + ใบที่ตัดยอด/ถูกตัดยอด แก้ไม่ได้ ยกเลิกหรือออกใบลด/เพิ่มหนี้แทน
export default async function SalesDocumentPage({ params }: { params: Promise<{ companyId: string; documentId: string }> }) {
  const { companyId, documentId } = await params;
  let d: SalesDocument;
  try {
    d = await serverApi<SalesDocument>(`/companies/${companyId}/sales/documents/${documentId}`);
  } catch (e) {
    if ([400, 404].includes((e as ApiError).status)) notFound();
    throw e;
  }
  const company = await serverApi<Company>(`/companies/${companyId}`);
  const c = (p: string) => `/c/${companyId}${p}`;
  const paper: Paper = {
    kind: d.kind, isTaxInvoice: d.isTaxInvoice,
    seller: { name: d.sellerName, taxId: d.sellerTaxId, branchNo: d.sellerBranchNo, address: d.sellerAddress },
    party: { name: d.partyName, taxId: d.partyTaxId, branchNo: d.partyBranchNo, address: d.partyAddress },
    docNo: d.docNo, date: d.date, dueDate: d.dueDate, refDocNo: d.refDocNo, reason: d.reason,
    lines: d.lines.map((l) => ({ description: l.description, qty: String(Number(l.qty)), unit: l.unit, unitPrice: l.unitPrice, amount: l.amount })),
    gross: d.gross, discount: d.discount, base: d.base, vat: d.vat, total: d.total, vatRate: d.vatRate, priceMode: d.priceMode,
    whtAmount: d.whtAmount,
    stamp: d.voidedAt ? { kind: 'voided', docNo: d.voidDocNo ?? '', date: d.voidedAt.slice(0, 10) } : { kind: 'posted', docNo: d.entryDocNo, date: d.date },
  };
  // คำสั่งตามชนิดเอกสาร: ใบที่ยังค้างออกใบลด/เพิ่มหนี้และรับชำระได้
  const open = Number(d.open ?? 0) > 0 && (d.kind === 'sales_invoice' || d.kind === 'debit_note');
  const links: ActionLink[] = open ? [
    ...(d.kind === 'sales_invoice' ? [{ href: c(`/sales/new?kind=debit-note&ref=${d.id}`), label: th.sales.issueDebitNote }] : []),
    { href: c(`/sales/new?kind=credit-note&ref=${d.id}`), label: th.sales.issueCreditNote },
    { href: c(`/sales/receipts/new?party=${encodeURIComponent(d.partyCode)}&doc=${d.id}`), label: th.sales.receivePayment, primary: true },
  ] : [];
  const related = [
    ...d.settles.map((s) => ({ id: s.id, docNo: s.docNo, label: th.sales.settles, amount: s.amount, voided: false })),
    ...d.settledBy.map((s) => ({ id: s.id, docNo: s.docNo, label: `${th.sales.kinds[s.kind]} ${isoToThai(s.date)}`, amount: s.amount, voided: s.voided })),
    ...d.notes.map((n) => ({ id: n.id, docNo: n.docNo, label: th.sales.kinds[n.kind] ?? '', amount: n.total, voided: n.voided })),
  ];

  return (
    <div className="flex flex-col gap-4 p-4 sm:p-6 print:p-0">
      <Link href={d.kind === 'receipt' ? c('/sales/receipts') : c(`/sales/invoices?month=${d.date.slice(0, 7)}`)}
        className="flex min-h-11 items-center self-start text-sm underline print:hidden">
        ‹ {d.kind === 'receipt' ? th.sales.backToReceipts : th.sales.backToList}
      </Link>
      {d.voidedAt
        ? <p role="status" className="neg border border-rule-strong bg-band px-4 py-2.5 print:hidden">{th.sales.voidedNote(isoToThai(d.voidedAt.slice(0, 10)), d.voidReason ?? '', d.voidDocNo ?? '')}</p>
        : <p className="text-sm text-ink2 print:hidden">{th.sales.postedLocked}</p>}
      <DocumentActions companyId={companyId} doc={d} writable={company.can_write && !company.locked}
        voidPath={`/companies/${companyId}/sales/documents/${d.id}/void`} links={links} />
      <div className="max-w-4xl"><DocumentPaper p={paper} /></div>
      {d.open !== null && (d.kind === 'sales_invoice' || d.kind === 'debit_note') && !d.voidedAt && (
        <p className="print:hidden">{Number(d.open) > 0 ? <>{th.sales.open} <Money value={d.open} /></> : th.sales.paid}</p>
      )}
      {related.length > 0 && (
        <section className="flex max-w-4xl flex-col gap-1 print:hidden" aria-label={th.sales.payments}>
          <h2 className="border-b border-rule-strong pb-1.5 font-doc text-[17px] font-bold">{d.kind === 'receipt' ? th.sales.settles : th.sales.payments}</h2>
          <ul>
            {related.map((r) => (
              <li key={`${r.id}-${r.label}`} className="grid min-h-11 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-b border-rule">
                <Link href={c(`/sales/documents/${r.id}`)} className="font-num underline">{r.docNo}</Link>
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
