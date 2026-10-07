import { JournalForm } from '@/components/JournalForm';
import type { Account } from '@/lib/api';
import { serverApi } from '@/lib/server-api';

export default async function NewJournal({ params }: { params: Promise<{ companyId: string }> }) {
  const { companyId } = await params;
  const accounts = await serverApi<Account[]>(`/companies/${companyId}/accounts`);
  return <JournalForm companyId={companyId} accounts={accounts} />;
}
