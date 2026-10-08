import Link from 'next/link';
import { MonthNav } from '@/components/MonthNav';
import { Money } from '@/components/Money';
import { serverApi } from '@/lib/server-api';
import type { Company, TrialBalance } from '@/lib/api';
import { isMonth, monthEndLabel, todayIso } from '@/lib/date';
import { formatMoney, fromCents, toCents } from '@/lib/money';
import { th } from '@/i18n/th';

export default async function TrialBalancePage({
  params, searchParams,
}: { params: Promise<{ companyId: string }>; searchParams: Promise<{ month?: string; all?: string }> }) {
  const { companyId } = await params;
  const sp = await searchParams;
  const month = isMonth(sp.month) ? sp.month : todayIso().slice(0, 7);
  const all = sp.all === '1';
  const [company, tb] = await Promise.all([
    serverApi<Company>(`/companies/${companyId}`),
    serverApi<TrialBalance>(`/companies/${companyId}/trial-balance?month=${month}${all ? '&all=1' : ''}`),
  ]);
  const base = `/c/${companyId}/trial-balance`;
  const href = (m: string, a = all) => `${base}?month=${m}${a ? '&all=1' : ''}`;
  const ledger = (code: string) => `/c/${companyId}/ledger?month=${month}&account=${code}`;
  const diff = (toCents(tb.totalDebit) ?? 0n) - (toCents(tb.totalCredit) ?? 0n);
  const amount = (v: string) => (v === '0.00' ? '' : formatMoney(v));
  const cell = 'h-11 border border-rule px-2.5';

  return (
    <div className="flex flex-col gap-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-end gap-3 border-b-2 border-ink pb-2.5">
        <div className="min-w-0">
          <h1 className="font-doc text-[20px] font-bold sm:text-2xl">{th.trialBalance.heading(company.name, monthEndLabel(month))}</h1>
          <p className="text-sm text-ink2">{th.trialBalance.cumulativeNote}</p>
        </div>
        <div className="flex flex-wrap items-center gap-3 sm:ml-auto">
          <MonthNav month={month} href={(m) => href(m)} />
          <Link href={href(month, !all)} className="flex min-h-11 items-center text-sm underline">
            {all ? th.trialBalance.showActive : th.trialBalance.showAll}
          </Link>
        </div>
      </div>

      {tb.rows.length === 0 ? (
        <p className="text-ink2">{th.trialBalance.empty}</p>
      ) : (
        <>
          {/* iPad/คอม: ตารางแบบสมุด */}
          <table className="w-full border-collapse bg-paper text-[15px] max-sm:hidden">
            <thead className="bg-band text-left text-sm">
              <tr>
                <th className={`${cell} w-28 font-medium`}>{th.trialBalance.code}</th>
                <th className={`${cell} font-medium`}>{th.trialBalance.account}</th>
                <th className={`${cell} w-44 text-right font-medium`}>{th.money.debit}</th>
                <th className={`${cell} w-44 text-right font-medium`}>{th.money.credit}</th>
              </tr>
            </thead>
            <tbody>
              {tb.rows.map((r) => (
                <tr key={r.code}>
                  <td className={`${cell} font-num`}><Link href={ledger(r.code)} className="underline decoration-rule-input">{r.code}</Link></td>
                  <td className={`${cell} ${r.credit !== '0.00' ? 'pl-7' : ''}`}>{r.name}</td>
                  <td className={`${cell} num`}>{amount(r.debit)}</td>
                  <td className={`${cell} num`}>{amount(r.credit)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="font-medium">
                <td colSpan={2} className={`${cell} border-t-2 border-t-ink text-right`}>{th.money.total}</td>
                <td className={`${cell} num border-t-2 border-b-[3px] border-t-ink border-b-ink border-double`}>{formatMoney(tb.totalDebit)}</td>
                <td className={`${cell} num border-t-2 border-b-[3px] border-t-ink border-b-ink border-double`}>{formatMoney(tb.totalCredit)}</td>
              </tr>
            </tfoot>
          </table>

          {/* มือถือ: ดูเป็นรายการ */}
          <ul className="border-t border-rule-strong bg-paper sm:hidden">
            {tb.rows.map((r) => (
              <li key={r.code} className="border-b border-rule">
                <Link href={ledger(r.code)} className="grid min-h-12 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 px-4 py-2">
                  <span>{r.name}</span>
                  <Money value={r.debit !== '0.00' ? r.debit : r.credit} />
                  <span className="font-num text-[13px] text-ink2">{r.code}</span>
                  <span className="text-right text-[13px] text-ink2">{r.debit !== '0.00' ? th.money.debit : th.money.credit}</span>
                </Link>
              </li>
            ))}
            <li className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 px-4 py-2 font-medium">
              <span>{th.money.debit}</span><span className="num">{formatMoney(tb.totalDebit)}</span>
              <span>{th.money.credit}</span><span className="num">{formatMoney(tb.totalCredit)}</span>
            </li>
          </ul>

          <p role="status" className={diff === 0n ? 'text-[15px]' : 'neg text-[15px] font-semibold'}>
            {diff === 0n
              ? `${th.money.difference} 0.00 · ${th.money.balanced}`
              : th.trialBalance.unbalanced(formatMoney(tb.totalDebit), formatMoney(tb.totalCredit), formatMoney(fromCents(diff < 0n ? -diff : diff)))}
          </p>
        </>
      )}
    </div>
  );
}
