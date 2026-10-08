import { notFound } from 'next/navigation';
import { PurchaseForm, type PurchaseFormKind } from '@/components/purchases/PurchaseForm';
import { serverApi } from '@/lib/server-api';
import type { ApiError, PurchaseDocument, PurchaseFormData } from '@/lib/api';

const KINDS: PurchaseFormKind[] = ['invoice', 'cash-purchase', 'credit-note'];

// ?kind=invoice|cash-purchase · ใบลดหนี้จากผู้ขาย: ?kind=credit-note&ref=<id ใบซื้อเชื่อ> (เปิดจากหน้าเอกสาร)
export default async function NewPurchase({
  params, searchParams,
}: { params: Promise<{ companyId: string }>; searchParams: Promise<{ kind?: string; ref?: string }> }) {
  const { companyId } = await params;
  const sp = await searchParams;
  const kind = KINDS.find((k) => k === sp.kind) ?? 'invoice';
  if (kind === 'credit-note' && !sp.ref) notFound();
  let refDoc: PurchaseDocument | null;
  try {
    refDoc = kind === 'credit-note' ? await serverApi<PurchaseDocument>(`/companies/${companyId}/purchases/documents/${sp.ref}`) : null;
  } catch (e) {
    if ([400, 404].includes((e as ApiError).status)) notFound();
    throw e;
  }
  const form = await serverApi<PurchaseFormData>(`/companies/${companyId}/purchases/form`);
  return <PurchaseForm key={`${kind}-${sp.ref ?? ''}`} companyId={companyId} kind={kind} form={form} refDoc={refDoc} />;
}
