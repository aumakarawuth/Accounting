import Link from 'next/link';
import type { Metadata } from 'next';
import { LoginShell } from '@/components/LoginShell';
import { th } from '@/i18n/th';

export const metadata: Metadata = { title: th.privacy.title };

// หน้านอกเมนู เปิดได้โดยไม่ต้องล็อกอิน (PLAN.md ข้อ 5 PDPA, ข้อ 9)
export default function PrivacyPage() {
  const p = th.privacy;
  return (
    <LoginShell right={<Link href="/login" className="text-sm underline">{p.back}</Link>}>
      <article className="flex w-full max-w-2xl flex-col gap-5 bg-paper px-5 py-6 sm:mb-16 sm:border sm:border-rule-strong sm:px-8 sm:py-8">
        <header className="flex flex-col gap-1 border-b-2 border-ink pb-2.5">
          <h1 className="font-doc text-[22px] font-bold sm:text-2xl">{p.title}</h1>
          <p className="text-sm text-ink2">{p.updated}</p>
        </header>
        <p role="note" className="border border-rule-strong bg-band px-4 py-2.5 text-[15px]">{p.draft}</p>
        {p.sections.map((s) => (
          <section key={s.h} className="flex flex-col gap-2">
            <h2 className="text-[17px] font-semibold">{s.h}</h2>
            <ul className="flex list-disc flex-col gap-1.5 pl-5 text-[15px] leading-relaxed">
              {s.p.map((t) => <li key={t}>{t}</li>)}
            </ul>
          </section>
        ))}
      </article>
    </LoginShell>
  );
}
