import { MonthNav } from '@/components/MonthNav';
import { Templates } from '@/components/templates/Templates';
import { serverApi } from '@/lib/server-api';
import type { Company, TemplatesPage } from '@/lib/api';
import { isMonth, todayIso } from '@/lib/date';
import { th } from '@/i18n/th';

// แม่แบบรายการ / รายการประจำเดือน (docs/phase7-spec.md ข้อ 5): นักเรียนกดยืนยันลงเองทุกครั้ง
export default async function TemplatesRoute({
  params, searchParams,
}: { params: Promise<{ companyId: string }>; searchParams: Promise<{ month?: string }> }) {
  const { companyId } = await params;
  const sp = await searchParams;
  const month = isMonth(sp.month) ? sp.month : todayIso().slice(0, 7);
  const [company, data] = await Promise.all([
    serverApi<Company>(`/companies/${companyId}`),
    serverApi<TemplatesPage>(`/companies/${companyId}/templates?month=${month}`),
  ]);
  const t = th.templates;
  return (
    <div className="flex min-h-full flex-col gap-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-end gap-3 border-b-2 border-ink pb-2.5">
        <h1 className="font-doc text-[20px] font-bold sm:text-2xl">{t.title} {company.name}</h1>
        <div className="sm:ml-auto"><MonthNav month={month} href={(m) => `/c/${companyId}/templates?month=${m}`} /></div>
      </div>
      <p className="max-w-3xl text-sm text-ink2">{t.note}</p>
      <Templates key={month} companyId={companyId} data={data} />
    </div>
  );
}
