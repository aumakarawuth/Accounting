import { PaymentForm } from '@/components/purchases/PaymentForm';
import { serverApi } from '@/lib/server-api';
import type { PurchaseFormData } from '@/lib/api';

// ?party=<รหัสผู้ขาย>&doc=<id ใบที่จะจ่าย> เมื่อเปิดจากหน้าเอกสาร
export default async function NewPayment({
  params, searchParams,
}: { params: Promise<{ companyId: string }>; searchParams: Promise<{ party?: string; doc?: string }> }) {
  const { companyId } = await params;
  const sp = await searchParams;
  const form = await serverApi<PurchaseFormData>(`/companies/${companyId}/purchases/form`);
  return <PaymentForm companyId={companyId} form={form} initialParty={sp.party?.toUpperCase()} initialDoc={sp.doc} />;
}
