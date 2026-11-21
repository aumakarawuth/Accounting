import { Adjustments } from '@/components/adjustments/Adjustments';
import { MonthNav } from '@/components/MonthNav';
import { serverApi } from '@/lib/server-api';
import type { AdjustmentPage, Company } from '@/lib/api';
import { isMonth, todayIso } from '@/lib/date';
import { th } from '@/i18n/th';

// รายการปรับปรุงสิ้นงวด + กลับรายการอัตโนมัติ (docs/phase6-spec.md ข้อ 5)
export default async function AdjustmentsPage({
  params, searchParams,
}: { params: Promise<{ companyId: string }>; searchParams: Promise<{ month?: string }> }) {
  const { companyId } = await params;
  const sp = await searchParams;
  const month = isMonth(sp.month) ? sp.month : todayIso().slice(0, 7);
  const [company, data] = await Promise.all([
    serverApi<Company>(`/companies/${companyId}`),
    serverApi<AdjustmentPage>(`/companies/${companyId}/adjustments`),
  ]);
  const t = th.adjustments;
  return (
    <div className="flex min-h-full flex-col gap-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-end gap-3 border-b-2 border-ink pb-2.5">
        <h1 className="font-doc text-[20px] font-bold sm:text-2xl">{t.title} {company.name}</h1>
        <div className="sm:ml-auto"><MonthNav month={month} href={(m) => `/c/${companyId}/adjustments?month=${m}`} /></div>
      </div>
      <p className="max-w-3xl text-sm text-ink2">{t.note}</p>
      <Adjustments companyId={companyId} data={data} month={month} />
    </div>
  );
}
