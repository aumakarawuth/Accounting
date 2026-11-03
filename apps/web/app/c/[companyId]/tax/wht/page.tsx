import Link from 'next/link';
import { MonthNav } from '@/components/MonthNav';
import { Money } from '@/components/Money';
import { TaxAction } from '@/components/tax/TaxAction';
import { serverApi } from '@/lib/server-api';
import type { WhtCertRow, WhtReport } from '@/lib/api';
import { addDays, addMonths, isMonth, isoToThai, monthLabel, todayIso } from '@/lib/date';
import { th } from '@/i18n/th';

// ภาษีหัก ณ ที่จ่ายประจำเดือน: ภ.ง.ด.3 (บุคคลธรรมดา) และ ภ.ง.ด.53 (นิติบุคคล) จากหนังสือรับรอง 50 ทวิ + นำส่ง
export default async function WhtPage({
  params, searchParams,
}: { params: Promise<{ companyId: string }>; searchParams: Promise<{ month?: string }> }) {
  const { companyId } = await params;
  const sp = await searchParams;
  const month = isMonth(sp.month) ? sp.month : todayIso().slice(0, 7);
  const r = await serverApi<WhtReport>(`/companies/${companyId}/tax/wht?month=${month}`);
  const t = th.tax;
  const writable = r.company.canWrite && !r.company.locked;
  const c = (p: string) => `/c/${companyId}${p}`;
  const monthEnd = addDays(`${addMonths(month, 1)}-01`, -1);
  const today = todayIso();
  const remitDate = today > monthEnd ? today : `${addMonths(month, 1)}-07`;
  const link = 'inline-flex min-h-11 items-center justify-center rounded-doc border border-ink px-4 font-medium max-sm:min-h-13';

  return (
    <div className="flex min-h-full flex-col gap-5 p-4 sm:p-6">
      <div className="flex flex-wrap items-end gap-3 border-b-2 border-ink pb-2.5">
        <h1 className="min-w-0 font-doc text-[20px] font-bold sm:text-2xl">{t.whtTitle} · {monthLabel(month)}</h1>
        <div className="sm:ml-auto print:hidden"><MonthNav month={month} href={(m) => c(`/tax/wht?month=${m}`)} /></div>
      </div>
      <p className="text-sm text-ink2">{t.reportHead(r.company.name, r.company.taxId, r.company.branchNo)}</p>
      {!r.company.canWrite && <p className="text-sm text-ink2 print:hidden">{t.readOnly}</p>}

      {r.forms.map((f) => {
        const form = t.forms[f.form]!;
        const rows = r.certificates.filter((x) => x.form === f.form);
        return (
          <section key={f.form} aria-label={form.name} className="@container flex flex-col gap-2.5">
            <div className="flex flex-wrap items-baseline gap-x-3 border-b border-ink pb-1.5">
              <h2 className="font-doc text-[18px] font-bold">{form.name}</h2>
              <span className="text-sm text-ink2">{form.who} · {t.count(f.count)}</span>
              <span className="ml-auto font-semibold">{t.wcol.wht} <Money value={f.amount} /></span>
            </div>
            {rows.length === 0 ? <p className="text-ink2">{t.noCerts}</p> : <CertTable companyId={companyId} rows={rows} base={f.base} amount={f.amount} />}
            {f.remittance ? (
              <div className="flex flex-wrap items-center gap-3">
                <p className="text-sm">{t.remittedAs(f.remittance.entryDocNo, isoToThai(f.remittance.date), f.remittance.certCount)}</p>
                <Link className={`${link} print:hidden`} href={c(`/journal/${f.remittance.entryId}`)}>{t.viewEntry(f.remittance.entryDocNo)}</Link>
              </div>
            ) : writable && f.count > 0 ? (
              <div className="max-w-xl">
                <TaxAction label={t.remit(form.name)} title={t.remit(form.name)} explain={t.remitExplain}
                  path={`/companies/${companyId}/tax/wht/${month}/${f.form}/remit`} input="payment" cashAccounts={r.cashAccounts} defaultDate={remitDate} />
              </div>
            ) : null}
          </section>
        );
      })}
      <p className="text-[13px] text-ink2">{t.dueWht}</p>
    </div>
  );
}

function CertTable({ companyId, rows, base, amount }: { companyId: string; rows: WhtCertRow[]; base: string; amount: string }) {
  const t = th.tax.wcol;
  const kinds = th.purchases.cert.kinds;
  const href = (r: WhtCertRow) => `/c/${companyId}/purchases/documents/${r.documentId}`;
  const cell = 'h-11 border border-rule px-2.5';
  const voided = (r: WhtCertRow) => (r.voided ? <span className="text-[13px]"> · {th.tax.certVoided}</span> : null);
  return (
    <>
      <table className="w-full border-collapse bg-paper text-[15px] max-sm:hidden">
        <thead className="bg-band text-left text-sm">
          <tr>
            <th className={`${cell} w-12 font-medium`}>{th.tax.col.no}</th>
            <th className={`${cell} w-32 font-medium`}>{t.cert} / {t.date}</th>
            <th className={`${cell} font-medium`}>{t.payee}</th>
            <th className={`${cell} w-36 font-medium`}>{t.taxId}</th>
            <th className={`${cell} w-40 font-medium`}>{t.kind} / {t.rate}</th>
            <th className={`${cell} w-32 text-right font-medium`}>{t.paid}</th>
            <th className={`${cell} w-28 text-right font-medium`}>{t.wht}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.certNo} className={r.voided ? 'text-ink2 line-through decoration-ink2' : ''}>
              <td className={`${cell} font-num`}>{i + 1}</td>
              <td className={`${cell} font-num`}>
                <Link href={href(r)} className="underline decoration-rule-input">{r.certNo}</Link>
                <span className="block text-[13px] text-ink2">{isoToThai(r.date)}</span>
              </td>
              <td className={cell}>{r.payeeName}{voided(r)}</td>
              <td className={`${cell} font-num text-sm`}>{r.payeeTaxId}</td>
              <td className={`${cell} text-sm`}>{kinds[r.whtKind]} <span className="font-num">{Number(r.whtRate)}%</span></td>
              <td className={`${cell} text-right`}><Money value={r.base} /></td>
              <td className={`${cell} text-right`}><Money value={r.amount} /></td>
            </tr>
          ))}
        </tbody>
        <tfoot className="font-semibold">
          <tr>
            <td className={cell} colSpan={5}>{th.tax.total}</td>
            <td className={`${cell} text-right`}><Money value={base} /></td>
            <td className={`${cell} text-right`}><Money value={amount} /></td>
          </tr>
        </tfoot>
      </table>
      <ul className="border-t border-rule-strong bg-paper sm:hidden">
        {rows.map((r) => (
          <li key={r.certNo} className={`border-b border-rule ${r.voided ? 'text-ink2' : ''}`}>
            <Link href={href(r)} className="grid min-h-14 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 px-4 py-2">
              <span className="truncate">{r.payeeName}{voided(r)}</span>
              <Money value={r.amount} />
              <span className="font-num text-[13px] text-ink2">{r.certNo} · {isoToThai(r.date)} · {kinds[r.whtKind]} {Number(r.whtRate)}%</span>
              <span className="text-right text-[13px] text-ink2"><Money value={r.base} /></span>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
