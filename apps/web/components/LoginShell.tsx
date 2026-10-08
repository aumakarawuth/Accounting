import { th } from '@/i18n/th';

// พื้นเส้นบรรทัดสมุดบน iPad/คอม; มือถือเป็นแผ่นกระดาษเต็มจอ ไม่มี hero
export function LoginShell({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-paper sm:bg-ground sm:bg-[repeating-linear-gradient(to_bottom,transparent_0,transparent_31px,var(--rule-faint)_31px,var(--rule-faint)_32px)]">
      <header className="flex min-h-[52px] items-center border-b border-rule-strong bg-paper px-5 text-[15px] sm:px-6">
        <span className="font-semibold">{th.app.name}</span>
        <span className="ml-auto">{right ?? <a href="/privacy" className="text-sm underline">{th.login.privacy}</a>}</span>
      </header>
      <div className="flex flex-1 justify-center sm:items-start sm:pt-24">{children}</div>
    </div>
  );
}
