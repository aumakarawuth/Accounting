import Link from 'next/link';
import { MonthNav } from '@/components/MonthNav';
import { DocTable } from '@/components/docs/DocTable';
import { serverApi } from '@/lib/server-api';
import type { Company, SalesRow } from '@/lib/api';
import { isMonth, monthLabel, todayIso } from '@/lib/date';
import { th } from '@/i18n/th';

export default async function ReceiptList({
  params, searchParams,
}: { params: Promise<{ companyId: string }>; searchParams: Promise<{ month?: string }> }) {
  const { companyId } = await params;
  const sp = await searchParams;
  const month = isMonth(sp.month) ? sp.month : todayIso().slice(0, 7);
  const [company, rows] = await Promise.all([
    serverApi<Company>(`/companies/${companyId}`),
    serverApi<SalesRow[]>(`/companies/${companyId}/sales?month=${month}&kind=receipt`),
  ]);
  const canPost = company.can_write && !company.locked;
  return (
    <div className="flex min-h-full flex-col gap-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-end gap-3 border-b-2 border-ink pb-2.5">
        <h1 className="min-w-0 font-doc text-[20px] font-bold sm:text-2xl">{th.sales.receiptsTitle} {company.name} · {monthLabel(month)}</h1>
        <div className="sm:ml-auto"><MonthNav month={month} href={(m) => `/c/${companyId}/sales/receipts?month=${m}`} /></div>
      </div>
      <DocTable companyId={companyId} rows={rows} area="sales" kinds={th.sales.kinds} party={th.sales.customer} />
      {canPost && (
        <div className="sticky bottom-0 -mx-4 -mb-4 mt-auto border-t border-rule-strong bg-paper px-4 py-2.5 sm:static sm:m-0 sm:border-0 sm:bg-transparent sm:p-0">
          <Link href={`/c/${companyId}/sales/receipts/new`} className="flex min-h-13 items-center justify-center rounded-doc bg-ink px-4 font-medium text-paper sm:inline-flex sm:min-h-11">
            {th.sales.newReceipt}
          </Link>
        </div>
      )}
    </div>
  );
}
