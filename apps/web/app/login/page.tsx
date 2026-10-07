import { th } from '@/i18n/th';

// หน้าล็อกอินเรียบ ไม่มี hero (การยืนยันตัวตนจริงมาในเฟส 1: POST /api/auth/login)
export default function LoginPage() {
  const input = 'h-12 w-full rounded-doc border border-rule-input bg-paper px-3 text-base';
  return (
    <div className="flex min-h-dvh flex-col bg-paper sm:bg-ground sm:bg-[repeating-linear-gradient(to_bottom,transparent_0,transparent_31px,var(--rule-faint)_31px,var(--rule-faint)_32px)]">
      <header className="flex min-h-[52px] items-center border-b border-rule-strong bg-paper px-5 text-[15px] sm:px-6">
        <span className="font-semibold">{th.app.name}</span>
        <a href="/privacy" className="ml-auto text-sm underline max-sm:hidden">{th.login.privacy}</a>
      </header>
      <div className="flex flex-1 justify-center sm:items-start sm:pt-24">
        <form method="post" action="/api/auth/login" className="flex w-full flex-col gap-4 px-5 py-6 sm:w-[420px] sm:border sm:border-rule-strong sm:bg-paper sm:px-8 sm:py-7">
          <div className="border-b-2 border-ink pb-2.5">
            <h1 className="font-doc text-[22px] font-bold">{th.login.title}</h1>
            <p className="text-sm text-ink2">{th.login.studentHint}</p>
          </div>
          <label className="flex flex-col gap-1 text-sm">
            {th.login.studentCode}
            <input name="student_code" className={`${input} font-num`} inputMode="numeric" autoComplete="username" required />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {th.login.password}
            <input name="password" type="password" className={input} autoComplete="current-password" required />
          </label>
          <button type="submit" className="min-h-12 rounded-doc bg-ink px-5 font-medium text-paper max-sm:min-h-13">
            {th.login.submit}
          </button>
          <p className="border-t border-rule pt-3 text-sm text-ink2">{th.login.forgotStudent}</p>
          <a href="/login/staff" className="flex min-h-11 items-center text-sm underline">{th.login.staffLink}</a>
          <a href="/privacy" className="flex min-h-11 items-center text-sm underline sm:hidden">{th.login.privacy}</a>
        </form>
      </div>
    </div>
  );
}
