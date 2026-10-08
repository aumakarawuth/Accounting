import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Money } from '@/components/Money';
import { DocumentActions, type ActionLink } from '@/components/docs/DocumentActions';
import { CertificatePaper, RecordPaper, VoucherPaper } from '@/components/purchases/PurchasePapers';
import { serverApi } from '@/lib/server-api';
import type { ApiError, Company, PurchaseDocument } from '@/lib/api';
import { isoToThai } from '@/lib/date';
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
  const open = d.kind === 'purchase_invoice' && Number(d.open ?? 0) > 0;
  const links: ActionLink[] = open ? [
    { href: c(`/purchases/new?kind=credit-note&ref=${d.id}`), label: th.purchases.issueCreditNote },
    { href: c(`/purchases/payments/new?party=${encodeURIComponent(d.partyCode)}&doc=${d.id}`), label: th.purchases.payThis, primary: true },
  ] : [];
  const related = [
    ...d.settles.map((s) => ({ id: s.id, docNo: s.docNo, label: `${th.purchases.settles} ${s.vendorDocNo ?? ''}`, amount: s.amount, voided: false })),
    ...d.settledBy.map((s) => ({ id: s.id, docNo: s.docNo, label: `${th.purchases.kinds[s.kind]} ${isoToThai(s.date)}`, amount: s.amount, voided: s.voided })),
    ...d.notes.map((n) => ({ id: n.id, docNo: n.docNo, label: th.purchases.kinds[n.kind] ?? '', amount: n.total, voided: n.voided })),
  ];

  return (
    <div className="flex flex-col gap-4 p-4 sm:p-6 print:p-0">
      <Link href={d.kind === 'payment' ? c('/purchases/payments') : c(`/purchases?month=${d.date.slice(0, 7)}`)}
        className="flex min-h-11 items-center self-start text-sm underline print:hidden">
        ‹ {d.kind === 'payment' ? th.purchases.backToPayments : th.purchases.backToList}
      </Link>
      {d.voidedAt
        ? <p role="status" className="neg border border-rule-strong bg-band px-4 py-2.5 print:hidden">{th.sales.voidedNote(isoToThai(d.voidedAt.slice(0, 10)), d.voidReason ?? '', d.voidDocNo ?? '')}</p>
        : <p className="text-sm text-ink2 print:hidden">{th.purchases.postedLocked}</p>}
      <DocumentActions companyId={companyId} doc={d} writable={company.can_write && !company.locked}
        voidPath={`/companies/${companyId}/purchases/documents/${d.id}/void`} links={links} />
      <div className="max-w-4xl">{d.kind === 'payment' ? <VoucherPaper doc={d} /> : <RecordPaper doc={d} />}</div>
      {open && <p className="print:hidden">{th.sales.open} <Money value={d.open!} /></p>}
      {d.kind === 'purchase_invoice' && !open && !d.voidedAt && <p className="print:hidden">{th.purchases.paid}</p>}
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
