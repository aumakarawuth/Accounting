'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import { th } from '@/i18n/th';

const pad = (n: number) => String(n).padStart(2, '0');
export function remaining(ms: number) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600);
  return h > 0 ? `${h}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}` : `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
}

const subscribe = (cb: () => void) => { const t = setInterval(cb, 1000); return () => clearInterval(t); };
const nowSecond = () => Math.floor(Date.now() / 1000) * 1000;

// แถบนับถอยหลังใต้แถบบน (ไม่ใช่ popup) เวลาจริงตัดสินที่ DB: แก้ส่วนต่างนาฬิกาเครื่องด้วยเวลาเซิร์ฟเวอร์ตอนโหลดหน้า
// หมดเวลาแล้วโหลดข้อมูลใหม่ หน้าจะแสดงสถานะล็อกตามที่ DB ตอบ
export function ExamClock({ deadline, serverNow }: { deadline: string; serverNow: string }) {
  const router = useRouter();
  const server = new Date(serverNow).getTime();
  const [skew] = useState(() => server - Date.now());
  // ตอน hydrate ใช้เวลาเซิร์ฟเวอร์ (แปลงเป็นนาฬิกาเครื่อง) ข้อความจึงตรงกับที่เซิร์ฟเวอร์ render
  const now = useSyncExternalStore(subscribe, nowSecond, () => server - skew);
  const left = new Date(deadline).getTime() - (now + skew);
  const over = left <= 0;
  useEffect(() => { if (over) router.refresh(); }, [over, router]);
  const at = new Date(deadline).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bangkok' });
  return (
    <div role="timer" aria-live="off" className={`flex min-h-10 flex-wrap items-center gap-x-4 border-b border-rule-strong bg-paper px-4 text-[15px] print:hidden ${left < 5 * 60_000 ? 'font-semibold' : ''}`}>
      <span>{th.mode.exam}</span>
      <span className="font-num">{over ? th.myAssignment.timeUp : th.myAssignment.timeLeft(remaining(left))}</span>
      <span className="text-sm text-ink2">{th.myAssignment.deadline(at)}</span>
    </div>
  );
}
