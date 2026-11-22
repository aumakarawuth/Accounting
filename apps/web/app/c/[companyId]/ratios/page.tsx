import Link from 'next/link';
import { MonthNav } from '@/components/MonthNav';
import { Money } from '@/components/Money';
import { serverApi } from '@/lib/server-api';
import type { Company, Ratios } from '@/lib/api';
import { isMonth, monthLabel, todayIso } from '@/lib/date';
import { th } from '@/i18n/th';

// วิเคราะห์อัตราส่วนทางการเงิน (docs/phase7-spec.md ข้อ 4): สูตร ตัวเลขที่ใช้ ผลลัพธ์ และคำอธิบายสั้นสำหรับสอน
export default async function RatiosPage({
  params, searchParams,
}: { params: Promise<{ companyId: string }>; searchParams: Promise<{ month?: string; scope?: string }> }) {
  const { companyId } = await params;
  const sp = await searchParams;
  const month = isMonth(sp.month) ? sp.month : todayIso().slice(0, 7);
  const scope = sp.scope === 'month' ? 'month' : 'ytd';
  const [company, r] = await Promise.all([
    serverApi<Company>(`/companies/${companyId}`),
    serverApi<Ratios>(`/companies/${companyId}/ratios?month=${month}&scope=${scope}`),
  ]);
  const t = th.ratios;
  const href = (m: string, s = scope) => `/c/${companyId}/ratios?month=${m}&scope=${s}`;
  const tab = 'flex min-h-11 items-center border border-rule-strong px-4 aria-[current=page]:bg-ink aria-[current=page]:text-paper';
  const groups = ['liquidity', 'efficiency', 'profitability', 'leverage'] as const;
  return (
    <div className="flex flex-col gap-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-end gap-3 border-b-2 border-ink pb-2.5">
        <h1 className="font-doc text-[20px] font-bold sm:text-2xl">{t.title}</h1>
        <div className="flex flex-wrap items-center gap-3 sm:ml-auto">
          <nav aria-label={th.statements.income} className="flex">
            <Link href={href(month, 'month')} aria-current={scope === 'month' ? 'page' : undefined} className={tab}>{th.statements.scopeMonth}</Link>
            <Link href={href(month, 'ytd')} aria-current={scope === 'ytd' ? 'page' : undefined} className={`${tab} border-l-0`}>{th.statements.scopeYtd}</Link>
          </nav>
          <MonthNav month={month} href={(m) => href(m)} />
        </div>
      </div>
      <p className="text-sm">{t.period(company.name, monthLabel(r.from), monthLabel(r.month), r.days)}</p>
      <p className="max-w-3xl text-[13px] text-ink2">{t.note}</p>
      {groups.map((g) => (
        <section key={g} aria-label={t.groups[g]} className="flex flex-col gap-2">
          <h2 className="text-[17px] font-semibold">{t.groups[g]}</h2>
          <ul className="grid gap-3 lg:grid-cols-2">
            {r.items.filter((i) => i.group === g).map((i) => (
              <li key={i.key} aria-label={t.names[i.key]} className="flex flex-col gap-2 border border-rule-strong bg-paper p-4">
                <div className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-3 border-b border-rule pb-1.5">
                  <h3 className="font-semibold">{t.names[i.key]}</h3>
                  <p className="text-[18px] font-semibold">
                    {i.value === null ? <span className="text-sm font-normal text-ink2">{t.na}</span>
                      : <><span className={`num ${i.value.startsWith('-') ? 'neg' : ''}`}>{i.value.startsWith('-') ? `(${i.value.slice(1)})` : i.value}</span> <span className="text-sm font-normal">{t.units[i.unit]}</span></>}
                  </p>
                </div>
                <p className="text-sm"><span className="text-ink2">{t.formula}</span> {t.formulas[i.key]}</p>
                <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 text-[14px]">
                  {(t.uses[i.key] ?? []).map((f) => (
                    <div key={f} className="contents"><dt className="text-ink2">{t.figures[f]}</dt><dd className="text-right"><Money value={r.figures[f] ?? '0.00'} /></dd></div>
                  ))}
                </dl>
                <p className="text-[13px] text-ink2">{t.explain[i.key]}</p>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
