import { notFound } from 'next/navigation';
import { LiveDashboard } from '@/components/live/LiveDashboard';
import { serverApi } from '@/lib/server-api';
import type { Classroom } from '@/lib/api';
import { th } from '@/i18n/th';

export default async function LivePage({ params }: { params: Promise<{ classroomId: string }> }) {
  const { classroomId } = await params;
  const rooms = await serverApi<Classroom[]>('/teacher/classrooms');
  const room = rooms.find((r) => r.id === classroomId);
  if (!room) notFound();
  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-4">
      <h1 className="border-b-2 border-ink pb-2.5 font-doc text-[22px] font-bold sm:text-2xl">{th.live.title(room.name)}</h1>
      <LiveDashboard classroomId={classroomId} />
    </div>
  );
}
