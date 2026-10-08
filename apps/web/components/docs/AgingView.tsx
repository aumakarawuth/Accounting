import Link from 'next/link';
import { Money } from '@/components/Money';
import type { AgingBucket, Payables, Receivables } from '@/lib/api';
import { isoToThai, thaiToIso } from '@/lib/date';
import { formatMoney } from '@/lib/money';
import { th } from '@/i18n/th';

const BUCKETS: AgingBucket[] = ['current', 'd30', 'd60', 'd90', 'over90'];

/** วันที่จากช่อง "ณ วันที่" (พ.ศ. หรือ ISO) */
export function parseAsOf(v: string | undefined): string | null {
  return v ? thaiToIso(v) ?? (/^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null) : null;
}

// ลูกหนี้/เจ้าหนี้คงค้าง ณ วันที่ แยกอายุหนี้ตามวันครบกำหนด รายคู่ค้าและรายใบ
export function AgingView({ base, title, r, area, party, empty }: {
  base: string; title: string; r: Receivables | Payables; area: 'sales' | 'purchases'; party: string; empty: string;
}) {
  const cell = 'h-11 border border-rule px-2.5';
  const head = `${cell} bg-band text-sm font-medium`;

  return (
    <div className="flex flex-col gap-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-end gap-3 border-b-2 border-ink pb-2.5">
        <h1 className="min-w-0 font-doc text-[20px] font-bold sm:text-2xl">{title}</h1>
        <form className="flex items-end gap-2 sm:ml-auto">
          <label className="flex flex-col text-sm">
            {th.sales.asOf}
            <input name="asOf" inputMode="numeric" defaultValue={isoToThai(r.asOf)} className="h-11 w-36 border-b border-rule-input bg-transparent font-num text-base" />
          </label>
          <button className="min-h-11 rounded-doc border border-ink px-4 font-medium">{th.sales.asOfSubmit}</button>
        </form>
      </div>

      <dl className="grid grid-cols-2 gap-px border border-rule bg-rule sm:grid-cols-6">
        {(['all', ...BUCKETS] as const).map((b) => (
          <div key={b} className="flex flex-col gap-0.5 bg-paper px-3 py-2">
            <dt className="text-[13px] text-ink2">{b === 'all' ? th.sales.totalAll : th.sales.buckets[b]}</dt>
            <dd className={b === 'all' ? 'font-semibold' : ''}><Money value={r.totals[b]} /></dd>
          </div>
        ))}
      </dl>

      {r.items.length === 0 ? <p className="text-ink2">{empty}</p> : (
        <>
          <section aria-label={th.sales.byCustomer} className="flex flex-col gap-2">
            <h2 className="font-doc text-[17px] font-bold">{th.sales.byCustomer}</h2>
            <ul className="border-t border-rule-strong bg-paper sm:hidden">
              {r.byParty.map((p) => (
                <li key={p.partyCode} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 border-b border-rule px-3 py-2">
                  <span className="truncate"><span className="font-num">{p.partyCode}</span> {p.partyName}</span>
                  <Money value={p.all} className="font-semibold" />
                  <span className="col-span-2 text-[13px] text-ink2">
                    {BUCKETS.filter((b) => Number(p[b])).map((b) => `${th.sales.buckets[b]} ${formatMoney(p[b])}`).join(' · ')}
                  </span>
                </li>
              ))}
            </ul>
            <div className="overflow-x-auto max-sm:hidden">
              <table className="w-full min-w-[640px] border-collapse bg-paper text-[15px]">
                <thead className="text-left">
                  <tr>
                    <th className={head}>{party}</th>
                    {BUCKETS.map((b) => <th key={b} className={`${head} text-right`}>{th.sales.buckets[b]}</th>)}
                    <th className={`${head} text-right`}>{th.sales.totalAll}</th>
                  </tr>
                </thead>
                <tbody>
                  {r.byParty.map((p) => (
                    <tr key={p.partyCode}>
                      <td className={cell}><span className="font-num">{p.partyCode}</span> {p.partyName}</td>
                      {BUCKETS.map((b) => <td key={b} className={`${cell} text-right`}>{Number(p[b]) ? <Money value={p[b]} /> : ''}</td>)}
                      <td className={`${cell} text-right font-semibold`}><Money value={p.all} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section aria-label={th.sales.byDocument} className="flex flex-col gap-2">
            <h2 className="font-doc text-[17px] font-bold">{th.sales.byDocument}</h2>
            <ul className="border-t border-rule-strong bg-paper">
              {r.items.map((i) => (
                <li key={i.id} className="border-b border-rule">
                  <Link href={`${base}/${area}/documents/${i.id}`} className="grid min-h-14 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 px-3 py-2">
                    <span className="truncate"><span className="font-num">{i.docNo}</span> {i.partyName}{'vendorDocNo' in i && i.vendorDocNo ? ` · ${i.vendorDocNo}` : ''}</span>
                    <Money value={i.open} />
                    <span className="font-num text-[13px] text-ink2">{th.sales.dueDate} {isoToThai(i.dueDate)}</span>
                    <span className={`text-right text-[13px] ${i.daysOverdue > 0 ? 'neg' : 'text-ink2'}`}>{th.sales.overdue(i.daysOverdue)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}
