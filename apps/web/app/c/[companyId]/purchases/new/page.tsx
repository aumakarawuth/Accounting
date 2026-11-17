import { notFound } from 'next/navigation';
import { PurchaseForm, type PurchaseFormKind } from '@/components/purchases/PurchaseForm';
import { serverApi } from '@/lib/server-api';
import type { ApiError, PurchaseDocument, PurchaseFormData, PurchaseOrderDetail } from '@/lib/api';

const KINDS: PurchaseFormKind[] = ['invoice', 'cash-purchase', 'credit-note', 'debit-note'];
const UUID = /^[0-9a-f-]{36}$/;

// ?kind=invoice|cash-purchase · ใบลด/เพิ่มหนี้จากผู้ขาย: ?kind=credit-note|debit-note&ref=<id ใบซื้อเชื่อ> (เปิดจากหน้าเอกสาร)
// ซื้อตามใบสั่งซื้อ: ?kind=invoice&order=<id> · ซื้อจากใบรับสินค้า: ?kind=invoice&receipt=<id>
export default async function NewPurchase({
  params, searchParams,
}: { params: Promise<{ companyId: string }>; searchParams: Promise<{ kind?: string; ref?: string; order?: string; receipt?: string }> }) {
  const { companyId } = await params;
  const sp = await searchParams;
  const kind = KINDS.find((k) => k === sp.kind) ?? 'invoice';
  const isNote = kind === 'credit-note' || kind === 'debit-note';
  if (isNote && !sp.ref) notFound();
  const orderId = !isNote && sp.order ? sp.order : null;
  const receiptId = !isNote && sp.receipt && UUID.test(sp.receipt) ? sp.receipt : null;
  if (orderId && !UUID.test(orderId)) notFound();
  let refDoc: PurchaseDocument | null;
  let order: PurchaseOrderDetail | null;
  let receipt: PurchaseDocument | null;
  try {
    refDoc = isNote ? await serverApi<PurchaseDocument>(`/companies/${companyId}/purchases/documents/${sp.ref}`) : null;
    order = orderId ? await serverApi<PurchaseOrderDetail>(`/companies/${companyId}/purchase-orders/${orderId}`) : null;
    receipt = receiptId ? await serverApi<PurchaseDocument>(`/companies/${companyId}/purchases/documents/${receiptId}`) : null;
  } catch (e) {
    if ([400, 404].includes((e as ApiError).status)) notFound();
    throw e;
  }
  const form = await serverApi<PurchaseFormData>(`/companies/${companyId}/purchases/form`);
  return (
    <PurchaseForm key={`${kind}-${sp.ref ?? ''}-${orderId ?? ''}-${receiptId ?? ''}`} companyId={companyId} kind={kind} form={form} refDoc={refDoc}
      fromOrder={order} receiptId={receipt?.kind === 'goods_receipt' ? receipt.id : null} initialParty={receipt?.partyCode} />
  );
}
