'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/Button';
import { postJson, type ApiError, type Periods } from '@/lib/api';
import { monthLabel } from '@/lib/date';
import { th } from '@/i18n/th';

const when = (iso: string) =>
  new Date(iso).toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Bangkok' });

// งวดบัญชีรายเดือน: นักเรียนปิดงวดถัดไป (เดือนเก่าสุดที่ยังเปิด) ครูเปิดงวดล่าสุดที่ปิดคืน
// ลำดับและสิทธิ์ตรวจซ้ำที่ DB ปุ่มบนจอแสดงเฉพาะทางที่ทำได้
export function PeriodTable({ companyId, data, linkJournal = false }: { companyId: string; data: Periods; linkJournal?: boolean }) {
  const router = useRouter();
  const [confirm, setConfirm] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const { periods } = data;
  const nextToClose = data.canClose && !data.locked ? periods.find((p) => !p.closed)?.month : undefined;
  const lastClosed = data.canReopen ? [...periods].reverse().find((p) => p.closed)?.month : undefined;

  async function act(month: string, action: 'close' | 'reopen') {
    if (confirm !== `${action}:${month}`) { setConfirm(`${action}:${month}`); return; }
    setBusy(true);
    setMessage(null);
    try {
      await postJson(`/companies/${companyId}/periods/${month}/${action}`, {});
      setMessage({ ok: true, text: action === 'close' ? th.closing.closedOk(monthLabel(month)) : th.closing.reopenedOk(monthLabel(month)) });
      setConfirm(null);
      router.refresh();
    } catch (e) {
      const err = e as ApiError;
      setMessage({ ok: false, text: err.code === 'server' ? th.error.server(err.ref ?? '-') : err.message });
      setConfirm(null);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  if (periods.length === 0) return <p className="text-ink2">{th.closing.empty}</p>;
  const cell = 'border border-rule px-2.5 py-2';

  const action = (month: string, kind: 'close' | 'reopen') => {
    const armed = confirm === `${kind}:${month}`;
    const label = kind === 'close'
      ? (armed ? th.closing.confirm(monthLabel(month)) : th.closing.close(monthLabel(month)))
      : (armed ? th.closing.confirmReopen(monthLabel(month)) : th.closing.reopen(monthLabel(month)));
    return (
      <Button type="button" variant={armed ? 'primary' : 'secondary'} disabled={busy} onClick={() => void act(month, kind)} className="max-sm:w-full">
        {label}
      </Button>
    );
  };

  return (
    <div className="flex flex-col gap-3">
      <table className="w-full border-collapse bg-paper text-[15px]">
        <thead className="bg-band text-left text-sm">
          <tr>
            <th className={`${cell} font-medium`}>{th.closing.month}</th>
            <th className={`${cell} w-20 text-right font-medium`}>{th.closing.entries}</th>
            <th className={`${cell} font-medium`}>{th.closing.status}</th>
          </tr>
        </thead>
        <tbody>
          {periods.map((p) => (
            <tr key={p.month}>
              <td className={`${cell} font-medium`}>
                {linkJournal ? <Link href={`/c/${companyId}/journal?month=${p.month}`} className="underline decoration-rule-input">{monthLabel(p.month)}</Link> : monthLabel(p.month)}
              </td>
              <td className={`${cell} num`}>{p.entries}</td>
              <td className={cell}>{p.closed && p.closedAt ? th.closing.closedAt(when(p.closedAt)) : th.closing.open}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {(nextToClose || lastClosed) && (
        <div className="flex flex-wrap gap-3">
          {nextToClose && action(nextToClose, 'close')}
          {lastClosed && action(lastClosed, 'reopen')}
        </div>
      )}
      {message && <p role={message.ok ? 'status' : 'alert'} className={message.ok ? 'text-[15px]' : 'neg text-[15px]'}>{message.text}</p>}
    </div>
  );
}
