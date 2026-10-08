import { JournalForm } from '@/components/JournalForm';
import type { Account, Company } from '@/lib/api';
import { serverApi } from '@/lib/server-api';

export default async function NewJournal({ params }: { params: Promise<{ companyId: string }> }) {
  const { companyId } = await params;
  const [accounts, company] = await Promise.all([
    serverApi<Account[]>(`/companies/${companyId}/accounts`),
    serverApi<Company>(`/companies/${companyId}`),
  ]);
  return <JournalForm companyId={companyId} accounts={accounts} locked={company.locked || !company.can_write} />;
}
