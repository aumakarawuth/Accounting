import Link from 'next/link';
import type { Account, AssignmentView, GradeItem } from '@/lib/api';
import { isoToThai } from '@/lib/date';
import { formatMoney } from '@/lib/money';
import { StartExam } from './StartExam';
import { th } from '@/i18n/th';

const m = th.myAssignment;
const when = (iso: string) => new Date(iso).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok' });

/** "1110|D|100.00" → "เดบิต 1110 เงินสด 100.00" */
function keyLine(key: string, names: Map<string, string>) {
  const [code = '', side, amount = '0'] = key.split('|');
  return m.line(side === 'D' ? 'D' : 'C', code, names.get(code) ?? '', formatMoney(amount));
}

function AnswerLines({ lines, names }: { lines: { code: string; debit: string; credit: string }[]; names: Map<string, string> }) {
  return (
    <table className="w-full border-collapse text-[15px]">
      <tbody>
        {lines.map((l, i) => {
          const credit = l.credit !== '0.00';
          return (
            <tr key={i} className="border-b border-rule">
              <td className="w-16 py-1.5 font-num">{l.code}</td>
              <td className={`py-1.5 ${credit ? 'pl-7' : ''}`}>{names.get(l.code) ?? ''}</td>
              <td className="w-28 py-1.5 text-right font-num">{credit ? '' : formatMoney(l.debit)}</td>
              <td className="w-28 py-1.5 text-right font-num">{credit ? formatMoney(l.credit) : ''}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// โจทย์ + สถานะสอบ + ผลตรวจ (เท่าที่ DB อนุญาตให้ผู้ดูคนนี้เห็น) ใช้ทั้งหน้า "งานของฉัน" ของนักเรียน/ครูสาธิต และหน้าตรวจงานของครู
export function AssignmentPanel({ view, companyId, accounts, canWrite }: { view: AssignmentView; companyId: string; accounts: Account[]; canWrite: boolean }) {
  const { assignment: a, result } = view;
  const names = new Map(accounts.map((x) => [x.code, x.name]));
  const grade = new Map((result?.items ?? []).map((g) => [g.no, g]));
  const answers = new Map((result?.answers ?? []).map((x) => [x.no, x.lines]));
  const demo = a.mode === 'demo';
  const teacher = view.viewer === 'teacher';

  return (
    <section aria-label={m.title} className="flex flex-col gap-3">
      <div className="flex flex-col gap-1 border border-rule-strong bg-paper p-4">
        <h2 className="font-doc text-lg font-bold">{m.title} · {a.title}</h2>
        <p className="text-sm text-ink2">{th.assign.modes[a.mode]}{a.durationMinutes ? ` · ${th.assignment.duration(a.durationMinutes)}` : ''}</p>
        {demo && teacher ? <p className="text-sm">{m.demoNote}</p> : <p className="text-sm">{m.instructions}</p>}
        {view.lockReason === 'not_open' && a.opensAt && <p className="font-semibold">{m.notOpen(when(a.opensAt))}</p>}
        {view.lockReason === 'exam_over' && <p className="font-semibold">{m.timeUp}</p>}
        {view.lockReason === 'closed' && <p className="font-semibold">{m.closed}</p>}
        {a.mode === 'exam' && !view.attempt && !teacher && view.lockReason !== 'not_open' && view.lockReason !== 'closed' && (
          <div className="flex flex-col gap-2 pt-2">
            <p>{m.examIntro(a.durationMinutes ?? 0)}</p>
            {canWrite && <StartExam companyId={companyId} />}
          </div>
        )}
      </div>

      {(result || view.resultHidden) && !(demo && teacher) && (
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border border-rule-strong bg-paper p-4" aria-label={m.result}>
          <h3 className="text-[17px] font-semibold">{m.result}</h3>
          {result ? (
            <>
              <span className="font-semibold">{m.score(result.score, result.maxScore)}</span>
              <span>{m.correct(result.correct, result.total)}</span>
              <Link href={teacher ? `/teacher/review/${companyId}` : `/c/${companyId}/work`} className="flex min-h-11 items-center text-sm underline print:hidden">{m.check}</Link>
            </>
          ) : <span className="text-ink2">{m.hidden[view.resultHidden ?? 'anytime']}</span>}
        </div>
      )}

      {view.itemsVisible && view.items && (
        <ol className="flex flex-col border-t border-rule-strong bg-paper">
          {view.items.map((it) => {
            const g: GradeItem | undefined = grade.get(it.no);
            const expected = it.answer ?? answers.get(it.no) ?? null;
            return (
              <li key={it.no} className="flex flex-col gap-2 border-b border-rule px-4 py-3">
                <div className="flex flex-wrap items-baseline gap-x-3">
                  <span className="font-semibold">{th.assignment.item(it.no)}</span>
                  <span className="font-num text-sm">{isoToThai(it.date)}</span>
                  <span className="text-sm text-ink2">{th.exercises.points} {it.points}</span>
                  {g && (
                    <span className={`ml-auto text-sm ${g.status === 'correct' ? '' : 'font-semibold'}`}>
                      {th.assignment.itemStatus[g.status]}{g.docNo ? ` · ${m.yourEntry(g.docNo)}` : ''}
                    </span>
                  )}
                </div>
                <p className="whitespace-pre-line">{it.narrative}</p>
                {g && (g.missing?.length || g.extra?.length) ? (
                  <dl className="grid gap-x-3 text-sm sm:grid-cols-[auto_minmax(0,1fr)]">
                    {g.missing?.length ? <><dt className="text-ink2">{m.missingLines}</dt><dd>{g.missing.map((k) => <span key={k} className="block">{keyLine(k, names)}</span>)}</dd></> : null}
                    {g.extra?.length ? <><dt className="text-ink2">{m.extraLines}</dt><dd>{g.extra.map((k) => <span key={k} className="block">{keyLine(k, names)}</span>)}</dd></> : null}
                  </dl>
                ) : null}
                {expected && (
                  <div className="flex flex-col gap-1">
                    <span className="text-sm text-ink2">{m.expected}</span>
                    <AnswerLines lines={expected} names={names} />
                    {demo && canWrite && (
                      <Link href={`/c/${companyId}/journal/new?exercise=${it.no}`}
                        className="flex min-h-11 items-center self-start rounded-doc bg-ink px-4 font-medium text-paper print:hidden">{m.postFromAnswer}</Link>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}

      {result?.extraEntries && result.extraEntries.length > 0 && (
        <div className="flex flex-col gap-1 border border-rule-strong bg-paper p-4">
          <h3 className="text-[15px] font-semibold">{m.extraEntries}</h3>
          <ul className="text-sm">
            {result.extraEntries.map((e) => (
              <li key={e.id} className="font-num">
                {teacher ? e.docNo : <Link href={`/c/${companyId}/journal/${e.id}`} className="flex min-h-11 items-center underline">{e.docNo} · {isoToThai(e.date)}</Link>}
                {teacher ? ` · ${isoToThai(e.date)}` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
