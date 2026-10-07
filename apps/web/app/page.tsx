import { redirect } from 'next/navigation';
import { getMe, serverApi } from '@/lib/server-api';
import { LoginShell } from '@/components/LoginShell';
import { LogoutButton } from '@/components/LogoutButton';
import { th } from '@/i18n/th';

export const dynamic = 'force-dynamic';

// จุดเข้า: ส่งไปหน้าที่ตรงกับบทบาท
export default async function Root() {
  const me = await getMe();
  if (!me) redirect('/login');
  if (me.mustChange) redirect('/change-password');
  if (me.role === 'teacher') redirect('/teacher');
  const companies = await serverApi<{ id: string }[]>('/me/companies');
  if (companies[0]) redirect(`/c/${companies[0].id}`);
  return (
    <LoginShell right={<LogoutButton />}>
      <p className="p-6">{th.work.noCompany}</p>
    </LoginShell>
  );
}
