import { ExportLinks } from '@/components/ExportLinks';
import { MonthNav } from '@/components/MonthNav';
import { Payroll } from '@/components/payroll/Payroll';
import { serverApi } from '@/lib/server-api';
import type { Company, PayrollPage } from '@/lib/api';
import { isMonth, todayIso } from '@/lib/date';
import { formatMoney } from '@/lib/money';
import { th } from '@/i18n/th';

// เงินเดือนแบบง่าย (docs/phase7-spec.md ข้อ 3): ทะเบียนพนักงาน · ลงเงินเดือน · นำส่ง · รายงาน
export default async function PayrollRoute({
  params, searchParams,
}: { params: Promise<{ companyId: string }>; searchParams: Promise<{ month?: string }> }) {
  const { companyId } = await params;
  const sp = await searchParams;
  const month = isMonth(sp.month) ? sp.month : todayIso().slice(0, 7);
  const [company, data] = await Promise.all([
    serverApi<Company>(`/companies/${companyId}`),
    serverApi<PayrollPage>(`/companies/${companyId}/payroll?month=${month}`),
  ]);
  const t = th.payroll;
  return (
    <div className="flex min-h-full flex-col gap-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-end gap-3 border-b-2 border-ink pb-2.5">
        <h1 className="font-doc text-[20px] font-bold sm:text-2xl">{t.title} {company.name}</h1>
        <div className="flex flex-wrap items-center gap-3 sm:ml-auto">
          <MonthNav month={month} href={(m) => `/c/${companyId}/payroll?month=${m}`} />
          <ExportLinks base={`/export/company/${companyId}/payroll`} query={`month=${month}`} />
        </div>
      </div>
      <p className="max-w-3xl text-sm text-ink2">{t.note(formatMoney(data.ceiling))}</p>
      <Payroll key={month} companyId={companyId} data={data} />
    </div>
  );
}
