import Link from 'next/link';
import { MonthNav } from '@/components/MonthNav';
import { Money } from '@/components/Money';
import { TaxAction } from '@/components/tax/TaxAction';
import { VatTable } from '@/components/tax/VatTable';
import { serverApi } from '@/lib/server-api';
import type { VatClosing, VatReport } from '@/lib/api';
import { addDays, addMonths, isMonth, isoToThai, monthLabel, todayIso } from '@/lib/date';
import { th } from '@/i18n/th';

// ภาษีมูลค่าเพิ่มประจำเดือน: สรุป ภ.พ.30 (ปิด ชำระ ยกเลิกการปิด) + รายงานภาษีขาย + รายงานภาษีซื้อ พิมพ์ได้
export default async function VatPage({
  params, searchParams,
}: { params: Promise<{ companyId: string }>; searchParams: Promise<{ month?: string }> }) {
  const { companyId } = await params;
  const sp = await searchParams;
  const month = isMonth(sp.month) ? sp.month : todayIso().slice(0, 7);
  const r = await serverApi<VatReport>(`/companies/${companyId}/tax/vat?month=${month}`);
  const t = th.tax;
  const writable = r.company.canWrite && !r.company.locked;
  const c = (p: string) => `/c/${companyId}${p}`;
  const monthEnd = addDays(`${addMonths(month, 1)}-01`, -1);
  const today = todayIso();
  const payDate = today > monthEnd ? today : `${addMonths(month, 1)}-15`;

  return (
    <div className="flex min-h-full flex-col gap-5 p-4 sm:p-6">
      <div className="flex flex-wrap items-end gap-3 border-b-2 border-ink pb-2.5">
        <h1 className="min-w-0 font-doc text-[20px] font-bold sm:text-2xl">{t.vatTitle} · {monthLabel(month)}</h1>
        <div className="sm:ml-auto print:hidden"><MonthNav month={month} href={(m) => c(`/tax/vat?month=${m}`)} /></div>
      </div>
      <p className="text-sm text-ink2">{t.reportHead(r.company.name, r.company.taxId, r.company.branchNo)}</p>

      {!r.company.vatRegistered ? (
        <p className="border border-rule-strong bg-paper p-4">{t.notRegistered}</p>
      ) : (
        <>
          <div className="@container flex flex-col gap-3">
            <div className="grid items-start gap-3 @3xl:grid-cols-[minmax(0,26rem)_minmax(0,1fr)] @3xl:gap-5">
              <Summary r={r} />
              <div className="flex flex-col gap-3">
                {!r.company.canWrite && <p className="text-sm text-ink2 print:hidden">{t.readOnly}</p>}
                {writable && <Actions companyId={companyId} r={r} payDate={payDate} />}
                <p className="text-[13px] text-ink2">{t.dueVat}</p>
              </div>
            </div>
          </div>
          <section aria-label={t.salesReport} className="flex flex-col gap-2">
            <h2 className="font-doc text-[17px] font-bold">{t.salesReport}</h2>
            <VatTable companyId={companyId} side="sales" rows={r.sales} />
          </section>
          <section aria-label={t.purchaseReport} className="flex flex-col gap-2 print:break-before-page">
            <h2 className="font-doc text-[17px] font-bold">{t.purchaseReport}</h2>
            <VatTable companyId={companyId} side="purchases" rows={r.purchases} />
          </section>
          {r.history.length > 0 && <History companyId={companyId} rows={r.history} />}
        </>
      )}
    </div>
  );
}

function Summary({ r }: { r: VatReport }) {
  const t = th.tax;
  const s = r.closing ?? r.preview;
  const row = 'flex min-h-10 items-center justify-between gap-3 border-b border-rule px-4';
  return (
    <section aria-label={t.summary} className="border border-ink bg-paper">
      <h2 className="border-b border-ink bg-band px-4 py-2 font-doc text-[17px] font-bold">{t.summary}</h2>
      <dl>
        <div className={row}><dt>{t.outputVat}</dt><dd><Money value={s.outputVat} /></dd></div>
        <div className={row}><dt>{t.inputVat}</dt><dd><Money value={s.inputVat} /></dd></div>
        {s.carryUsed !== '0.00' && <div className={row}><dt>{t.carryUsed}</dt><dd><Money value={s.carryUsed} /></dd></div>}
        {s.refundable !== '0.00' ? (
          <div className={`${row} font-semibold`}><dt>{t.refundable}</dt><dd><Money value={s.refundable} /></dd></div>
        ) : s.payable !== '0.00' ? (
          <div className={`${row} font-semibold`}><dt>{t.payable}</dt><dd><Money value={s.payable} /></dd></div>
        ) : (
          <div className={`${row} font-semibold`}><dt>{t.nothing}</dt><dd><Money value="0.00" /></dd></div>
        )}
      </dl>
      <p className="px-4 py-2 text-sm">
        {r.closing
          ? r.closing.entryDocNo ? t.closedAs(r.closing.entryDocNo) : t.closedNoEntry
          : t.preview}
        {r.closing?.paidDocNo && r.closing.paidDate && <span className="block">{t.paidAs(r.closing.paidDocNo, isoToThai(r.closing.paidDate))}</span>}
      </p>
    </section>
  );
}

function Actions({ companyId, r, payDate }: { companyId: string; r: VatReport; payDate: string }) {
  const t = th.tax;
  const api = `/companies/${companyId}/tax/vat`;
  const link = 'inline-flex min-h-11 items-center justify-center rounded-doc border border-ink px-4 font-medium max-sm:min-h-13';
  const cl = r.closing;
  if (!cl) {
    if (r.preview.earlierOpen) return <p className="text-sm">{t.earlierOpen}</p>;
    if (r.preview.laterClosed) return <p className="text-sm">{t.laterClosed}</p>;
    return <TaxAction label={t.close} title={t.close} explain={t.closeExplain} path={`${api}/${r.month}/close`} input="none" />;
  }
  return (
    <div className="flex flex-col gap-2.5 @md:flex-row @md:flex-wrap @md:items-start print:hidden">
      {cl.entryId && cl.entryDocNo && <Link className={link} href={`/c/${companyId}/journal/${cl.entryId}`}>{t.viewEntry(cl.entryDocNo)}</Link>}
      {cl.paidEntryId && cl.paidDocNo && <Link className={link} href={`/c/${companyId}/journal/${cl.paidEntryId}`}>{t.viewEntry(cl.paidDocNo)}</Link>}
      {cl.payable !== '0.00' && !cl.paidDocNo && (
        <TaxAction label={t.pay} title={t.payTitle} explain={t.dueVat} path={`${api}/closings/${cl.id}/pay`} input="payment"
          cashAccounts={r.cashAccounts} defaultDate={payDate} />
      )}
      {!cl.paidDocNo && !r.preview.laterClosed && (
        <TaxAction label={t.voidClose} title={t.voidCloseTitle} explain={t.voidCloseExplain} path={`${api}/closings/${cl.id}/void`}
          input="reason" variant="secondary" />
      )}
    </div>
  );
}

function History({ companyId, rows }: { companyId: string; rows: VatClosing[] }) {
  const t = th.tax;
  return (
    <section aria-label={t.history} className="flex flex-col gap-2 print:hidden">
      <h2 className="font-doc text-[17px] font-bold">{t.history}</h2>
      <ul className="border-t border-rule-strong bg-paper">
        {rows.map((h) => (
          <li key={h.id} className={`border-b border-rule ${h.voidedAt ? 'text-ink2' : ''}`}>
            <Link href={`/c/${companyId}/tax/vat?month=${h.month}`} className="grid min-h-12 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 px-4 py-1.5">
              <span>
                {monthLabel(h.month)}
                <span className="block text-[13px] text-ink2">
                  {h.voidedAt ? t.historyVoided(h.voidReason ?? '') : h.paidDocNo ? t.paidAs(h.paidDocNo, isoToThai(h.paidDate ?? '')) : h.entryDocNo ?? t.closedNoEntry}
                </span>
              </span>
              <span className="text-right text-sm">
                {h.refundable !== '0.00' ? <>{t.refundable} <Money value={h.refundable} /></> : <>{t.payable} <Money value={h.payable} /></>}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
