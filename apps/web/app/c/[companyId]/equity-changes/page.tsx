import Link from 'next/link';
import { ExportLinks } from '@/components/ExportLinks';
import { MonthNav } from '@/components/MonthNav';
import { Money } from '@/components/Money';
import { serverApi } from '@/lib/server-api';
import type { Company, EquityChanges } from '@/lib/api';
import { isMonth, monthLabel, todayIso } from '@/lib/date';
import { formatMoney } from '@/lib/money';
import { th } from '@/i18n/th';

// งบแสดงการเปลี่ยนแปลงส่วนของเจ้าของ (docs/phase6-spec.md ข้อ 3): คอลัมน์ตามบัญชีทุน · รวมปลายงวดเทียบงบแสดงฐานะการเงิน
export default async function EquityChangesPage({
  params, searchParams,
}: { params: Promise<{ companyId: string }>; searchParams: Promise<{ month?: string; scope?: string }> }) {
  const { companyId } = await params;
  const sp = await searchParams;
  const month = isMonth(sp.month) ? sp.month : todayIso().slice(0, 7);
  const scope = sp.scope === 'month' ? 'month' : 'ytd';
  const [company, e] = await Promise.all([
    serverApi<Company>(`/companies/${companyId}`),
    serverApi<EquityChanges>(`/companies/${companyId}/equity-changes?month=${month}&scope=${scope}`),
  ]);
  const t = th.equityChanges;
  const href = (m: string, s = scope) => `/c/${companyId}/equity-changes?month=${m}&scope=${s}`;
  const tab = 'flex min-h-11 items-center border border-rule-strong px-4 aria-[current=page]:bg-ink aria-[current=page]:text-paper';
  const cell = 'border border-rule px-2 py-2';
  const closing = e.rows.find((r) => r.key === 'closing')!;
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
          <ExportLinks base={`/export/company/${companyId}/equity-changes`} query={`month=${month}&scope=${scope}`} />
        </div>
      </div>

      <article aria-label={t.title} className="flex flex-col gap-3 border border-rule-strong bg-paper p-4 sm:p-7">
        <header className="border-b-2 border-ink pb-2 text-center">
          <h2 className="font-doc text-[20px] font-bold">{t.title}</h2>
          <p className="text-sm">{t.period(company.name, monthLabel(e.from), monthLabel(e.month))}</p>
          <p className="text-[13px] text-ink2">{t.unit}</p>
        </header>

        {/* iPad/คอม: ตารางคอลัมน์ตามบัญชีทุน */}
        <table className="w-full border-collapse text-[15px] max-sm:hidden">
          <thead className="bg-band text-[14px]">
            <tr>
              <th className={`${cell} text-left font-medium`}>{t.item}</th>
              {e.columns.map((c) => (
                <th key={c.key} className={`${cell} w-36 text-right font-medium`}>
                  {t.columns[c.key]}
                  {c.accounts.length > 0 && <span className="block font-num text-[12px] text-ink2">{c.accounts.map((a) => a.code).join(', ')}</span>}
                </th>
              ))}
              <th className={`${cell} w-36 text-right font-medium`}>{t.total}</th>
            </tr>
          </thead>
          <tbody>
            {e.rows.map((r) => {
              const strong = r.key === 'closing' ? 'border-t-2 border-t-ink font-semibold' : r.key === 'opening' ? 'font-medium' : '';
              return (
                <tr key={r.key}>
                  <th scope="row" className={`${cell} text-left font-normal ${strong} ${r.key === 'opening' || r.key === 'closing' ? '' : 'pl-6'}`}>{t.rows[r.key]}</th>
                  {e.columns.map((c) => (
                    <td key={c.key} className={`${cell} text-right ${strong}`}><Money value={r.values[c.key] ?? '0.00'} className={r.key === 'closing' ? 'border-b-[3px] border-double border-ink' : ''} /></td>
                  ))}
                  <td className={`${cell} text-right ${strong}`}><Money value={r.total} className={r.key === 'closing' ? 'border-b-[3px] border-double border-ink' : ''} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {/* มือถือ: ทีละบรรทัด (ยอดรวม) แล้วแยกคอลัมน์เป็นบรรทัดย่อย */}
        <ul className="flex flex-col sm:hidden">
          {e.rows.map((r) => (
            <li key={r.key} className={`border-b border-rule-faint py-2 ${r.key === 'closing' ? 'border-t-2 border-t-ink font-semibold' : ''}`}>
              <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-3">
                <span>{t.rows[r.key]}</span><Money value={r.total} />
              </div>
              <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 pl-4 text-[14px] font-normal text-ink2">
                {e.columns.filter((c) => !/^-?0\.00$/.test(r.values[c.key] ?? '0.00')).map((c) => (
                  <div key={c.key} className="contents"><dt>{t.columns[c.key]}</dt><dd className="text-right"><Money value={r.values[c.key]!} /></dd></div>
                ))}
              </dl>
            </li>
          ))}
        </ul>

        <p role="status" className={`text-sm ${e.matches ? '' : 'neg font-semibold'}`}>
          {e.matches ? t.matches(formatMoney(e.positionEquity)) : t.mismatch(formatMoney(closing.total), formatMoney(e.positionEquity))}
        </p>
      </article>
      <p className="text-[13px] text-ink2">{t.note}</p>
    </div>
  );
}
