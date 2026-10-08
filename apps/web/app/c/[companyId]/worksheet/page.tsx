import Link from 'next/link';
import { MonthNav } from '@/components/MonthNav';
import { serverApi } from '@/lib/server-api';
import type { Company, Worksheet, WsPair } from '@/lib/api';
import { isMonth, monthEndLabel, todayIso } from '@/lib/date';
import { formatMoney, isNegative } from '@/lib/money';
import { th } from '@/i18n/th';

// กระดาษทำการ 6 / 8 / 10 ช่อง (คู่เดบิต/เครดิต) ตามแบบที่โรงเรียนเปิดใช้
// ตารางกว้างเลื่อนแนวนอนในกรอบ ชื่อบัญชีติดซ้าย · ยอดศูนย์เว้นว่างเหมือนกระดาษทำการที่เขียนมือ
type Group = 'tb' | 'adj' | 'atb' | 'is' | 'bs';
const GROUPS: Record<number, Group[]> = { 6: ['tb', 'is', 'bs'], 8: ['tb', 'adj', 'is', 'bs'], 10: ['tb', 'adj', 'atb', 'is', 'bs'] };

export default async function WorksheetPage({
  params, searchParams,
}: { params: Promise<{ companyId: string }>; searchParams: Promise<{ month?: string; format?: string }> }) {
  const { companyId } = await params;
  const sp = await searchParams;
  const month = isMonth(sp.month) ? sp.month : todayIso().slice(0, 7);
  const fq = ['6', '8', '10'].includes(sp.format ?? '') ? `&format=${sp.format}` : '';
  const [company, w] = await Promise.all([
    serverApi<Company>(`/companies/${companyId}`),
    serverApi<Worksheet>(`/companies/${companyId}/worksheet?month=${month}${fq}`),
  ]);
  const t = th.worksheet;
  const href = (m: string, f = w.format) => `/c/${companyId}/worksheet?month=${m}${f ? `&format=${f}` : ''}`;
  const tab = 'flex min-h-11 items-center border border-rule-strong px-4 aria-[current=page]:bg-ink aria-[current=page]:text-paper';

  return (
    <div className="flex flex-col gap-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-end gap-3 border-b-2 border-ink pb-2.5">
        <div className="min-w-0">
          <h1 className="font-doc text-[20px] font-bold sm:text-2xl">{t.heading(company.name, monthEndLabel(month))}</h1>
          <p className="text-sm text-ink2">{w.format === 6 ? t.noteSix : t.note}</p>
        </div>
        <div className="sm:ml-auto print:hidden"><MonthNav month={month} href={(m) => href(m)} /></div>
      </div>

      {w.format === null ? (
        <p className="border border-rule-strong bg-paper p-4">{t.disabled}</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3 print:hidden">
            {w.formats.length > 1 && (
              <nav aria-label={t.formatLabel} className="flex">
                {w.formats.map((f) => (
                  <Link key={f} href={href(month, f)} aria-current={f === w.format ? 'page' : undefined} className={tab}>{t.format(f)}</Link>
                ))}
              </nav>
            )}
            {company.can_write && !company.locked && w.format !== 6 && (
              <Link href={`/c/${companyId}/journal/new?adjusting=1`} className="flex min-h-11 items-center underline">{t.newAdjust}</Link>
            )}
          </div>
          {(w.rows ?? []).length === 0 ? <p className="text-ink2">{t.empty}</p> : <Sheet w={w} groups={GROUPS[w.format]!} />}
        </>
      )}
    </div>
  );
}

function Sheet({ w, groups }: { w: Worksheet; groups: Group[] }) {
  const t = th.worksheet;
  const cell = 'h-10 border border-rule px-2 text-right font-num whitespace-nowrap';
  const amt = (v: string | undefined) => (!v || v === '0.00' ? '' : formatMoney(v));
  const pair = (p: WsPair | null | undefined, k: string) => [
    <td key={`${k}d`} className={cell}>{amt(p?.debit)}</td>,
    <td key={`${k}c`} className={cell}>{amt(p?.credit)}</td>,
  ];
  const profit = !isNegative(w.netIncome ?? '0');
  const sticky = 'sticky left-0 z-10 bg-paper';
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-[13px] text-ink2 lg:hidden print:hidden">{t.scrollHint}</p>
      <div className="overflow-x-auto border border-rule-strong" role="region" aria-label={t.title} tabIndex={0}>
        <table className="w-max min-w-full border-collapse bg-paper text-[14px]">
          <thead className="bg-band text-sm">
            <tr>
              <th rowSpan={2} className={`${sticky} h-10 w-[9.5rem] min-w-[9.5rem] border border-rule bg-band px-2 text-left font-medium sm:w-auto sm:min-w-[15rem]`}>{t.account}</th>
              {groups.map((g) => (
                <th key={g} colSpan={2} className="h-10 border border-rule px-2 font-medium">
                  <span className="sm:hidden">{t.groupsShort[g]}</span><span className="max-sm:hidden">{t.groups[g]}</span>
                </th>
              ))}
            </tr>
            <tr>
              {groups.flatMap((g) => [
                <th key={`${g}d`} className="h-9 min-w-[6.5rem] border border-rule px-2 text-right font-normal">{t.dr}</th>,
                <th key={`${g}c`} className="h-9 min-w-[6.5rem] border border-rule px-2 text-right font-normal">{t.cr}</th>,
              ])}
            </tr>
          </thead>
          <tbody>
            {w.rows!.map((r) => (
              <tr key={r.code}>
                <th scope="row" className={`${sticky} h-10 border border-rule px-2 py-1 text-left text-[13px] leading-snug font-normal sm:text-[14px]`}>
                  <span className="font-num text-[13px] text-ink2">{r.code}</span> {r.name}
                </th>
                {groups.flatMap((g) => pair(r[g], g))}
              </tr>
            ))}
          </tbody>
          <tfoot className="font-semibold">
            <tr>
              <th scope="row" className={`${sticky} h-10 border border-rule px-2 text-left`}>{t.total}</th>
              {groups.flatMap((g) => pair(w.totals![g], g))}
            </tr>
            <tr>
              <th scope="row" className={`${sticky} h-10 border border-rule px-2 text-left`}>{profit ? t.profit : t.loss}</th>
              {groups.flatMap((g) => pair(g === 'is' || g === 'bs' ? w.result![g] : null, g))}
            </tr>
            <tr className="border-t-2 border-ink">
              <th scope="row" className={`${sticky} h-10 border border-rule px-2 text-left`} />
              {groups.flatMap((g) => pair(g === 'is' || g === 'bs' ? w.grand![g] : null, g))}
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
