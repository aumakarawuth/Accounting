'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { studentNav } from '@/components/Nav';
import { LogoutButton } from '@/components/LogoutButton';
import { th } from '@/i18n/th';

// "เมนูทั้งหมด" บนมือถือ: ทุกเมนู + ออกจากระบบ
export default function AllMenu() {
  const { companyId } = useParams<{ companyId: string }>() ?? { companyId: '' };
  return (
    <nav aria-label="เมนูทั้งหมด" className="flex flex-col pb-6">
      {studentNav(companyId).map((g, i) => (
        <div key={i}>
          {g.title && <h2 className="bg-band px-4 py-2 text-[13px] font-semibold text-ink2">{g.title}</h2>}
          {g.items.map((it) => (
            <Link key={it.href} href={it.href} className="flex min-h-12 items-center border-b border-rule bg-paper px-4">
              {it.label}
            </Link>
          ))}
        </div>
      ))}
      <Link href="/join" className="flex min-h-12 items-center border-b border-rule bg-paper px-4">{th.join.title}</Link>
      <div className="px-4 pt-4"><LogoutButton /></div>
    </nav>
  );
}
