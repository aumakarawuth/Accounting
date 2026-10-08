import { TeacherClassrooms } from '@/components/TeacherClassrooms';
import { serverApi } from '@/lib/server-api';
import type { Alert, Classroom } from '@/lib/api';
import { th } from '@/i18n/th';

const LOCK_MINUTES = 15;
const time = (iso: string) =>
  new Date(iso).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bangkok' });

export default async function TeacherHome() {
  const [rooms, alerts] = await Promise.all([
    serverApi<Classroom[]>('/teacher/classrooms'),
    serverApi<Alert[]>('/teacher/alerts'),
  ]);
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <h1 className="border-b-2 border-ink pb-2.5 font-doc text-[22px] font-bold sm:text-2xl print:hidden">{th.teacher.classrooms}</h1>
      <section className="flex flex-col gap-2 print:hidden">
        <h2 className="text-[17px] font-semibold">{th.teacher.alerts}</h2>
        {alerts.length === 0 ? (
          <p className="text-ink2">{th.teacher.noAlerts}</p>
        ) : (
          <ul className="border-t border-rule-strong bg-paper">
            {alerts.map((a) => (
              <li key={a.id} className="border-b border-rule px-4 py-2.5 text-[15px]">
                {th.teacher.lockedAlert(a.studentCode, a.name, time(a.at), LOCK_MINUTES)}
              </li>
            ))}
          </ul>
        )}
      </section>
      <TeacherClassrooms rooms={rooms} />
    </div>
  );
}
