import Link from 'next/link';
import { MonthNav } from '@/components/MonthNav';
import { Money } from '@/components/Money';
import { serverApi } from '@/lib/server-api';
import type { Ledger, LedgerAccount } from '@/lib/api';
import { isMonth, isoToThai, monthLabel, todayIso } from '@/lib/date';
import { formatMoney } from '@/lib/money';
import { th } from '@/i18n/th';

const ACCOUNT = /^[0-9A-Za-z-]{1,20}$/;

export default async function LedgerPage({
  params, searchParams,
}: { params: Promise<{ companyId: string }>; searchParams: Promise<{ month?: string; account?: string }> }) {
  const { companyId } = await params;
  const sp = await searchParams;
  const month = isMonth(sp.month) ? sp.month : todayIso().slice(0, 7);
  const code = sp.account && ACCOUNT.test(sp.account) ? sp.account : null;
  const [accounts, ledger] = await Promise.all([
    serverApi<LedgerAccount[]>(`/companies/${companyId}/ledger-accounts?month=${month}`),
    code ? serverApi<Ledger>(`/companies/${companyId}/ledger?month=${month}&account=${encodeURIComponent(code)}`) : null,
  ]);
  const base = `/c/${companyId}/ledger`;
  const href = (m: string, acc: string | null = code) => `${base}?month=${m}${acc ? `&account=${acc}` : ''}`;
  const amount = (v: string) => (v === '0.00' ? '' : formatMoney(v));
  const cell = 'border border-rule px-2.5 py-2';

  return (
    <div className="flex flex-col gap-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-end gap-3 border-b-2 border-ink pb-2.5">
        <h1 className="font-doc text-[20px] font-bold sm:text-2xl">{th.ledger.title}</h1>
        <div className="sm:ml-auto"><MonthNav month={month} href={(m) => href(m)} /></div>
      </div>

      <div className="flex gap-5">
        {/* รายการบัญชี: คอมแสดงคู่กับแยกประเภท, มือถือแสดงเมื่อยังไม่เลือกบัญชี */}
        <section className={`flex w-full flex-col gap-2 lg:w-[340px] lg:shrink-0 ${ledger ? 'max-lg:hidden' : ''}`}>
          <h2 className="text-[15px] font-semibold">{th.ledger.accounts(monthLabel(month))}</h2>
          {accounts.length === 0 ? (
            <p className="text-ink2">{th.journal.empty}</p>
          ) : (
            <ul className="border-t border-rule-strong bg-paper">
              {accounts.map((a) => (
                <li key={a.code}>
                  <Link
                    href={href(month, a.code)}
                    aria-current={a.code === code ? 'page' : undefined}
                    className="grid min-h-12 grid-cols-[52px_minmax(0,1fr)_auto] items-center gap-x-3 border-b border-rule px-3 aria-[current=page]:bg-ink aria-[current=page]:text-paper"
                  >
                    <span className="font-num">{a.code}</span>
                    <span className="truncate">{a.name}</span>
                    <Money value={a.closing} />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        {ledger && (
          <section className="flex min-w-0 flex-1 flex-col gap-3 border border-rule-strong bg-paper p-4 sm:p-6">
            <Link href={href(month, null)} className="flex min-h-11 items-center text-sm underline lg:hidden">‹ {th.ledger.allAccounts}</Link>
            <div className="border-b-2 border-ink pb-2">
              <h2 className="font-doc text-[19px] font-bold sm:text-[22px]">{th.ledger.heading(ledger.account.code, ledger.account.name)}</h2>
              <p className="text-sm text-ink2">{th.month.current(monthLabel(month))} · {th.ledger.normalSide(ledger.account.normalSide)}</p>
            </div>

            {/* iPad/คอม: แบบยอดคงเหลือต่อเนื่อง */}
            <table className="w-full border-collapse text-[15px] max-sm:hidden">
              <thead className="bg-band text-left text-sm">
                <tr>
                  <th className={`${cell} w-28 font-medium`}>{th.ledger.date}</th>
                  <th className={`${cell} w-24 font-medium`}>{th.ledger.docNo}</th>
                  <th className={`${cell} font-medium`}>{th.ledger.description}</th>
                  <th className={`${cell} w-36 text-right font-medium`}>{th.money.debit}</th>
                  <th className={`${cell} w-36 text-right font-medium`}>{th.money.credit}</th>
                  <th className={`${cell} w-36 text-right font-medium`}>{th.ledger.balance}</th>
                </tr>
              </thead>
              <tbody>
                <tr className="text-ink2">
                  <td className={cell} colSpan={3}>{th.ledger.opening}</td>
                  <td className={cell} /><td className={cell} />
                  <td className={`${cell} text-right`}><Money value={ledger.opening} /></td>
                </tr>
                {ledger.lines.map((l, i) => (
                  <tr key={i}>
                    <td className={`${cell} font-num`}>{isoToThai(l.date)}</td>
                    <td className={`${cell} font-num ${l.reversal ? 'neg' : ''}`}>{l.docNo}</td>
                    <td className={cell}>{l.memo || l.description}</td>
                    <td className={`${cell} num`}>{amount(l.debit)}</td>
                    <td className={`${cell} num`}>{amount(l.credit)}</td>
                    <td className={`${cell} text-right`}><Money value={l.balance} /></td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="font-medium">
                <tr>
                  <td className={`${cell} border-t-2 border-t-ink text-right`} colSpan={3}>{th.ledger.totals} · {th.ledger.closing}</td>
                  <td className={`${cell} num border-t-2 border-t-ink`}>{formatMoney(ledger.totalDebit)}</td>
                  <td className={`${cell} num border-t-2 border-t-ink`}>{formatMoney(ledger.totalCredit)}</td>
                  <td className={`${cell} border-t-2 border-b-[3px] border-t-ink border-b-ink border-double text-right`}><Money value={ledger.closing} /></td>
                </tr>
              </tfoot>
            </table>

            {/* มือถือ: ทีละรายการ */}
            <ul className="sm:hidden">
              <li className="flex justify-between border-b border-rule py-2 text-ink2"><span>{th.ledger.opening}</span><Money value={ledger.opening} /></li>
              {ledger.lines.map((l, i) => (
                <li key={i} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 border-b border-rule py-2">
                  <span className="text-[13px] text-ink2"><span className="font-num">{isoToThai(l.date)}</span> · <span className={`font-num ${l.reversal ? 'neg' : ''}`}>{l.docNo}</span></span>
                  <span className="num">{l.debit !== '0.00' ? `${th.money.debit} ${formatMoney(l.debit)}` : `${th.money.credit} ${formatMoney(l.credit)}`}</span>
                  <span className="truncate">{l.memo || l.description}</span>
                  <span className="text-right"><Money value={l.balance} /></span>
                </li>
              ))}
              <li className="flex justify-between py-2 font-medium"><span>{th.ledger.closing}</span><Money value={ledger.closing} /></li>
            </ul>

            {ledger.lines.length === 0 && <p className="text-ink2">{th.ledger.noLines}</p>}
            {[ledger.opening, ledger.closing, ...ledger.lines.map((l) => l.balance)].some((v) => v.startsWith('-')) && (
              <p className="text-sm text-ink2">{th.ledger.oppositeNote}</p>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
