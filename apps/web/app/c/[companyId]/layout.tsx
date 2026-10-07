import { notFound } from 'next/navigation';
import { Topbar } from '@/components/Topbar';
import { SideNav, BottomTabs } from '@/components/Nav';
import { PresenceReporter } from '@/components/PresenceReporter';
import type { ApiError, Company } from '@/lib/api';
import { requireMe, serverApi } from '@/lib/server-api';
import { monthLabel, todayIso } from '@/lib/date';

export default async function CompanyLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ companyId: string }>;
}) {
  const { companyId } = await params;
  const me = await requireMe();
  let company: Company;
  try {
    company = await serverApi<Company>(`/companies/${companyId}`);
  } catch (e) {
    if ((e as ApiError).status === 404 || (e as ApiError).status === 400) notFound();
    throw e;
  }
  return (
    // พิมพ์เอกสาร: ซ่อนแถบบน/เมนู ให้เหลือแต่กระดาษ
    <div className="flex h-dvh flex-col print:block print:h-auto">
      <div className="contents print:hidden">
      <Topbar company={company.name} month={monthLabel(todayIso())} mode={company.mode} work={company.mode === 'submit' ? company.status : null} user={`${me.studentCode ?? ''} ${me.displayName}`.trim()} userId={me.id} />
      </div>
      <div className="flex min-h-0 flex-1 print:block">
        <div className="contents print:hidden"><SideNav companyId={companyId} /></div>
        <main className="flex min-w-0 flex-1 flex-col overflow-y-auto print:overflow-visible">{children}</main>
      </div>
      <div className="contents print:hidden"><BottomTabs companyId={companyId} /></div>
      {company.can_write && <PresenceReporter companyId={companyId} />}
    </div>
  );
}
