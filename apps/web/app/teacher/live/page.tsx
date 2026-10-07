import Link from 'next/link';
import { redirect } from 'next/navigation';
import { serverApi } from '@/lib/server-api';
import type { Classroom } from '@/lib/api';
import { th } from '@/i18n/th';

// เมนู "ดูสด": ห้องเดียวไปเลย หลายห้องให้เลือก
export default async function LiveIndex() {
  const rooms = await serverApi<Classroom[]>('/teacher/classrooms');
  if (rooms.length === 1) redirect(`/teacher/live/${rooms[0]!.id}`);
  return (
    <div className="mx-auto flex max-w-xl flex-col gap-3">
      <h1 className="border-b-2 border-ink pb-2.5 font-doc text-[22px] font-bold">{th.live.chooseRoom}</h1>
      <ul className="border-t border-rule-strong bg-paper">
        {rooms.map((r) => (
          <li key={r.id}><Link href={`/teacher/live/${r.id}`} className="flex min-h-12 items-center border-b border-rule px-4">{r.name} · {th.teacher.students(r.students.length)}</Link></li>
        ))}
      </ul>
    </div>
  );
}
