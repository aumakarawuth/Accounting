'use client';

import { useState } from 'react';
import { th } from '@/i18n/th';

// แอปที่ติดตั้ง (PWA) บน iPhone/iPad: เปิดไฟล์แล้วไม่มีทางกลับ → ใช้หน้าแชร์ของเครื่อง (บันทึกลงไฟล์/เปิดด้วยแอปอื่น/พิมพ์) แทน
// ไม่ได้ติดตั้ง หรือเครื่องแชร์ไฟล์ไม่ได้ → ลิงก์ดาวน์โหลดตามปกติ
function standalone() {
  return window.matchMedia?.('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

export function ExportLink({ href, label, className }: { href: string; label: string; className: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <a
      href={href}
      download
      target="_blank"
      rel="noopener"
      className={`${className} ${busy ? 'opacity-60' : ''}`}
      aria-busy={busy}
      onClick={async (e) => {
        if (!standalone() || typeof navigator.share !== 'function') return;
        e.preventDefault();
        if (busy) return;
        setBusy(true);
        try {
          const res = await fetch(href, { credentials: 'same-origin' });
          if (!res.ok) throw new Error(String(res.status));
          const blob = await res.blob();
          const cd = res.headers.get('content-disposition') ?? '';
          const m = /filename\*=UTF-8''([^;]+)/.exec(cd) ?? /filename="([^"]+)"/.exec(cd);
          const name = m ? decodeURIComponent(m[1]) : href.split('/').pop()?.split('?')[0] ?? 'export';
          const file = new File([blob], name, { type: blob.type });
          if (navigator.canShare?.({ files: [file] })) {
            await navigator.share({ files: [file], title: name });
          } else {
            window.open(href, '_blank', 'noopener');
          }
        } catch (err) {
          if ((err as Error).name !== 'AbortError') alert(th.export.shareFailed);
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? th.export.preparing : label}
    </a>
  );
}
