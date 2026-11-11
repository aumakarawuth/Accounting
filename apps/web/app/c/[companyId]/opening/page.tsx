import { OpeningBalances } from '@/components/OpeningBalances';
import { serverApi } from '@/lib/server-api';
import type { Company, OpeningData } from '@/lib/api';
import { th } from '@/i18n/th';

export default async function OpeningPage({ params }: { params: Promise<{ companyId: string }> }) {
  const { companyId } = await params;
  const [company, data] = await Promise.all([
    serverApi<Company>(`/companies/${companyId}`),
    serverApi<OpeningData>(`/companies/${companyId}/opening`),
  ]);
  return (
    <div className="flex flex-col gap-4 p-4 pb-28 sm:p-6 sm:pb-28">
      <div className="border-b-2 border-ink pb-2.5">
        <h1 className="font-doc text-[20px] font-bold sm:text-2xl">{th.opening.title} {company.name}</h1>
        <p className="text-sm text-ink2">{th.opening.note}</p>
      </div>
      {company.locked && <p role="status" className="border border-rule-strong bg-band px-4 py-2.5">{th.submission.lockedNote}</p>}
      <OpeningBalances companyId={companyId} data={data} />
    </div>
  );
}
