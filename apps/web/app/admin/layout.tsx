import Link from 'next/link';
import { LogoutButton } from '@/components/LogoutButton';
import { requireMe } from '@/lib/server-api';
import { th } from '@/i18n/th';

export const dynamic = 'force-dynamic';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const me = await requireMe('admin');
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex min-h-[52px] flex-wrap items-center gap-x-1 border-b border-rule-strong bg-paper px-4 text-[15px] sm:px-6 print:hidden">
        <span className="mr-4 font-semibold">{th.app.name} · {th.admin.title}</span>
        <nav aria-label={th.admin.title} className="flex">
          <Link href="/admin" className="flex min-h-11 items-center border-l border-rule px-4">{th.admin.staff} / {th.admin.classrooms}</Link>
          <Link href="/admin/audit" className="flex min-h-11 items-center border-l border-rule px-4">{th.admin.audit}</Link>
        </nav>
        <span className="ml-auto flex items-center gap-4 text-sm">{me.displayName}<LogoutButton /></span>
      </header>
      <main className="flex-1 p-4 sm:p-6 print:p-0">{children}</main>
    </div>
  );
}
