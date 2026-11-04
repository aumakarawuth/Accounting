'use client';

import { useEffect, useSyncExternalStore } from 'react';
import { th } from '@/i18n/th';

const SCALES = { normal: '100%', large: '125%', xlarge: '150%' } as const;
type Scale = keyof typeof SCALES;
const KEY = 'demo-scale';
const EVENT = 'demo-scale';

function read(): Scale {
  try { const v = localStorage.getItem(KEY); return v && v in SCALES ? (v as Scale) : 'large'; } catch { return 'large'; }
}
function write(s: Scale) {
  try { localStorage.setItem(KEY, s); } catch { /* โหมดส่วนตัว: ไม่จำค่า */ }
  window.dispatchEvent(new Event(EVENT));
}
function subscribe(cb: () => void) {
  window.addEventListener(EVENT, cb);
  window.addEventListener('storage', cb);
  return () => { window.removeEventListener(EVENT, cb); window.removeEventListener('storage', cb); };
}

// โหมดสาธิต: ขยายตัวอักษรทั้งหน้า (ทุกขนาดเป็น rem) สำหรับโปรเจกเตอร์ จำค่าในเครื่อง ออกจากบริษัทแล้วคืนค่าเดิม
export function DemoScale() {
  const scale = useSyncExternalStore(subscribe, read, () => 'large' as Scale);
  useEffect(() => {
    document.documentElement.style.fontSize = SCALES[scale];
    return () => { document.documentElement.style.fontSize = ''; };
  }, [scale]);
  return (
    <div role="group" aria-label={th.demo.scale} className="flex min-h-10 flex-wrap items-center gap-2 border-b border-rule-strong bg-paper px-4 text-sm print:hidden">
      <span>{th.mode.demo} · {th.demo.scale}</span>
      {(Object.keys(SCALES) as Scale[]).map((s) => (
        <button key={s} type="button" aria-pressed={scale === s} onClick={() => write(s)}
          className="min-h-11 rounded-doc border border-ink px-3 aria-pressed:bg-ink aria-pressed:text-paper">{th.demo.scales[s]}</button>
      ))}
    </div>
  );
}
