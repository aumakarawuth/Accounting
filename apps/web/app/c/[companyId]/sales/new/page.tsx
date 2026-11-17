import { notFound } from 'next/navigation';
import { SalesDocumentForm, type SalesFormKind } from '@/components/sales/SalesDocumentForm';
import { serverApi } from '@/lib/server-api';
import type { ApiError, SalesDocument, SalesFormData, SalesOrderDetail } from '@/lib/api';

const KINDS: SalesFormKind[] = ['invoice', 'cash-sale', 'credit-note', 'debit-note', 'quotation', 'sales-order'];
const UUID = /^[0-9a-f-]{36}$/;

// ?kind=invoice|cash-sale|quotation|sales-order · ใบลด/เพิ่มหนี้: ?kind=credit-note&ref=<id ใบที่อ้าง>
// ขายเชื่อจากใบสั่งขาย: ?kind=invoice&order=<id> · ใบสั่งขายจากใบเสนอราคา: ?kind=sales-order&from=<id>
export default async function NewSalesDocument({
  params, searchParams,
}: { params: Promise<{ companyId: string }>; searchParams: Promise<{ kind?: string; ref?: string; order?: string; from?: string }> }) {
  const { companyId } = await params;
  const sp = await searchParams;
  const kind = KINDS.find((k) => k === sp.kind) ?? 'invoice';
  const isNote = kind === 'credit-note' || kind === 'debit-note';
  if (isNote && !sp.ref) notFound();
  const fromId = kind === 'invoice' ? sp.order : kind === 'sales-order' ? sp.from : undefined;
  if (fromId && !UUID.test(fromId)) notFound();
  let refDoc: SalesDocument | null;
  let fromDoc: SalesOrderDetail | null;
  try {
    refDoc = isNote ? await serverApi<SalesDocument>(`/companies/${companyId}/sales/documents/${sp.ref}`) : null;
    fromDoc = fromId ? await serverApi<SalesOrderDetail>(`/companies/${companyId}/sales-orders/${fromId}`) : null;
  } catch (e) {
    if ([400, 404].includes((e as ApiError).status)) notFound();
    throw e;
  }
  const form = await serverApi<SalesFormData>(`/companies/${companyId}/sales/form`);
  return <SalesDocumentForm key={`${kind}-${sp.ref ?? ''}-${fromId ?? ''}`} companyId={companyId} kind={kind} form={form} refDoc={refDoc} fromDoc={fromDoc} />;
}
