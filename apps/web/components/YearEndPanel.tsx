'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/Button';
import { ConfirmPanel, errText, useAction } from '@/components/ConfirmPanel';
import { api, type FiscalYears, type YearClosingPreview } from '@/lib/api';
import { isoToThai } from '@/lib/date';
import { formatMoney, isNegative } from '@/lib/money';
import { th } from '@/i18n/th';

const when = (iso: string) =>
  new Date(iso).toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Bangkok' });
const range = (start: string, end: string) => th.yearEnd.range(isoToThai(start), isoToThai(end));
const net = (v: string) => (isNegative(v) ? th.yearEnd.netLoss(formatMoney(v.slice(1))) : th.yearEnd.netProfit(formatMoney(v)));

// ปิดบัญชีสิ้นปี: ตั้งรอบปีบัญชี · ตารางปีบัญชี · ดูรายการ CL ก่อนยืนยัน (ปิดเรียงปี ปีถัดไปที่ยังไม่ปิดเท่านั้น)
// เงื่อนไขทั้งหมดตรวจซ้ำที่ DB (acc.close_fiscal_year) ปุ่มบนจอแสดงเฉพาะทางที่ทำได้
export function YearEndPanel({ companyId, data, teacher }: { companyId: string; data: FiscalYears; teacher: boolean }) {
  const t = th.yearEnd;
  const router = useRouter();
  const action = useAction();
  const [month, setMonth] = useState(String(data.startMonth));
  const [startMsg, setStartMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [savingStart, setSavingStart] = useState(false);
  const [preview, setPreview] = useState<YearClosingPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const writable = data.canClose && !data.locked;
  const lastClosed = data.years.map((y) => Boolean(y.closing)).lastIndexOf(true);
  const next = writable ? data.years.find((y, i) => i > lastClosed && !y.closing) : undefined;
  const cell = 'border border-rule px-2.5 py-2';

  async function saveStart() {
    setSavingStart(true);
    setStartMsg(null);
    try {
      await api(`/companies/${companyId}/fiscal-year-start`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ month: Number(month), version: data.version }),
      });
      setStartMsg({ ok: true, text: t.startSaved(t.months[Number(month) - 1]!) });
      router.refresh();
    } catch (e) {
      setStartMsg({ ok: false, text: errText(e) });
    } finally {
      setSavingStart(false);
    }
  }

  async function openPreview(end: string) {
    setLoading(true);
    setDone(null);
    action.setError(null);
    try {
      setPreview(await api<YearClosingPreview>(`/companies/${companyId}/fiscal-years/${end}/preview`));
    } catch (e) {
      action.setError(errText(e));
    } finally {
      setLoading(false);
    }
  }

  async function close() {
    if (!preview || !next) return;
    const r = await action.run<{ docNo: string | null }>(`/companies/${companyId}/fiscal-years/${preview.yearEnd}/close`, {});
    if (r) { setDone(t.closedOk(r.docNo, range(next.start, next.end))); setPreview(null); }
  }

  return (
    <section aria-labelledby="year-end" className="flex flex-col gap-3 border border-rule-strong bg-paper p-4">
      <h2 id="year-end" className="font-doc text-[18px] font-bold">{t.title}</h2>
      <p className="text-[15px]">{t.note}</p>
      <p className="text-sm text-ink2">{teacher ? t.teacherNote : t.afterNote}</p>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex min-w-48 flex-col text-sm">
          {t.startMonth}
          <select className="h-11 border-b border-rule-input bg-transparent text-base" value={month}
            disabled={!writable || !data.canChangeStart} onChange={(e) => setMonth(e.target.value)}>
            {t.months.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
          </select>
        </label>
        {writable && data.canChangeStart && (
          <Button type="button" variant="secondary" disabled={savingStart || Number(month) === data.startMonth} onClick={() => void saveStart()} className="max-sm:w-full">
            {t.saveStart}
          </Button>
        )}
        <p className="text-sm text-ink2 sm:self-center">{data.canChangeStart ? t.startHint : t.startLocked}</p>
      </div>
      {startMsg && <p role={startMsg.ok ? 'status' : 'alert'} className={startMsg.ok ? 'text-[15px]' : 'neg text-[15px]'}>{startMsg.text}</p>}

      {data.years.length === 0 ? <p className="text-ink2">{t.empty}</p> : (
        <table className="w-full border-collapse text-[15px]">
          <thead className="bg-band text-left text-sm">
            <tr>
              <th className={`${cell} font-medium`}>{t.year}</th>
              <th className={`${cell} w-20 text-right font-medium max-sm:hidden`}>{t.entries}</th>
              <th className={`${cell} font-medium`}>{t.status}</th>
            </tr>
          </thead>
          <tbody>
            {data.years.map((y) => (
              <tr key={y.start}>
                <td className={`${cell} font-num`}>{range(y.start, y.end)}</td>
                <td className={`${cell} num max-sm:hidden`}>{y.entries}</td>
                <td className={cell}>
                  {y.closing ? (
                    <>
                      <span>{t.closed(y.closing.docNo, when(y.closing.closedAt))}</span>
                      <span className="block text-sm text-ink2">{net(y.closing.netIncome)}</span>
                    </>
                  ) : t.open}
                  {y.reopened.length > 0 && <span className="block text-sm text-ink2">{t.reopened(y.reopened.length)}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {next && !preview && (
        <Button type="button" variant="secondary" disabled={loading} onClick={() => void openPreview(next.end)} className="self-start max-sm:w-full">
          {loading ? t.loading : t.previewBtn(range(next.start, next.end))}
        </Button>
      )}
      {next && preview && (
        <ConfirmPanel title={t.preview(range(next.start, next.end))} explain={t.explain(isoToThai(preview.yearEnd))}
          ready busy={action.busy} error={action.error} confirm={t.confirm} onConfirm={() => void close()} onCancel={() => setPreview(null)}>
          {preview.lines.length === 0 ? <p className="text-sm">{t.zero}</p> : (
            <table className="w-full border-collapse text-[15px]">
              <thead className="text-left text-sm">
                <tr>
                  <th className={`${cell} font-medium`}>{th.trialBalance.account}</th>
                  <th className={`${cell} w-32 text-right font-medium`}>{th.money.debit}</th>
                  <th className={`${cell} w-32 text-right font-medium`}>{th.money.credit}</th>
                </tr>
              </thead>
              <tbody>
                {preview.lines.map((l) => (
                  <tr key={l.code}>
                    <td className={`${cell} ${l.debit === '0.00' ? 'pl-7' : ''}`}><span className="font-num text-[13px] text-ink2">{l.code}</span> {l.name}</td>
                    <td className={`${cell} num`}>{l.debit === '0.00' ? '' : formatMoney(l.debit)}</td>
                    <td className={`${cell} num`}>{l.credit === '0.00' ? '' : formatMoney(l.credit)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="font-medium">
                  <td className={`${cell} text-right`}>{net(preview.netIncome)}</td>
                  <td className={`${cell} num border-b-[3px] border-double border-b-ink`}>{formatMoney(preview.totalDebit)}</td>
                  <td className={`${cell} num border-b-[3px] border-double border-b-ink`}>{formatMoney(preview.totalDebit)}</td>
                </tr>
              </tfoot>
            </table>
          )}
        </ConfirmPanel>
      )}
      {!preview && action.error && <p role="alert" className="neg text-[15px]">{action.error}</p>}
      {done && <p role="status" className="text-[15px]">{done}</p>}
    </section>
  );
}
