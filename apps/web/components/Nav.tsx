'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { th } from '@/i18n/th';

type Item = { label: string; href: string };
type Group = { title?: string; items: Item[] };

export function studentNav(companyId: string): Group[] {
  const c = (p: string) => `/c/${companyId}${p}`;
  const n = th.nav;
  return [
    { items: [{ label: n.home, href: c('') }] },
    { title: n.group.gl, items: [
      { label: n.chartOfAccounts, href: c('/accounts') },
      { label: n.journal, href: c('/journal/new') },
      { label: n.ledger, href: c('/ledger') },
      { label: n.trialBalance, href: c('/trial-balance') },
      { label: n.statements, href: c('/statements') },
      { label: n.closing, href: c('/closing') },
    ] },
    { title: n.group.sales, items: [
      { label: n.taxInvoice, href: c('/sales/invoices') },
      { label: n.receipt, href: c('/sales/receipts') },
      { label: n.receivables, href: c('/sales/receivables') },
    ] },
    { title: n.group.purchase, items: [
      { label: n.purchase, href: c('/purchases') },
      { label: n.payment, href: c('/purchases/payments') },
    ] },
    { title: n.group.other, items: [
      { label: n.reports, href: c('/reports') },
      { label: n.myWork, href: c('/work') },
      { label: n.settings, href: c('/settings') },
    ] },
  ];
}

function isActive(path: string, href: string) {
  return href.split('/').length <= 3 ? path === href : path.startsWith(href.replace(/\/new$/, ''));
}

/** แถบข้าง (iPad/คอม) */
export function SideNav({ companyId }: { companyId: string }) {
  const path = usePathname();
  return (
    <nav aria-label="เมนูหลัก" className="hidden w-[220px] shrink-0 overflow-y-auto border-r border-rule-strong bg-band py-1 sm:block lg:w-[232px]">
      {studentNav(companyId).map((g, i) => (
        <div key={i}>
          {g.title && <h3 className="mx-4 mt-3.5 mb-0.5 text-[13px] font-semibold text-ink2">{g.title}</h3>}
          {g.items.map((it) => (
            <Link
              key={it.href}
              href={it.href}
              aria-current={isActive(path, it.href) ? 'page' : undefined}
              className="flex min-h-11 items-center px-4 text-[15px] aria-[current=page]:bg-ink aria-[current=page]:text-paper lg:min-h-9"
            >
              {it.label}
            </Link>
          ))}
        </div>
      ))}
    </nav>
  );
}

/** แถบล่าง (มือถือ) 5 ช่อง */
export function BottomTabs({ companyId }: { companyId: string }) {
  const path = usePathname();
  const c = (p: string) => `/c/${companyId}${p}`;
  const tabs: Item[] = [
    { label: th.nav.home, href: c('') },
    { label: th.nav.journal, href: c('/journal/new') },
    { label: th.nav.reports, href: c('/reports') },
    { label: th.nav.myWork, href: c('/work') },
    { label: th.nav.all, href: c('/menu') },
  ];
  return (
    <nav aria-label="เมนูหลัก" className="flex border-t border-rule-strong bg-paper pb-[env(safe-area-inset-bottom)] sm:hidden">
      {tabs.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          aria-current={isActive(path, t.href) ? 'page' : undefined}
          className="flex min-h-14 flex-1 items-center justify-center border-t-[3px] border-transparent px-1 text-center text-[13px] leading-tight aria-[current=page]:border-ink aria-[current=page]:font-semibold"
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
