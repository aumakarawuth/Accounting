import Link from 'next/link';
import { redirect } from 'next/navigation';
import { JoinRoom } from '@/components/JoinRoom';
import { LoginForm } from '@/components/LoginForm';
import { LoginShell } from '@/components/LoginShell';
import { LogoutButton } from '@/components/LogoutButton';
import { getMe } from '@/lib/server-api';
import { th } from '@/i18n/th';

// ยังไม่เข้าสู่ระบบ: ล็อกอินก่อนแล้วกลับมาที่เดิม · นักเรียน: ยืนยันเข้าห้อง · ครู/ผู้ดูแล: บอกว่าใช้ไม่ได้
export async function JoinPage({ code }: { code: string }) {
  const me = await getMe();
  const path = code ? `/join/${encodeURIComponent(code)}` : '/join';
  if (!me) {
    return (
      <LoginShell>
        <div className="flex w-full flex-col sm:w-[420px]">
          {code && <p role="note" className="border-b border-rule-strong bg-band px-5 py-3 text-[15px] sm:border sm:border-b-0">{th.join.loginFirst(code.toUpperCase())}</p>}
          <LoginForm kind="student" next={path} />
        </div>
      </LoginShell>
    );
  }
  if (me.mustChange) redirect('/change-password');
  const right = <span className="flex items-center gap-4 text-sm">{me.studentCode ?? ''} {me.displayName}<LogoutButton /></span>;
  return (
    <LoginShell right={right}>
      {me.role === 'student' ? <JoinRoom initial={code} /> : (
        <div className="flex flex-col gap-3 px-5 py-6 sm:w-[420px] sm:border sm:border-rule-strong sm:bg-paper sm:px-8">
          <p>{th.join.studentsOnly}</p>
          <Link href="/" className="flex min-h-11 items-center underline">{th.join.home}</Link>
        </div>
      )}
    </LoginShell>
  );
}
