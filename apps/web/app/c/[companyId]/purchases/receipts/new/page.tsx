import { OrderReceiptForm } from '@/components/purchaseflow/OrderReceiptForm';
import { serverApi } from '@/lib/server-api';
import type { PurchaseFormData, PurchaseOrderDetail } from '@/lib/api';
import { th } from '@/i18n/th';

// ?order=<id ใบสั่งซื้อ> เมื่อเปิดจากหน้าใบสั่งซื้อ
export default async function NewGoodsReceipt({ params, searchParams }: { params: Promise<{ companyId: string }>; searchParams: Promise<{ order?: string }> }) {
  const { companyId } = await params;
  const sp = await searchParams;
  const orderId = sp.order && /^[0-9a-f-]{36}$/.test(sp.order) ? sp.order : null;
  const [form, order] = await Promise.all([
    serverApi<PurchaseFormData>(`/companies/${companyId}/purchases/form`),
    orderId ? serverApi<PurchaseOrderDetail>(`/companies/${companyId}/purchase-orders/${orderId}`) : Promise.resolve(null),
  ]);
  return (
    <div className="flex flex-col gap-4 p-4 sm:p-6">
      <div className="border-b-2 border-ink pb-2.5">
        <h1 className="font-doc text-[20px] font-bold sm:text-2xl">{th.goodsReceipts.formTitle}</h1>
        <p className="text-sm text-ink2">{th.goodsReceipts.note}</p>
      </div>
      <OrderReceiptForm companyId={companyId} mode="receipt" form={form} order={order} />
    </div>
  );
}
