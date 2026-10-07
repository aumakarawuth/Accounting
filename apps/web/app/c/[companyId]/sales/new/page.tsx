import { notFound } from 'next/navigation';
import { SalesDocumentForm, type SalesFormKind } from '@/components/sales/SalesDocumentForm';
import { serverApi } from '@/lib/server-api';
import type { ApiError, SalesDocument, SalesFormData } from '@/lib/api';

const KINDS: SalesFormKind[] = ['invoice', 'cash-sale', 'credit-note', 'debit-note'];

// ?kind=invoice|cash-sale · ใบลด/เพิ่มหนี้: ?kind=credit-note&ref=<id ใบที่อ้าง> (เปิดจากหน้าเอกสาร)
export default async function NewSalesDocument({
  params, searchParams,
}: { params: Promise<{ companyId: string }>; searchParams: Promise<{ kind?: string; ref?: string }> }) {
  const { companyId } = await params;
  const sp = await searchParams;
  const kind = KINDS.find((k) => k === sp.kind) ?? 'invoice';
  const isNote = kind === 'credit-note' || kind === 'debit-note';
  if (isNote && !sp.ref) notFound();
  let refDoc: SalesDocument | null;
  try {
    refDoc = isNote ? await serverApi<SalesDocument>(`/companies/${companyId}/sales/documents/${sp.ref}`) : null;
  } catch (e) {
    if ([400, 404].includes((e as ApiError).status)) notFound();
    throw e;
  }
  const form = await serverApi<SalesFormData>(`/companies/${companyId}/sales/form`);
  return <SalesDocumentForm key={`${kind}-${sp.ref ?? ''}`} companyId={companyId} kind={kind} form={form} refDoc={refDoc} />;
}
