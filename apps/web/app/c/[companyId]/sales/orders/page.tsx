import Link from 'next/link';
import { serverApi } from '@/lib/server-api';
import type { Company, OrderKind, SalesOrderRow } from '@/lib/api';
import { isoToThai } from '@/lib/date';
import { formatMoney } from '@/lib/money';
import { th } from '@/i18n/th';

const KINDS: OrderKind[] = ['quotation', 'sales_order'];

// ใบเสนอราคา / ใบสั่งขาย (ไม่ลงบัญชี) แยกแท็บ พร้อมสถานะที่คิดจากเอกสารที่อ้าง
export default async function OrdersPage({
  params, searchParams,
}: { params: Promise<{ companyId: string }>; searchParams: Promise<{ kind?: string }> }) {
  const { companyId } = await params;
  const sp = await searchParams;
  const kind = KINDS.find((k) => k === sp.kind) ?? 'quotation';
  const [company, rows] = await Promise.all([
    serverApi<Company>(`/companies/${companyId}`),
    serverApi<SalesOrderRow[]>(`/companies/${companyId}/sales-orders?kind=${kind}`),
  ]);
  const t = th.orders;
  const canPost = company.can_write && !company.locked;
  const cell = 'border border-rule px-2.5 py-2';
  const status = (r: SalesOrderRow) => (r.kind === 'sales_order' && r.status === 'open' ? t.statusOpenOrder : t.status[r.status]);
  return (
    <div className="flex min-h-full flex-col gap-4 p-4 sm:p-6">
      <div className="border-b-2 border-ink pb-2.5">
        <h1 className="font-doc text-[20px] font-bold sm:text-2xl">{t.title} {company.name}</h1>
        <p className="text-sm text-ink2">{t.noPost}</p>
      </div>
      <nav aria-label={t.title} className="flex">
        {KINDS.map((k) => (
          <Link key={k} href={`/c/${companyId}/sales/orders?kind=${k}`} aria-current={k === kind ? 'page' : undefined}
            className="flex min-h-11 items-center border-b-2 border-transparent px-3.5 aria-[current=page]:border-ink aria-[current=page]:font-semibold">
            {t.tabs[k]}
          </Link>
        ))}
      </nav>
      {rows.length === 0 ? <p className="text-ink2">{t.empty}</p> : (
        <>
          <table className="w-full border-collapse bg-paper text-[15px] max-sm:hidden">
            <thead className="bg-band text-left text-sm">
              <tr>
                <th className={`${cell} font-medium`}>{th.sales.docNo}</th>
                <th className={`${cell} font-medium`}>{th.sales.date}</th>
                <th className={`${cell} font-medium`}>{th.sales.customer}</th>
                <th className={`${cell} font-medium`}>{kind === 'quotation' ? t.untilQuote : t.untilOrder}</th>
                <th className={`${cell} text-right font-medium`}>{th.sales.total}</th>
                <th className={`${cell} font-medium`}>{th.closing.status}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className={`${cell} font-num`}><Link href={`/c/${companyId}/sales/orders/${r.id}`} className="underline">{r.docNo}</Link></td>
                  <td className={`${cell} font-num`}>{isoToThai(r.date)}</td>
                  <td className={cell}>{r.partyCode} {r.partyName}</td>
                  <td className={`${cell} font-num`}>{r.untilDate ? isoToThai(r.untilDate) : ''}</td>
                  <td className={`${cell} num`}>{formatMoney(r.total)}</td>
                  <td className={`${cell} ${r.status === 'cancelled' ? 'text-ink2' : ''}`}>{status(r)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <ul className="border-t border-rule-strong bg-paper sm:hidden">
            {rows.map((r) => (
              <li key={r.id} className="border-b border-rule">
                <Link href={`/c/${companyId}/sales/orders/${r.id}`} className="grid min-h-12 grid-cols-[minmax(0,1fr)_auto] gap-x-3 px-4 py-2">
                  <span className="font-num">{r.docNo}</span><span className="num">{formatMoney(r.total)}</span>
                  <span className="text-sm">{r.partyName}</span><span className="text-right text-sm text-ink2">{status(r)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
      {canPost && (
        <div className="sticky bottom-0 -mx-4 -mb-4 mt-auto grid grid-cols-2 gap-3 border-t border-rule-strong bg-paper px-4 py-2.5 sm:static sm:m-0 sm:flex sm:border-0 sm:bg-transparent sm:p-0">
          <Link href={`/c/${companyId}/sales/new?kind=quotation`} className="inline-flex min-h-11 items-center justify-center rounded-doc bg-ink px-4 font-medium text-paper max-sm:min-h-13">{t.newQuote}</Link>
          <Link href={`/c/${companyId}/sales/new?kind=sales-order`} className="inline-flex min-h-11 items-center justify-center rounded-doc border border-ink px-4 font-medium max-sm:min-h-13">{t.newOrder}</Link>
        </div>
      )}
    </div>
  );
}
