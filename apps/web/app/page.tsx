import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getMe, serverApi } from '@/lib/server-api';
import { LoginShell } from '@/components/LoginShell';
import { LogoutButton } from '@/components/LogoutButton';
import type { MyCompany } from '@/lib/api';
import { th } from '@/i18n/th';

export const dynamic = 'force-dynamic';

// จุดเข้า: ส่งไปหน้าที่ตรงกับบทบาท
export default async function Root() {
  const me = await getMe();
  if (!me) redirect('/login');
  if (me.mustChange) redirect('/change-password');
  if (me.role === 'teacher') redirect('/teacher');
  if (me.role === 'admin') redirect('/admin');
  const companies = await serverApi<MyCompany[]>('/me/companies');
  if (companies.length === 1) redirect(`/c/${companies[0]!.id}`);
  return (
    <LoginShell right={<span className="flex items-center gap-4 text-sm">{me.studentCode} {me.displayName}<LogoutButton /></span>}>
      {companies.length === 0 ? (
        <div className="flex flex-col gap-3 p-6">
          <p>{th.work.noCompany}</p>
          <Link href="/join" className="flex min-h-11 items-center underline">{th.join.title}</Link>
        </div>
      ) : (
        <nav aria-label={th.company.choose} className="flex w-full flex-col gap-3 px-5 py-6 sm:w-[480px] sm:border sm:border-rule-strong sm:bg-paper sm:px-8">
          <h1 className="border-b-2 border-ink pb-2.5 font-doc text-[22px] font-bold">{th.company.choose}</h1>
          <ul>
            {companies.map((c) => (
              <li key={c.id}>
                <Link href={`/c/${c.id}`} className="flex min-h-12 flex-col justify-center border-b border-rule py-2">
                  <span>{c.name}</span>
                  {c.classroom && <span className="text-[13px] text-ink2">{th.company.classroom(c.classroom)}</span>}
                </Link>
              </li>
            ))}
          </ul>
          <Link href="/join" className="flex min-h-11 items-center text-sm underline">{th.join.title}</Link>
        </nav>
      )}
    </LoginShell>
  );
}
