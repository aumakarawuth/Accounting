'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { heartbeat, setPage, type Page } from '@/lib/presence';

const PAGES: Page[] = ['journal', 'ledger', 'trial-balance', 'statements', 'accounts', 'closing', 'menu'];

export function PresenceReporter({ companyId }: { companyId: string }) {
  const path = usePathname() ?? ''; // มีโฟลเดอร์ pages/ (API ฝังบน Vercel) ชนิดจึงเป็น null ได้
  useEffect(() => {
    const seg = path.split('/')[3] as Page | undefined;
    setPage(companyId, !seg ? 'home' : PAGES.includes(seg) ? seg : 'other');
  }, [path, companyId]);
  useEffect(() => {
    const t = setInterval(heartbeat, 20_000);
    const onVisible = () => document.visibilityState === 'visible' && heartbeat();
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVisible); };
  }, []);
  return null;
}
