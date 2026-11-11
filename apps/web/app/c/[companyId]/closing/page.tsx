import Link from 'next/link';
import { PeriodTable } from '@/components/PeriodTable';
import { YearEndPanel } from '@/components/YearEndPanel';
import { serverApi } from '@/lib/server-api';
import type { Company, FiscalYears, Periods } from '@/lib/api';
import { th } from '@/i18n/th';

export default async function ClosingPage({ params }: { params: Promise<{ companyId: string }> }) {
  const { companyId } = await params;
  const [company, periods, years] = await Promise.all([
    serverApi<Company>(`/companies/${companyId}`),
    serverApi<Periods>(`/companies/${companyId}/periods`),
    serverApi<FiscalYears>(`/companies/${companyId}/fiscal-years`),
  ]);
  return (
    <div className="flex flex-col gap-4 p-4 sm:p-6">
      <div className="border-b-2 border-ink pb-2.5">
        <h1 className="font-doc text-[20px] font-bold sm:text-2xl">{th.closing.title} {company.name}</h1>
        <p className="text-sm text-ink2">{th.closing.rule}</p>
      </div>
      {company.locked && <p role="status" className="border border-rule-strong bg-band px-4 py-2.5">{th.submission.lockedNote}</p>}
      <section className="flex flex-col gap-2 border border-rule-strong bg-paper p-4">
        <p className="text-[15px]">{th.closing.adjustNote}</p>
        {company.can_write && !company.locked && (
          <Link href={`/c/${companyId}/journal/new?adjusting=1`} className="inline-flex min-h-11 items-center self-start text-[15px] underline">
            {th.closing.newAdjust}
          </Link>
        )}
      </section>
      <PeriodTable companyId={companyId} data={periods} linkJournal />
      <YearEndPanel companyId={companyId} data={years} teacher={!company.can_write} />
    </div>
  );
}
