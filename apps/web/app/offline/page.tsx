import type { Metadata } from 'next';
import { LoginShell } from '@/components/LoginShell';
import { RetryButton } from '@/components/RetryButton';
import { th } from '@/i18n/th';

export const metadata: Metadata = { title: th.pwa.offlineTitle };
export const dynamic = 'force-static';

// หน้าที่ service worker แสดงเมื่อเปิดหน้าใหม่ตอนออฟไลน์ (เก็บไว้ในเครื่องตอนติดตั้ง)
export default function OfflinePage() {
  return (
    <LoginShell right={<span />}>
      <div className="flex w-full flex-col gap-4 px-5 py-6 sm:w-[480px] sm:border sm:border-rule-strong sm:bg-paper sm:px-8 sm:py-7">
        <h1 className="border-b-2 border-ink pb-2.5 font-doc text-[22px] font-bold">{th.pwa.offlineTitle}</h1>
        <p>{th.pwa.offlineBody}</p>
        <p className="text-sm text-ink2">{th.pwa.offlineRule}</p>
        <RetryButton label={th.pwa.retry} />
      </div>
    </LoginShell>
  );
}
