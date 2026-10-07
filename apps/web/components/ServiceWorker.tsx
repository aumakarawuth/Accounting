'use client';

import { useEffect } from 'react';

// ลงทะเบียน service worker เฉพาะ build จริง (ตอน dev ไฟล์เปลี่ยนตลอด cache จะทำให้งง)
// คุมเฉพาะหน้าบริษัทของนักเรียน (/c/): Chromium ยกเลิกคำขอที่ส่งตอนปิดหน้า (beacon/keepalive)
// จากหน้าที่ service worker คุม ถ้าคุมหน้าครู ป้าย "ครูกำลังดูอยู่" จะค้างที่นักเรียนเพราะคำขอหยุดดูหาย
export function ServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production' || !('serviceWorker' in navigator)) return;
    void (async () => {
      // เครื่องที่เคยลงทะเบียนแบบคุมทั้งเว็บ: ถอนออกก่อน
      for (const r of await navigator.serviceWorker.getRegistrations()) {
        if (new URL(r.scope).pathname === '/') await r.unregister();
      }
      await navigator.serviceWorker.register('/sw.js', { scope: '/c/' });
    })().catch(() => {});
  }, []);
  return null;
}
