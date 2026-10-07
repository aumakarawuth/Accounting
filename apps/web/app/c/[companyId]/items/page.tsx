import { Items } from '@/components/Items';
import { serverApi } from '@/lib/server-api';
import type { ChartRow, Company, Item } from '@/lib/api';
import { th } from '@/i18n/th';

export default async function ItemsPage({ params }: { params: Promise<{ companyId: string }> }) {
  const { companyId } = await params;
  const [company, items, chart] = await Promise.all([
    serverApi<Company>(`/companies/${companyId}`),
    serverApi<Item[]>(`/companies/${companyId}/items`),
    serverApi<ChartRow[]>(`/companies/${companyId}/chart`),
  ]);
  return (
    <div className="flex max-w-4xl flex-col gap-4 p-4 sm:p-6">
      <div className="border-b-2 border-ink pb-2.5">
        <h1 className="font-doc text-[20px] font-bold sm:text-2xl">{th.items.title} {company.name}</h1>
      </div>
      {company.locked && <p role="status" className="border border-rule-strong bg-band px-4 py-2.5">{th.submission.lockedNote}</p>}
      {!company.can_write && <p className="text-sm text-ink2">{th.master.readOnly}</p>}
      <Items companyId={companyId} initial={items} chart={chart} editable={company.can_write && !company.locked} />
    </div>
  );
}
