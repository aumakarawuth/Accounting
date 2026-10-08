'use client';

import { useEffect, useState } from 'react';
import { onDraftSaved } from '@/lib/drafts';
import { th } from '@/i18n/th';

const hhmm = (t: number) => new Date(t).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });

// สถานะบันทึกที่แถบบน: ออฟไลน์ > ร่างเพิ่งเก็บในเครื่อง > ทุกอย่างบันทึกแล้ว (ไม่ใช้สีอย่างเดียวบอกสถานะ)
export function SaveStatus({ className = '' }: { className?: string }) {
  const [online, setOnline] = useState(true);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  useEffect(() => {
    const sync = () => setOnline(navigator.onLine);
    sync();
    window.addEventListener('online', sync);
    window.addEventListener('offline', sync);
    const off = onDraftSaved(setSavedAt);
    return () => { window.removeEventListener('online', sync); window.removeEventListener('offline', sync); off(); };
  }, []);
  const text = !online ? th.topbar.offline : savedAt ? th.topbar.draftSaved(hhmm(savedAt)) : th.topbar.saved;
  return <span role="status" className={`${className} ${online ? '' : 'font-semibold text-ink'}`}>{text}</span>;
}
