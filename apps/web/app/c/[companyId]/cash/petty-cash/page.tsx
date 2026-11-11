import { PettyCash } from '@/components/cash/PettyCash';
import { serverApi } from '@/lib/server-api';
import type { PettyCashPage } from '@/lib/api';
import { th } from '@/i18n/th';

// เงินสดย่อยระบบวงเงินคงที่ (docs/phase5-spec.md ข้อ 9)
export default async function PettyCashPageView({ params }: { params: Promise<{ companyId: string }> }) {
  const { companyId } = await params;
  const data = await serverApi<PettyCashPage>(`/companies/${companyId}/petty-cash`);
  const t = th.pettyCash;
  return (
    <div className="flex min-h-full flex-col gap-4 p-4 sm:p-6">
      <div className="border-b-2 border-ink pb-2.5">
        <h1 className="font-doc text-[20px] font-bold sm:text-2xl">{t.title} {data.company.name}</h1>
      </div>
      <p className="max-w-3xl text-sm text-ink2">{t.note}</p>
      <PettyCash companyId={companyId} data={data} />
    </div>
  );
}
