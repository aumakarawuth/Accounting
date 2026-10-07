import { LogoutButton } from '@/components/LogoutButton';
import { requireMe } from '@/lib/server-api';
import { th } from '@/i18n/th';

export const dynamic = 'force-dynamic';

export default async function TeacherLayout({ children }: { children: React.ReactNode }) {
  const me = await requireMe('teacher');
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex min-h-[52px] items-center gap-4 border-b border-rule-strong bg-paper px-4 text-[15px] sm:px-6">
        <span className="font-semibold">{th.app.name} · {th.app.teacherSuffix}</span>
        <span className="ml-auto text-sm">{me.displayName}</span>
        <LogoutButton />
      </header>
      <main className="flex-1 p-4 sm:p-6">{children}</main>
    </div>
  );
}
