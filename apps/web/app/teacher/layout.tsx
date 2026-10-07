import Link from 'next/link';
import { LogoutButton } from '@/components/LogoutButton';
import { requireMe } from '@/lib/server-api';
import { th } from '@/i18n/th';

export const dynamic = 'force-dynamic';

export default async function TeacherLayout({ children }: { children: React.ReactNode }) {
  const me = await requireMe('teacher');
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="print:hidden flex min-h-[52px] items-center gap-4 border-b border-rule-strong bg-paper px-4 text-[15px] sm:px-6">
        <span className="mr-2 font-semibold">{th.app.name} · {th.app.teacherSuffix}</span>
        <nav aria-label={th.app.teacherSuffix} className="flex">
          <Link href="/teacher" className="flex min-h-11 items-center border-l border-rule px-4">{th.teacher.classrooms}</Link>
          <Link href="/teacher/submissions" className="flex min-h-11 items-center border-l border-rule px-4">{th.submission.list}</Link>
        </nav>
        <span className="ml-auto text-sm">{me.displayName}</span>
        <LogoutButton />
      </header>
      <main className="flex-1 p-4 sm:p-6 print:p-0">{children}</main>
    </div>
  );
}
