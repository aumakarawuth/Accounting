import { FixedAssets } from '@/components/assets/FixedAssets';
import { MonthNav } from '@/components/MonthNav';
import { serverApi } from '@/lib/server-api';
import type { AssetPage } from '@/lib/api';
import { isMonth, monthLabel, todayIso } from '@/lib/date';
import { th } from '@/i18n/th';

// ทะเบียนทรัพย์สิน ณ สิ้นเดือน (?month=YYYY-MM): ราคาทุน ค่าเสื่อมเดือนนี้ ค่าเสื่อมสะสม มูลค่าตามบัญชี
export default async function FixedAssetsPage({
  params, searchParams,
}: { params: Promise<{ companyId: string }>; searchParams: Promise<{ month?: string }> }) {
  const { companyId } = await params;
  const sp = await searchParams;
  const month = isMonth(sp.month) ? sp.month : todayIso().slice(0, 7);
  const data = await serverApi<AssetPage>(`/companies/${companyId}/fixed-assets?month=${month}`);
  return (
    <div className="flex min-h-full flex-col gap-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-end gap-3 border-b-2 border-ink pb-2.5">
        <h1 className="min-w-0 font-doc text-[20px] font-bold sm:text-2xl">{th.assets.title} {data.company.name} · {th.assets.asOf(monthLabel(month))}</h1>
        <div className="sm:ml-auto print:hidden"><MonthNav month={month} href={(m) => `/c/${companyId}/fixed-assets?month=${m}`} /></div>
      </div>
      <FixedAssets key={month} companyId={companyId} data={data} />
    </div>
  );
}
