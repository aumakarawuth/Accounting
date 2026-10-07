import Link from 'next/link';
import { MonthNav } from '@/components/MonthNav';
import { StatementsView } from '@/components/reports/StatementsView';
import { serverApi } from '@/lib/server-api';
import type { Company, Statements } from '@/lib/api';
import { isMonth, todayIso } from '@/lib/date';
import { th } from '@/i18n/th';

export default async function StatementsPage({
  params, searchParams,
}: { params: Promise<{ companyId: string }>; searchParams: Promise<{ month?: string; scope?: string }> }) {
  const { companyId } = await params;
  const sp = await searchParams;
  const month = isMonth(sp.month) ? sp.month : todayIso().slice(0, 7);
  const scope = sp.scope === 'month' ? 'month' : 'ytd';
  const [company, st] = await Promise.all([
    serverApi<Company>(`/companies/${companyId}`),
    serverApi<Statements>(`/companies/${companyId}/statements?month=${month}&scope=${scope}`),
  ]);
  const href = (m: string, s = scope) => `/c/${companyId}/statements?month=${m}&scope=${s}`;
  const tab = 'flex min-h-11 items-center border border-rule-strong px-4 aria-[current=page]:bg-ink aria-[current=page]:text-paper';
  return (
    <div className="flex flex-col gap-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-end gap-3 border-b-2 border-ink pb-2.5">
        <h1 className="font-doc text-[20px] font-bold sm:text-2xl">{th.statements.title}</h1>
        <div className="flex flex-wrap items-center gap-3 sm:ml-auto">
          <nav aria-label={th.statements.income} className="flex">
            <Link href={href(month, 'month')} aria-current={scope === 'month' ? 'page' : undefined} className={tab}>{th.statements.scopeMonth}</Link>
            <Link href={href(month, 'ytd')} aria-current={scope === 'ytd' ? 'page' : undefined} className={`${tab} border-l-0`}>{th.statements.scopeYtd}</Link>
          </nav>
          <MonthNav month={month} href={(m) => href(m)} />
        </div>
      </div>
      <StatementsView st={st} company={company.name} />
    </div>
  );
}
