import { CashTransfers } from '@/components/cash/CashTransfers';
import { serverApi } from '@/lib/server-api';
import type { CashTransferPage } from '@/lib/api';
import { th } from '@/i18n/th';

// ฝาก/ถอน/โอนเงินระหว่างบัญชีเงินสดและเงินฝาก (docs/phase5-spec.md ข้อ 9)
export default async function Transfers({ params }: { params: Promise<{ companyId: string }> }) {
  const { companyId } = await params;
  const data = await serverApi<CashTransferPage>(`/companies/${companyId}/cash-transfers`);
  const t = th.cashTransfers;
  return (
    <div className="flex min-h-full flex-col gap-4 p-4 sm:p-6">
      <div className="border-b-2 border-ink pb-2.5">
        <h1 className="font-doc text-[20px] font-bold sm:text-2xl">{t.title} {data.company.name}</h1>
      </div>
      <p className="max-w-3xl text-sm text-ink2">{t.note}</p>
      <CashTransfers companyId={companyId} data={data} />
    </div>
  );
}
