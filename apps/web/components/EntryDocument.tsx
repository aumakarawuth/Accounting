'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/Button';
import { Money } from '@/components/Money';
import { api, postJson, type ApiError, type EntryComment, type JournalEntry } from '@/lib/api';
import { subscribe } from '@/lib/realtime';
import { isoToThai } from '@/lib/date';
import { formatMoney } from '@/lib/money';
import { th } from '@/i18n/th';

const when = (iso: string) =>
  new Date(iso).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok' });

// ใบสำคัญทั่วไปหนึ่งใบ + คอมเมนต์ปากกาแดง (docs/design.md: คอม = คอลัมน์ขอบสมุดด้านขวา ตรงบรรทัด;
// iPad/มือถือ = แทรกใต้บรรทัด) ครูประจำห้องติดคอมเมนต์ได้ นักเรียนเห็นทันทีผ่าน realtime
export function EntryDocument({ companyId, entry, viewer, entryBase }: {
  companyId: string; entry: JournalEntry; viewer: 'student' | 'teacher'; entryBase: string;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => subscribe(`company:${companyId}`, (e) => { if (e.k === 'comment') router.refresh(); }), [companyId, router]);

  const rv = entry.reverses !== null;
  // แสดงแบบสมุดรายวัน: เดบิตก่อน เครดิตย่อหน้าตามหลัง (รายการกลับรายการเก็บลำดับบรรทัดตามรายการเดิม)
  const lines = [...entry.lines].sort((a, b) => Number(a.debit === '0.00') - Number(b.debit === '0.00') || a.lineNo - b.lineNo);
  const atLine = (n: number | null) => entry.comments.filter((c) => c.lineNo === n);
  const cell = 'border border-rule px-2.5 py-2';
  const amount = (v: string) => (v === '0.00' ? '' : formatMoney(v));
  const hasMargin = entry.comments.some((c) => c.lineNo !== null);

  async function remove(id: string) {
    setError(null);
    try {
      await api(`/companies/${companyId}/comments/${id}`, { method: 'DELETE' });
      router.refresh();
    } catch (e) {
      setError((e as ApiError).message);
    }
  }
  const pen = (list: EntryComment[]) => list.map((c) => <Pen key={c.id} c={c} onDelete={c.mine ? () => void remove(c.id) : undefined} />);

  return (
    <div className="flex flex-col gap-4">
      <article className="flex flex-col gap-4 border border-rule-strong bg-paper p-4 sm:p-6">
        <header className="flex flex-wrap items-start justify-between gap-2 border-b-2 border-ink pb-2.5">
          <div>
            <h1 className="font-doc text-[19px] font-bold sm:text-2xl">{th.journal.title}</h1>
            <p className="text-sm text-ink2">{th.journal.postedAt(when(entry.postedAt))}</p>
          </div>
          <dl className="grid grid-cols-[auto_auto] gap-x-3 text-[15px] sm:text-right">
            <dt className="text-ink2">{th.invoice.docNo}</dt>
            <dd className={`font-num font-semibold ${rv ? 'neg' : ''}`}>{entry.docNo}</dd>
            <dt className="text-ink2">{th.journal.date}</dt>
            <dd className="font-num">{isoToThai(entry.date)}</dd>
          </dl>
        </header>

        {entry.description && <p>{entry.description}</p>}
        {entry.reverses && (
          <p className="text-sm">
            {th.journal.reverses} <Link href={`${entryBase}${entry.reverses.id}`} className="font-num underline">{entry.reverses.docNo}</Link>
          </p>
        )}
        {entry.reversedBy && (
          <p className="text-sm">
            {th.journal.reversedBy} <Link href={`${entryBase}${entry.reversedBy.id}`} className="neg font-num underline">{entry.reversedBy.docNo}</Link>
          </p>
        )}

        {/* iPad/คอม: ตารางแบบสมุด เครดิตย่อหน้า; จอกว้างมีคอลัมน์ขอบสมุดสำหรับปากกาแดง */}
        <table className="w-full border-collapse text-[15px] max-sm:hidden">
          <thead className="bg-band text-left text-sm">
            <tr>
              <th className={`${cell} w-24 font-medium`}>{th.journal.accountCode}</th>
              <th className={`${cell} font-medium`}>{th.journal.accountName}</th>
              <th className={`${cell} font-medium`}>{th.journal.lineMemo}</th>
              <th className={`${cell} w-36 text-right font-medium`}>{th.money.debit}</th>
              <th className={`${cell} w-36 text-right font-medium`}>{th.money.credit}</th>
              {hasMargin && <th className="w-64 border-l-2 border-l-red/50 bg-paper px-3 text-left text-sm font-medium text-red max-lg:hidden">{th.comment.margin}</th>}
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => {
              const cs = atLine(l.lineNo);
              return [
                <tr key={l.lineNo}>
                  <td className={`${cell} font-num`}>{l.code}</td>
                  <td className={`${cell} ${l.credit !== '0.00' ? 'pl-7' : ''}`}>{l.name}</td>
                  <td className={`${cell} text-ink2`}>{l.memo}</td>
                  <td className={`${cell} num`}>{amount(l.debit)}</td>
                  <td className={`${cell} num`}>{amount(l.credit)}</td>
                  {hasMargin && <td className="border-l-2 border-l-red/50 px-3 py-1 align-top max-lg:hidden">{pen(cs)}</td>}
                </tr>,
                cs.length > 0 && (
                  <tr key={`c${l.lineNo}`} className="lg:hidden">
                    <td colSpan={5} className="border border-rule px-2.5 py-1.5">{pen(cs)}</td>
                  </tr>
                ),
              ];
            })}
          </tbody>
          <tfoot className="font-medium">
            <tr>
              <td colSpan={3} className={`${cell} border-t-2 border-t-ink text-right`}>{th.money.total}</td>
              <td className={`${cell} num border-t-2 border-b-[3px] border-t-ink border-b-ink border-double`}>{formatMoney(entry.total)}</td>
              <td className={`${cell} num border-t-2 border-b-[3px] border-t-ink border-b-ink border-double`}>{formatMoney(entry.total)}</td>
              {hasMargin && <td className="border-l-2 border-l-red/50 max-lg:hidden" />}
            </tr>
          </tfoot>
        </table>

        {/* มือถือ: รายการบรรทัด คอมเมนต์แทรกใต้บรรทัด */}
        <ul className="border-t border-rule-strong sm:hidden">
          {lines.map((l) => (
            <li key={l.lineNo} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 border-b border-rule py-2">
              <span className={l.credit !== '0.00' ? 'pl-5' : ''}>{l.name}</span>
              <Money value={l.debit !== '0.00' ? l.debit : l.credit} />
              <span className={`font-num text-[13px] text-ink2 ${l.credit !== '0.00' ? 'pl-5' : ''}`}>{l.code}{l.memo ? ` · ${l.memo}` : ''}</span>
              <span className="text-right text-[13px] text-ink2">{l.debit !== '0.00' ? th.money.debit : th.money.credit}</span>
              {atLine(l.lineNo).length > 0 && <div className="col-span-2 pt-1">{pen(atLine(l.lineNo))}</div>}
            </li>
          ))}
          <li className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 py-2 font-medium">
            <span>{th.money.debit}</span><span className="num">{formatMoney(entry.total)}</span>
            <span>{th.money.credit}</span><span className="num">{formatMoney(entry.total)}</span>
          </li>
        </ul>
        <p className="text-[15px]">{th.money.difference} 0.00 · {th.money.balanced}</p>

        {atLine(null).length > 0 && (
          <section aria-label={th.comment.title} className="border-t border-rule pt-2">{pen(atLine(null))}</section>
        )}
        {error && <p role="alert" className="neg text-sm">{error}</p>}
      </article>

      {viewer === 'teacher' && <CommentForm companyId={companyId} entry={entry} />}
    </div>
  );
}

// ปากกาแดง: ตัวเอียง สีแดง พร้อมผู้เขียนและเวลา (นักเรียนไม่เห็นชื่อครู แสดงว่า "ครู")
function Pen({ c, onDelete }: { c: EntryComment; onDelete?: () => void }) {
  return (
    <p className="neg flex flex-wrap items-baseline gap-x-2 py-0.5 italic">
      <span>{c.body}</span>
      <span className="text-[13px] not-italic">— {th.comment.by(c.authorName ?? th.comment.teacher, when(c.at))}</span>
      {onDelete && (
        <button type="button" onClick={onDelete} className="min-h-11 px-1 text-[13px] not-italic text-ink2 underline">{th.comment.delete}</button>
      )}
    </p>
  );
}

function CommentForm({ companyId, entry }: { companyId: string; entry: JournalEntry }) {
  const router = useRouter();
  const [target, setTarget] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit() {
    if (!body.trim() || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      await postJson(`/companies/${companyId}/journal/${entry.id}/comments`, { lineNo: target ? Number(target) : null, body });
      setBody('');
      setMessage({ ok: true, text: th.comment.added });
      router.refresh();
    } catch (e) {
      setMessage({ ok: false, text: (e as ApiError).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="flex flex-col gap-3 border border-rule-strong bg-paper p-4" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <h2 className="text-[17px] font-semibold">{th.comment.add}</h2>
      <label className="flex flex-col text-sm">
        {th.comment.target}
        <select className="h-11 border-b border-rule-input bg-transparent text-base" value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="">{th.comment.wholeEntry}</option>
          {[...entry.lines].sort((a, b) => a.lineNo - b.lineNo).map((l) => (
            <option key={l.lineNo} value={l.lineNo}>{th.comment.line(l.lineNo, l.code, l.name)}</option>
          ))}
        </select>
      </label>
      <label className="flex flex-col text-sm">
        {th.comment.body}
        <textarea className="min-h-24 border border-rule-input bg-transparent p-2 text-base" maxLength={1000} value={body} onChange={(e) => setBody(e.target.value)} />
      </label>
      {message && <p role={message.ok ? 'status' : 'alert'} className={message.ok ? 'text-sm' : 'neg text-sm'}>{message.text}</p>}
      <div>
        <Button type="submit" disabled={busy || !body.trim()} className="max-sm:w-full">{th.comment.add}</Button>
      </div>
    </form>
  );
}
