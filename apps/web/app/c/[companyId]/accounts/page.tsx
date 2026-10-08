import { ChartOfAccounts } from '@/components/ChartOfAccounts';
import { serverApi } from '@/lib/server-api';
import type { ChartRow, Company } from '@/lib/api';
import { th } from '@/i18n/th';

export default async function AccountsPage({ params }: { params: Promise<{ companyId: string }> }) {
  const { companyId } = await params;
  const [company, chart] = await Promise.all([
    serverApi<Company>(`/companies/${companyId}`),
    serverApi<ChartRow[]>(`/companies/${companyId}/chart`),
  ]);
  const editable = company.can_write && !company.locked;
  return (
    <div className="flex flex-col gap-4 p-4 sm:p-6">
      <div className="border-b-2 border-ink pb-2.5">
        <h1 className="font-doc text-[20px] font-bold sm:text-2xl">{th.accounts.title} {company.name}</h1>
        <p className="text-sm text-ink2">{th.accounts.note}</p>
      </div>
      {company.locked && <p role="status" className="border border-rule-strong bg-band px-4 py-2.5">{th.submission.lockedNote}</p>}
      {!company.can_write && <p className="text-sm text-ink2">{th.accounts.readOnly}</p>}
      <ChartOfAccounts companyId={companyId} initial={chart} editable={editable} />
    </div>
  );
}
