import { AgingView, parseAsOf } from '@/components/docs/AgingView';
import { serverApi } from '@/lib/server-api';
import type { Company, Receivables } from '@/lib/api';
import { th } from '@/i18n/th';

export default async function ReceivablesPage({
  params, searchParams,
}: { params: Promise<{ companyId: string }>; searchParams: Promise<{ asOf?: string }> }) {
  const { companyId } = await params;
  const asOf = parseAsOf((await searchParams).asOf);
  const [company, r] = await Promise.all([
    serverApi<Company>(`/companies/${companyId}`),
    serverApi<Receivables>(`/companies/${companyId}/receivables${asOf ? `?asOf=${asOf}` : ''}`),
  ]);
  return <AgingView base={`/c/${companyId}`} title={`${th.sales.receivablesTitle} ${company.name}`} r={r} area="sales" party={th.sales.customer} empty={th.sales.noReceivables} />;
}
