import Link from 'next/link';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import QRCode from 'qrcode';
import { serverApi } from '@/lib/server-api';
import type { Classroom } from '@/lib/api';
import { th } from '@/i18n/th';

// ฉาย QR ขึ้นจอหน้าห้อง: ตัวใหญ่ อ่านจากหลังห้องได้ (QR เป็น SVG จากไลบรารี ไม่มีข้อมูลจากผู้ใช้ปน)
export default async function JoinQrPage({ params }: { params: Promise<{ classroomId: string }> }) {
  const { classroomId } = await params;
  const room = (await serverApi<Classroom[]>('/teacher/classrooms')).find((r) => r.id === classroomId);
  if (!room) notFound();
  const h = await headers();
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? 'localhost:3000';
  const proto = h.get('x-forwarded-proto') ?? (/^(localhost|127\.)/.test(host) ? 'http' : 'https');
  const origin = `${proto}://${host}`;
  const back = <Link href="/teacher" className="flex min-h-11 items-center self-start text-sm underline print:hidden">‹ {th.teacher.backToRooms}</Link>;

  if (!room.joinCode) {
    return <div className="mx-auto flex max-w-3xl flex-col gap-4">{back}<p>{th.teacher.joinCodeOff}</p></div>;
  }
  const url = `${origin}/join/${room.joinCode}`;
  const svg = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#1B2A4A', light: '#FAFBF7' } });

  return (
    <div className="mx-auto flex max-w-3xl flex-col items-center gap-5 text-center">
      {back}
      <h1 className="font-doc text-[28px] font-bold sm:text-[40px]">{th.teacher.qrTitle(room.name)}</h1>
      <div role="img" aria-label={url} className="w-full max-w-[min(70vh,520px)] border border-rule-strong bg-paper p-3" dangerouslySetInnerHTML={{ __html: svg }} />
      <p className="font-num text-[48px] font-medium tracking-[0.25em] sm:text-[72px]">{room.joinCode}</p>
      <p className="text-[17px] sm:text-[22px]">{th.teacher.qrStep(`${origin}/join`)}</p>
      <p className="text-[15px] text-ink2 sm:text-[18px]">{th.teacher.qrAfter}</p>
    </div>
  );
}
