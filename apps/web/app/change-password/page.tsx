import { redirect } from 'next/navigation';
import { ChangePasswordForm } from '@/components/ChangePasswordForm';
import { LoginShell } from '@/components/LoginShell';
import { LogoutButton } from '@/components/LogoutButton';
import { getMe } from '@/lib/server-api';

export const dynamic = 'force-dynamic';

export default async function ChangePassword() {
  const me = await getMe();
  if (!me) redirect('/login');
  return (
    <LoginShell right={<span className="flex items-center gap-4 text-sm">{me.studentCode ?? ''} {me.displayName}<LogoutButton /></span>}>
      <ChangePasswordForm mustChange={me.mustChange} studentCode={me.studentCode} />
    </LoginShell>
  );
}
