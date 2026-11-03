import Link from 'next/link';
import { ChequeRegister } from '@/components/cheques/ChequeRegister';
import { serverApi } from '@/lib/server-api';
import type { ChequePage } from '@/lib/api';
import { th } from '@/i18n/th';

// ทะเบียนเช็ค: ?dir=received (ค่าเริ่มต้น) | paid
export default async function Cheques({
  params, searchParams,
}: { params: Promise<{ companyId: string }>; searchParams: Promise<{ dir?: string }> }) {
  const { companyId } = await params;
  const dir = (await searchParams).dir === 'paid' ? 'paid' : 'received';
  const data = await serverApi<ChequePage>(`/companies/${companyId}/cheques`);
  const t = th.cheques;
  const tab = 'flex min-h-11 items-center border border-ink px-4 font-medium aria-[current=page]:bg-ink aria-[current=page]:text-paper max-sm:flex-1 max-sm:justify-center';
  return (
    <div className="flex min-h-full flex-col gap-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-end gap-3 border-b-2 border-ink pb-2.5">
        <h1 className="min-w-0 font-doc text-[20px] font-bold sm:text-2xl">{t.title} {data.company.name}</h1>
        <nav aria-label={t.title} className="flex w-full sm:ml-auto sm:w-auto">
          <Link href={`/c/${companyId}/cheques`} aria-current={dir === 'received' ? 'page' : undefined} className={tab}>{t.received}</Link>
          <Link href={`/c/${companyId}/cheques?dir=paid`} aria-current={dir === 'paid' ? 'page' : undefined} className={`${tab} border-l-0`}>{t.paid}</Link>
        </nav>
      </div>
      <ChequeRegister key={dir} companyId={companyId} data={data} dir={dir} />
    </div>
  );
}
