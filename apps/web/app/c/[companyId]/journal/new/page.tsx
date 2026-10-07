import { JournalForm } from '@/components/JournalForm';
import { api, type Account } from '@/lib/api';

export default async function NewJournal({ params }: { params: Promise<{ companyId: string }> }) {
  const { companyId } = await params;
  const accounts = await api<Account[]>(`/companies/${companyId}/accounts`);
  return <JournalForm companyId={companyId} accounts={accounts} />;
}
