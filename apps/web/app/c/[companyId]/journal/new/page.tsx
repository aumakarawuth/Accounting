import { JournalForm } from '@/components/JournalForm';
import type { Account, Company } from '@/lib/api';
import { serverApi } from '@/lib/server-api';

export default async function NewJournal({
  params, searchParams,
}: { params: Promise<{ companyId: string }>; searchParams: Promise<{ adjusting?: string }> }) {
  const { companyId } = await params;
  const adjusting = (await searchParams).adjusting === '1';
  const [accounts, company] = await Promise.all([
    serverApi<Account[]>(`/companies/${companyId}/accounts`),
    serverApi<Company>(`/companies/${companyId}`),
  ]);
  // key: สลับรายการปกติ/ปรับปรุงแล้วฟอร์มเริ่มใหม่ (ร่างแยกกัน)
  return <JournalForm key={adjusting ? 'aj' : 'jv'} companyId={companyId} accounts={accounts} locked={company.locked || !company.can_write} adjusting={adjusting} />;
}
