import Link from 'next/link';
import { ExportLinks } from '@/components/ExportLinks';
import { MonthNav } from '@/components/MonthNav';
import { Money } from '@/components/Money';
import { serverApi } from '@/lib/server-api';
import type { CashFlow, Company } from '@/lib/api';
import { cashFlowRows } from '@/lib/cashflow-lines';
import { isMonth, isoToThai, monthLabel, todayIso } from '@/lib/date';
import { formatMoney } from '@/lib/money';
import { th } from '@/i18n/th';

// งบกระแสเงินสด (docs/phase6-spec.md ข้อ 2): ทางอ้อม/ทางตรง ตรวจเงินสดปลายงวดกับบัญชี 11xx
export default async function CashFlowPage({
  params, searchParams,
}: { params: Promise<{ companyId: string }>; searchParams: Promise<{ month?: string; scope?: string; method?: string }> }) {
  const { companyId } = await params;
  const sp = await searchParams;
  const month = isMonth(sp.month) ? sp.month : todayIso().slice(0, 7);
  const scope = sp.scope === 'month' ? 'month' : 'ytd';
  const method = sp.method === 'direct' ? 'direct' : 'indirect';
  const [company, cf] = await Promise.all([
    serverApi<Company>(`/companies/${companyId}`),
    serverApi<CashFlow>(`/companies/${companyId}/cash-flow?month=${month}&scope=${scope}`),
  ]);
  const t = th.cashFlow;
  const href = (m: string, s = scope, me = method) => `/c/${companyId}/cash-flow?month=${m}&scope=${s}&method=${me}`;
  const tab = 'flex min-h-11 items-center border border-rule-strong px-4 aria-[current=page]:bg-ink aria-[current=page]:text-paper';
  const rows = cashFlowRows(cf, method);
  const cell = 'border border-rule px-2 py-1.5';
  return (
    <div className="flex flex-col gap-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-end gap-3 border-b-2 border-ink pb-2.5">
        <h1 className="font-doc text-[20px] font-bold sm:text-2xl">{t.title}</h1>
        <div className="flex flex-wrap items-center gap-3 sm:ml-auto">
          <nav aria-label={th.statements.income} className="flex">
            <Link href={href(month, 'month')} aria-current={scope === 'month' ? 'page' : undefined} className={tab}>{th.statements.scopeMonth}</Link>
            <Link href={href(month, 'ytd')} aria-current={scope === 'ytd' ? 'page' : undefined} className={`${tab} border-l-0`}>{th.statements.scopeYtd}</Link>
          </nav>
          <nav aria-label={t.method} className="flex">
            <Link href={href(month, scope, 'indirect')} aria-current={method === 'indirect' ? 'page' : undefined} className={tab}>{t.indirect}</Link>
            <Link href={href(month, scope, 'direct')} aria-current={method === 'direct' ? 'page' : undefined} className={`${tab} border-l-0`}>{t.direct}</Link>
          </nav>
          <MonthNav month={month} href={(m) => href(m)} />
          <ExportLinks base={`/export/company/${companyId}/cash-flow`} query={`month=${month}&scope=${scope}&method=${method}`} />
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <article aria-label={t.title} className="flex flex-col gap-1 border border-rule-strong bg-paper p-5 sm:p-7">
          <header className="mb-2 border-b-2 border-ink pb-2 text-center">
            <h2 className="font-doc text-[20px] font-bold">{t.title} ({method === 'indirect' ? t.indirect : t.direct})</h2>
            <p className="text-sm">{t.period(company.name, monthLabel(cf.from), monthLabel(cf.month))}</p>
            <p className="text-[13px] text-ink2">{t.unit}</p>
          </header>
          {rows.map((r, i) => (
            r.style === 'heading' ? (
              <h3 key={i} className="mt-2 border-b border-rule pb-1 font-semibold first:mt-0">{r.label}</h3>
            ) : (
              <div key={i} className={`grid grid-cols-[minmax(0,1fr)_auto] gap-3 py-1.5 ${r.style === 'line' ? 'border-b border-rule-faint pl-4' : 'font-medium'} ${r.style === 'total' ? 'border-t-2 border-ink pt-2 font-semibold' : ''}`}>
                <span>{r.code && <span className="font-num text-[13px] text-ink2">{r.code} </span>}<span>{r.label}</span></span>
                {r.amount !== null && <Money value={r.amount} className={r.style === 'total' ? 'border-b-[3px] border-double border-ink' : r.style === 'subtotal' ? 'border-t border-ink pt-0.5' : ''} />}
              </div>
            )
          ))}
          <p role="status" className={`mt-2 text-sm ${cf.matches ? '' : 'neg font-semibold'}`}>
            {cf.matches ? t.matches(formatMoney(cf.closingCash)) : t.mismatch(formatMoney(cf.closingCash), formatMoney(cf.ledgerCash))}
          </p>
        </article>

        <div className="flex flex-col gap-5">
          <section aria-label={t.cashAccounts} className="flex flex-col gap-2">
            <h2 className="text-[17px] font-semibold">{t.cashAccounts}</h2>
            <table className="w-full border-collapse bg-paper text-[14px]">
              <thead className="bg-band text-left text-[13px]">
                <tr>
                  <th className={`${cell} font-medium`}>{th.books.othersAccount}</th>
                  <th className={`${cell} text-right font-medium`}>{t.accountOpening}</th>
                  <th className={`${cell} text-right font-medium`}>{t.accountClosing}</th>
                </tr>
              </thead>
              <tbody>
                {cf.cashAccounts.map((a) => (
                  <tr key={a.code}>
                    <td className={cell}><span className="font-num text-[13px] text-ink2">{a.code} </span>{a.name}</td>
                    <td className={`${cell} text-right`}><Money value={a.opening} /></td>
                    <td className={`${cell} text-right`}><Money value={a.closing} /></td>
                  </tr>
                ))}
                <tr className="font-semibold">
                  <th scope="row" className={`${cell} border-t-2 border-t-ink text-left`}>{th.books.total}</th>
                  <td className={`${cell} border-t-2 border-t-ink text-right`}><Money value={cf.openingCash} /></td>
                  <td className={`${cell} border-t-2 border-t-ink text-right`}><Money value={cf.ledgerCash} className="border-b-[3px] border-double border-ink" /></td>
                </tr>
              </tbody>
            </table>
          </section>
          {cf.nonCash.length > 0 && (
            <section aria-label={t.nonCash} className="flex flex-col gap-2">
              <h2 className="text-[17px] font-semibold">{t.nonCash}</h2>
              <ul className="border-t border-rule-strong bg-paper text-[14px]">
                {cf.nonCash.map((n) => (
                  <li key={n.docNo} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 border-b border-rule px-3 py-2">
                    <span>{n.description || '—'}</span><Money value={n.amount} />
                    <span className="font-num text-[13px] text-ink2">{n.docNo} · {isoToThai(n.date)}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <p className="text-[13px] text-ink2">{t.note}</p>
        </div>
      </div>
    </div>
  );
}
