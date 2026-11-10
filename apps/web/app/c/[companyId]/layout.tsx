import { notFound } from 'next/navigation';
import { Topbar } from '@/components/Topbar';
import { SideNav, BottomTabs } from '@/components/Nav';
import { PresenceReporter } from '@/components/PresenceReporter';
import { ExamClock } from '@/components/exercises/ExamClock';
import { DemoScale } from '@/components/exercises/DemoScale';
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
  // ผู้ใช้กับบริษัทดึงพร้อมกัน (ไม่ต้องรอกันทีละคำขอ) · หน้าลูกที่ใช้ /companies/:id ได้ผลเดียวกันจาก cache ของ serverApi
  const companyReq = serverApi<Company>(`/companies/${companyId}`);
  companyReq.catch(() => {}); // requireMe อาจ redirect ก่อน: ไม่ให้ค้างเป็น unhandled rejection
  const me = await requireMe();
  let company: Company;
  try {
    company = await companyReq;
  } catch (e) {
    if ((e as ApiError).status === 404 || (e as ApiError).status === 400) notFound();
    throw e;
  }
  const asg = company.assignment;
  // แถบบน: โหมดของงาน (สอบ/สาธิต) แทนโหมดของบริษัท
  const mode = asg?.mode === 'exam' || asg?.mode === 'demo' ? asg.mode : company.mode;
  const clock = asg?.mode === 'exam' && asg.deadline && asg.lockReason !== 'submitted' && asg.lockReason !== 'closed';
  return (
    // พิมพ์เอกสาร: ซ่อนแถบบน/เมนู ให้เหลือแต่กระดาษ
    <div className="flex h-dvh flex-col print:block print:h-auto">
      <div className="contents print:hidden">
      <Topbar company={company.name} home={`/c/${companyId}`} month={monthLabel(todayIso())} mode={mode} work={company.mode === 'submit' ? company.status : null} user={`${me.studentCode ?? ''} ${me.displayName}`.trim()} userId={me.id} />
      {clock && <ExamClock deadline={asg.deadline!} serverNow={asg.now} />}
      {asg?.mode === 'demo' && company.can_write && <DemoScale />}
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
