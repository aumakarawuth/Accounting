import Link from 'next/link';
import { MonthNav } from '@/components/MonthNav';
import { SalesTable } from '@/components/sales/SalesTable';
import { serverApi } from '@/lib/server-api';
import type { Company, SalesKindSql, SalesRow } from '@/lib/api';
import { isMonth, monthLabel, todayIso } from '@/lib/date';
import { th } from '@/i18n/th';

const KINDS: SalesKindSql[] = ['sales_invoice', 'cash_sale', 'credit_note', 'debit_note'];

// เอกสารขายรายเดือน แยกตามชนิด (ขายเชื่อ ขายสด ลดหนี้ เพิ่มหนี้) — ใบรับชำระอยู่ที่หน้ารับชำระ
export default async function SalesList({
  params, searchParams,
}: { params: Promise<{ companyId: string }>; searchParams: Promise<{ month?: string; kind?: string }> }) {
  const { companyId } = await params;
  const sp = await searchParams;
  const month = isMonth(sp.month) ? sp.month : todayIso().slice(0, 7);
  const kind = KINDS.find((k) => k === sp.kind) ?? null;
  const [company, rows] = await Promise.all([
    serverApi<Company>(`/companies/${companyId}`),
    serverApi<SalesRow[]>(`/companies/${companyId}/sales?month=${month}${kind ? `&kind=${kind}` : ''}`),
  ]);
  const list = kind ? rows : rows.filter((r) => r.kind !== 'receipt');
  const url = (m: string, k: string | null) => `/c/${companyId}/sales/invoices?month=${m}${k ? `&kind=${k}` : ''}`;
  const canPost = company.can_write && !company.locked;
  const primary = 'inline-flex min-h-11 items-center justify-center rounded-doc bg-ink px-4 font-medium text-paper max-sm:min-h-13';
  const secondary = 'inline-flex min-h-11 items-center justify-center rounded-doc border border-ink px-4 font-medium max-sm:min-h-13';

  return (
    <div className="flex min-h-full flex-col gap-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-end gap-3 border-b-2 border-ink pb-2.5">
        <h1 className="min-w-0 font-doc text-[20px] font-bold sm:text-2xl">{th.sales.listTitle} {company.name} · {monthLabel(month)}</h1>
        <div className="sm:ml-auto"><MonthNav month={month} href={(m) => url(m, kind)} /></div>
      </div>
      <nav aria-label={th.sales.kind} className="-mx-4 flex overflow-x-auto px-4 sm:mx-0 sm:px-0">
        {[null, ...KINDS].map((k) => (
          <Link key={k ?? 'all'} href={url(month, k)} aria-current={k === kind ? 'page' : undefined}
            className="flex min-h-11 shrink-0 items-center border-b-2 border-transparent px-3.5 whitespace-nowrap aria-[current=page]:border-ink aria-[current=page]:font-semibold">
            {k ? th.sales.kinds[k] : th.sales.all}
          </Link>
        ))}
      </nav>
      <SalesTable companyId={companyId} rows={list} />
      {canPost && (
        <div className="sticky bottom-0 -mx-4 -mb-4 mt-auto grid grid-cols-2 gap-3 border-t border-rule-strong bg-paper px-4 py-2.5 sm:static sm:m-0 sm:flex sm:border-0 sm:bg-transparent sm:p-0">
          <Link href={`/c/${companyId}/sales/new?kind=invoice`} className={primary}>{th.sales.newInvoice}</Link>
          <Link href={`/c/${companyId}/sales/new?kind=cash-sale`} className={secondary}>{th.sales.newCashSale}</Link>
        </div>
      )}
    </div>
  );
}
