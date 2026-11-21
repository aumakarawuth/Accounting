import { Dividends } from '@/components/dividends/Dividends';
import { serverApi } from '@/lib/server-api';
import type { Company, DividendPage } from '@/lib/api';
import { th } from '@/i18n/th';

// ประกาศ/จ่ายเงินปันผล (บริษัทจำกัด · docs/phase7-spec.md ข้อ 1)
export default async function DividendsPage({ params }: { params: Promise<{ companyId: string }> }) {
  const { companyId } = await params;
  const [company, data] = await Promise.all([
    serverApi<Company>(`/companies/${companyId}`),
    serverApi<DividendPage>(`/companies/${companyId}/dividends`),
  ]);
  const t = th.dividends;
  return (
    <div className="flex min-h-full flex-col gap-4 p-4 sm:p-6">
      <div className="border-b-2 border-ink pb-2.5">
        <h1 className="font-doc text-[20px] font-bold sm:text-2xl">{t.title} {company.name}</h1>
      </div>
      <p className="max-w-3xl text-sm text-ink2">{t.note}</p>
      {data.entityType !== 'company' ? <p role="status" className="border border-rule-strong bg-band px-4 py-2.5">{t.onlyCompany}</p>
        : <Dividends companyId={companyId} data={data} />}
    </div>
  );
}
