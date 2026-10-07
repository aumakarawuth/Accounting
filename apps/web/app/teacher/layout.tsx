import Link from 'next/link';
import { LogoutButton } from '@/components/LogoutButton';
import { requireMe } from '@/lib/server-api';
import { th } from '@/i18n/th';

export const dynamic = 'force-dynamic';

export default async function TeacherLayout({ children }: { children: React.ReactNode }) {
  const me = await requireMe('teacher');
  return (
    <div className="flex min-h-dvh flex-col">
      {/* มือถือ: ชื่อระบบ + ผู้ใช้แถวบน เมนูเต็มความกว้างแถวล่าง (ไม่ล้นจอ) */}
      <header className="print:hidden flex flex-wrap items-center gap-x-4 border-b border-rule-strong bg-paper px-4 text-[15px] sm:px-6">
        <span className="mr-2 flex min-h-[52px] items-center font-semibold">{th.app.name} · {th.app.teacherSuffix}</span>
        <nav aria-label={th.app.teacherSuffix} className="flex max-sm:order-last max-sm:-mx-4 max-sm:w-[calc(100%+2rem)] max-sm:border-t max-sm:border-rule">
          {[['/teacher', th.teacher.classrooms], ['/teacher/live', th.live.nav], ['/teacher/submissions', th.submission.list]].map(([href, label]) => (
            <Link key={href} href={href!} className="flex min-h-11 items-center justify-center border-l border-rule px-4 max-sm:flex-1 max-sm:first:border-l-0">{label}</Link>
          ))}
        </nav>
        <span className="ml-auto text-sm">{me.displayName}</span>
        <LogoutButton />
      </header>
      <main className="flex-1 p-4 sm:p-6 print:p-0">{children}</main>
    </div>
  );
}
