import { notFound } from 'next/navigation';
import { Topbar } from '@/components/Topbar';
import { SideNav, BottomTabs } from '@/components/Nav';
import { api, type ApiError, type Company } from '@/lib/api';
import { monthLabel, todayIso } from '@/lib/date';
import { th } from '@/i18n/th';

export default async function CompanyLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ companyId: string }>;
}) {
  const { companyId } = await params;
  let company: Company;
  try {
    company = await api<Company>(`/companies/${companyId}`);
  } catch (e) {
    if ((e as ApiError).status === 404 || (e as ApiError).status === 400) notFound();
    throw e;
  }
  return (
    <div className="flex h-dvh flex-col">
      <Topbar company={company.name} month={monthLabel(todayIso())} mode="practice" status={th.topbar.saved} />
      <div className="flex min-h-0 flex-1">
        <SideNav companyId={companyId} />
        <main className="flex min-w-0 flex-1 flex-col overflow-y-auto">{children}</main>
      </div>
      <BottomTabs companyId={companyId} />
    </div>
  );
}
