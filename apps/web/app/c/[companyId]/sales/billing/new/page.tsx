import { BillingNoteForm } from '@/components/salesflow/BillingNoteForm';
import { serverApi } from '@/lib/server-api';
import type { SalesFormData } from '@/lib/api';
import { th } from '@/i18n/th';

export default async function NewBillingNote({ params }: { params: Promise<{ companyId: string }> }) {
  const { companyId } = await params;
  const form = await serverApi<SalesFormData>(`/companies/${companyId}/sales/form`);
  return (
    <div className="flex flex-col gap-4 p-4 sm:p-6">
      <div className="border-b-2 border-ink pb-2.5">
        <h1 className="font-doc text-[20px] font-bold sm:text-2xl">{th.billing.new} {form.company.name}</h1>
        <p className="text-sm text-ink2">{th.billing.note}</p>
      </div>
      <BillingNoteForm companyId={companyId} form={form} />
    </div>
  );
}
