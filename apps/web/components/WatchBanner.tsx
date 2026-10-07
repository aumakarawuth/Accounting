'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { subscribe } from '@/lib/realtime';
import { th } from '@/i18n/th';

type Watch = { name: string; until: number };
const TTL = 45_000; // ครูส่งสัญญาณทุก 15 วินาที ไม่มีสัญญาณ 45 วินาทีถือว่าเลิกดู

// ป้าย "ครูกำลังดูอยู่" ที่แถบบน (ไม่ใช่ popup) แจ้งนักเรียนทุกครั้งที่ครูดูสด
export function WatchBanner({ userId }: { userId: string }) {
  const [watches, setWatches] = useState<Record<string, Watch>>({});
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    api<{ id: string; teacherName: string }[]>('/me/watchers')
      .then((ws) => setWatches(Object.fromEntries(ws.map((w) => [w.id, { name: w.teacherName, until: Date.now() + TTL }]))))
      .catch(() => {});
    const unsub = subscribe(`student:${userId}`, (e) => {
      const id = String(e.id);
      if (e.k === 'watch') setWatches((w) => ({ ...w, [id]: { name: String(e.by), until: Date.now() + TTL } }));
      if (e.k === 'unwatch') setWatches(({ [id]: _, ...rest }) => rest);
    });
    const t = setInterval(() => setNow(Date.now()), 5_000);
    return () => { unsub(); clearInterval(t); };
  }, [userId]);

  const names = [...new Set(Object.values(watches).filter((w) => w.until > now).map((w) => w.name))];
  if (names.length === 0) return null;
  return (
    <span role="status" className="flex items-center gap-2 text-sm sm:ml-auto sm:border-l sm:border-rule sm:px-4 max-sm:border-t max-sm:border-rule max-sm:pt-1">
      <span aria-hidden className="inline-block size-2 bg-ink" />
      {th.topbar.teacherWatching(names.join(', '))}
    </span>
  );
}
