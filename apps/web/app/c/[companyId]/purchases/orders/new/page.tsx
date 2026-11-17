import { OrderReceiptForm } from '@/components/purchaseflow/OrderReceiptForm';
import { serverApi } from '@/lib/server-api';
import type { PurchaseFormData } from '@/lib/api';
import { th } from '@/i18n/th';

export default async function NewPurchaseOrder({ params }: { params: Promise<{ companyId: string }> }) {
  const { companyId } = await params;
  const form = await serverApi<PurchaseFormData>(`/companies/${companyId}/purchases/form`);
  return (
    <div className="flex flex-col gap-4 p-4 sm:p-6">
      <h1 className="border-b-2 border-ink pb-2.5 font-doc text-[20px] font-bold sm:text-2xl">{th.purchaseOrders.formTitle}</h1>
      <OrderReceiptForm companyId={companyId} mode="order" form={form} order={null} />
    </div>
  );
}
