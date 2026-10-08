import Link from 'next/link';
import { MonthNav } from '@/components/MonthNav';
import { DocTable } from '@/components/docs/DocTable';
import { serverApi } from '@/lib/server-api';
import type { Company, PurchaseRow } from '@/lib/api';
import { isMonth, monthLabel, todayIso } from '@/lib/date';
import { th } from '@/i18n/th';

export default async function PaymentList({
  params, searchParams,
}: { params: Promise<{ companyId: string }>; searchParams: Promise<{ month?: string }> }) {
  const { companyId } = await params;
  const sp = await searchParams;
  const month = isMonth(sp.month) ? sp.month : todayIso().slice(0, 7);
  const [company, rows] = await Promise.all([
    serverApi<Company>(`/companies/${companyId}`),
    serverApi<PurchaseRow[]>(`/companies/${companyId}/purchases?month=${month}&kind=payment`),
  ]);
  const canPost = company.can_write && !company.locked;
  return (
    <div className="flex min-h-full flex-col gap-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-end gap-3 border-b-2 border-ink pb-2.5">
        <h1 className="min-w-0 font-doc text-[20px] font-bold sm:text-2xl">{th.purchases.paymentsTitle} {company.name} · {monthLabel(month)}</h1>
        <div className="sm:ml-auto"><MonthNav month={month} href={(m) => `/c/${companyId}/purchases/payments?month=${m}`} /></div>
      </div>
      <DocTable companyId={companyId} rows={rows} area="purchases" kinds={th.purchases.kinds} party={th.purchases.vendor} paid={th.purchases.paid} />
      {canPost && (
        <div className="sticky bottom-0 -mx-4 -mb-4 mt-auto border-t border-rule-strong bg-paper px-4 py-2.5 sm:static sm:m-0 sm:border-0 sm:bg-transparent sm:p-0">
          <Link href={`/c/${companyId}/purchases/payments/new`} className="flex min-h-13 items-center justify-center rounded-doc bg-ink px-4 font-medium text-paper sm:inline-flex sm:min-h-11">
            {th.purchases.newPayment}
          </Link>
        </div>
      )}
    </div>
  );
}
