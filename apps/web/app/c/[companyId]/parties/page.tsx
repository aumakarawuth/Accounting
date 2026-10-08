import { Parties } from '@/components/Parties';
import { serverApi } from '@/lib/server-api';
import type { Company, Party } from '@/lib/api';
import { th } from '@/i18n/th';

export default async function PartiesPage({ params }: { params: Promise<{ companyId: string }> }) {
  const { companyId } = await params;
  const [company, parties] = await Promise.all([
    serverApi<Company>(`/companies/${companyId}`),
    serverApi<Party[]>(`/companies/${companyId}/parties`),
  ]);
  return (
    <div className="flex max-w-4xl flex-col gap-4 p-4 sm:p-6">
      <div className="border-b-2 border-ink pb-2.5">
        <h1 className="font-doc text-[20px] font-bold sm:text-2xl">{th.parties.title} {company.name}</h1>
        <p className="text-sm text-ink2">{th.parties.note}</p>
      </div>
      {company.locked && <p role="status" className="border border-rule-strong bg-band px-4 py-2.5">{th.submission.lockedNote}</p>}
      {!company.can_write && <p className="text-sm text-ink2">{th.master.readOnly}</p>}
      <Parties companyId={companyId} initial={parties} editable={company.can_write && !company.locked} />
    </div>
  );
}
