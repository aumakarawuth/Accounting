import { ReceiptForm } from '@/components/sales/ReceiptForm';
import { serverApi } from '@/lib/server-api';
import type { SalesFormData } from '@/lib/api';

// ?party=<รหัสลูกค้า>&doc=<id ใบที่จะรับ> เมื่อเปิดจากหน้าเอกสาร
export default async function NewReceipt({
  params, searchParams,
}: { params: Promise<{ companyId: string }>; searchParams: Promise<{ party?: string; doc?: string }> }) {
  const { companyId } = await params;
  const sp = await searchParams;
  const form = await serverApi<SalesFormData>(`/companies/${companyId}/sales/form`);
  return <ReceiptForm companyId={companyId} form={form} initialParty={sp.party?.toUpperCase()} initialDoc={sp.doc} />;
}
