import { AgingView, parseAsOf } from '@/components/docs/AgingView';
import { serverApi } from '@/lib/server-api';
import type { Company, Payables } from '@/lib/api';
import { th } from '@/i18n/th';

export default async function PayablesPage({
  params, searchParams,
}: { params: Promise<{ companyId: string }>; searchParams: Promise<{ asOf?: string }> }) {
  const { companyId } = await params;
  const asOf = parseAsOf((await searchParams).asOf);
  const [company, r] = await Promise.all([
    serverApi<Company>(`/companies/${companyId}`),
    serverApi<Payables>(`/companies/${companyId}/payables${asOf ? `?asOf=${asOf}` : ''}`),
  ]);
  return <AgingView base={`/c/${companyId}`} title={`${th.purchases.payablesTitle} ${company.name}`} r={r} area="purchases" party={th.purchases.vendor} empty={th.purchases.noPayables} />;
}
