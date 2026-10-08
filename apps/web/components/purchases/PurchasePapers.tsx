import { Money } from '@/components/Money';
import { bahtText } from '@/lib/bahttext';
import { isoToThai } from '@/lib/date';
import { formatMoney, fromCents, toCents } from '@/lib/money';
import { formatTaxId } from '@/lib/taxid';
import type { PurchaseDocument, WhtCertificate } from '@/lib/api';
import { th } from '@/i18n/th';

// กระดาษฝั่งซื้อ: บันทึกจากเอกสารผู้ขาย (ซื้อเชื่อ/ซื้อสด/ใบลดหนี้) · ใบสำคัญจ่าย · หนังสือรับรองหัก ณ ที่จ่าย 50 ทวิ
// จัดตามความกว้างของกระดาษเอง (container query) และพิมพ์ได้ (50 ทวิ ขึ้นหน้าใหม่)

const branch = (b: string) => (b === '00000' ? th.sales.headOffice : th.sales.branch(b));
const minus = (a: string, b: string) => fromCents((toCents(a) ?? 0n) - (toCents(b) ?? 0n));
const paperCls = 'flex flex-col gap-3 border border-rule-strong bg-paper p-4 text-[13px] @2xl:gap-3.5 @2xl:p-8 @2xl:text-sm print:border-0 print:p-0';
const cell = '[&_td]:border [&_td]:border-rule [&_td]:px-2 [&_td]:py-1.5 [&_th]:border [&_th]:border-rule [&_th]:bg-band [&_th]:px-2 [&_th]:py-1.5 [&_th]:text-left [&_th]:font-medium';

function Stamp({ doc }: { doc: PurchaseDocument }) {
  const voided = Boolean(doc.voidedAt);
  return (
    <div className={`mt-2 inline-block -rotate-[4deg] border-2 bg-paper px-3 py-1 text-center ${voided ? 'neg border-current' : 'border-ink'}`}>
      <div className="font-semibold tracking-wide">{voided ? th.sales.stampVoided : th.sales.stampPosted}</div>
      <div className="font-num text-[12px]">{voided ? doc.voidDocNo : doc.entryDocNo} · {isoToThai(voided ? doc.voidedAt!.slice(0, 10) : doc.date)}</div>
    </div>
  );
}

function Totals({ doc, rows }: { doc: PurchaseDocument; rows: [string, string, boolean?][] }) {
  return (
    <dl className="grid grid-cols-[minmax(0,1fr)_auto] @2xl:w-[320px] @2xl:self-end">
      {rows.map(([label, value, strong]) => (
        <div key={label} className="contents">
          <dt className={`px-2 py-1 ${strong ? 'border-t border-ink font-semibold' : ''}`}>{label}</dt>
          <dd className={`num px-2 py-1 ${strong ? 'border-t border-b-[3px] border-double border-ink font-semibold' : ''}`}>{formatMoney(value)}</dd>
        </div>
      ))}
      {Number(doc.whtAmount) > 0 && (
        <>
          <dt className="px-2 py-1">{th.purchases.whtAmount} {Number(doc.whtRate)}%</dt><dd className="num px-2 py-1">{formatMoney(doc.whtAmount)}</dd>
          <dt className="px-2 py-1 font-semibold">{th.purchases.netPaid}</dt><dd className="num px-2 py-1 font-semibold">{formatMoney(minus(doc.total, doc.whtAmount))}</dd>
        </>
      )}
    </dl>
  );
}

/** บันทึกจากเอกสารของผู้ขาย: ผู้ขาย เลขที่/วันที่ของผู้ขาย รายการพร้อมบัญชีที่ลง ยอดและภาษี */
export function RecordPaper({ doc }: { doc: PurchaseDocument }) {
  const rows: [string, string, boolean?][] = [[th.sales.subtotal, doc.gross]];
  if (Number(doc.discount) > 0) rows.push([th.sales.discount, doc.discount], [th.sales.afterDiscount, minus(doc.gross, doc.discount)]);
  if (doc.priceMode !== 'none') rows.push([th.sales.base, doc.base], [th.sales.vat(String(Number(doc.vatRate))), doc.vat]);
  rows.push([th.sales.total, doc.total, true]);
  return (
    <div className="@container">
      <article className={paperCls}>
        <div className="flex flex-wrap justify-between gap-x-6 gap-y-2">
          <div className="min-w-0">
            <div className="text-[12px] text-ink2">{th.purchases.recordedFrom}</div>
            <div className="font-doc text-[17px] font-bold @2xl:text-xl">{doc.partyName}</div>
            {doc.partyAddress && <div className="whitespace-pre-line">{doc.partyAddress}</div>}
            {doc.partyTaxId && <div>{th.sales.taxId} <span className="font-num">{formatTaxId(doc.partyTaxId)}</span> · {branch(doc.partyBranchNo)}</div>}
          </div>
          <div className="text-right">
            <div className="font-doc text-[17px] font-bold @2xl:text-xl">{th.purchases.viewTitle[doc.kind]}</div>
            <Stamp doc={doc} />
          </div>
        </div>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 border border-rule-input px-3 py-2 @2xl:grid-cols-[auto_minmax(0,1fr)_auto_minmax(0,1fr)]">
          <dt className="text-ink2">{th.sales.docNo}</dt><dd className="font-num">{doc.docNo}</dd>
          <dt className="text-ink2">{doc.kind === 'purchase_credit_note' ? th.purchases.vendorCnNo : th.purchases.vendorDocNo}</dt><dd className="font-num">{doc.vendorDocNo}</dd>
          <dt className="text-ink2">{th.purchases.date}</dt><dd className="font-num">{isoToThai(doc.date)}</dd>
          {doc.dueDate && <><dt className="text-ink2">{th.sales.dueDate}</dt><dd className="font-num">{isoToThai(doc.dueDate)}</dd></>}
          {doc.refDocNo && <><dt className="text-ink2">{th.sales.ref}</dt><dd className="font-num">{doc.refDocNo}</dd></>}
          {doc.cashAccount && <><dt className="text-ink2">{th.purchases.paidFrom}</dt><dd><span className="font-num">{doc.cashAccount}</span> {doc.cashAccountName}</dd></>}
        </dl>
        {doc.reason && <p><span className="text-ink2">{th.sales.reason}:</span> {doc.reason}</p>}
        <div className="overflow-x-auto">
          <table className={`w-full border-collapse ${cell}`}>
            <thead>
              <tr>
                <th>{th.sales.description}</th>
                <th className="w-20 !text-right">{th.sales.qty}</th>
                <th className="w-24 !text-right @max-2xl:hidden">{th.sales.unitPrice}</th>
                <th className="w-28 !text-right">{th.sales.amount}</th>
                <th className="@max-2xl:hidden">{th.purchases.account}</th>
              </tr>
            </thead>
            <tbody>
              {doc.lines.map((l) => (
                <tr key={l.lineNo}>
                  <td>{l.description}<div className="text-[12px] text-ink2 @2xl:hidden"><span className="font-num">{l.accountCode}</span> {l.accountName}</div></td>
                  <td className="num">{Number(l.qty)} {l.unit}</td>
                  <td className="num @max-2xl:hidden">{formatMoney(l.unitPrice)}</td>
                  <td className="num">{formatMoney(l.amount)}</td>
                  <td className="@max-2xl:hidden"><span className="font-num">{l.accountCode}</span> {l.accountName}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Totals doc={doc} rows={rows} />
        {!doc.vatClaimable && Number(doc.vat) > 0 && <p className="text-ink2">{th.purchases.companyNoVat}</p>}
      </article>
    </div>
  );
}

/** ใบสำคัญจ่าย: หัวบริษัท จ่ายให้ ใบที่จ่าย ยอดหัก ณ ที่จ่าย จ่ายสุทธิเป็นตัวอักษร ช่องลงนาม */
export function VoucherPaper({ doc }: { doc: PurchaseDocument }) {
  const net = minus(doc.total, doc.whtAmount);
  return (
    <div className="@container">
      <article className={paperCls}>
        <div className="flex flex-wrap justify-between gap-x-6 gap-y-2">
          <div className="min-w-0">
            <div className="font-doc text-[17px] font-bold @2xl:text-xl">{doc.companyName}</div>
            {doc.companyAddress && <div className="whitespace-pre-line">{doc.companyAddress}</div>}
            {doc.companyTaxId && <div>{th.sales.taxId} <span className="font-num">{formatTaxId(doc.companyTaxId)}</span> · {branch(doc.companyBranchNo)}</div>}
          </div>
          <div className="text-right">
            <div className="font-doc text-[17px] font-bold @2xl:text-xl">{th.purchases.voucher}</div>
            <Stamp doc={doc} />
          </div>
        </div>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 border border-rule-input px-3 py-2 @2xl:grid-cols-[auto_minmax(0,1fr)_auto_minmax(0,1fr)]">
          <dt className="text-ink2">{th.purchases.payee}</dt><dd>{doc.partyName}</dd>
          <dt className="text-ink2">{th.sales.docNo}</dt><dd className="font-num">{doc.docNo}</dd>
          <dt className="text-ink2">{th.sales.date}</dt><dd className="font-num">{isoToThai(doc.date)}</dd>
          <dt className="text-ink2">{th.purchases.paidFrom}</dt><dd><span className="font-num">{doc.cashAccount}</span> {doc.cashAccountName}</dd>
        </dl>
        <table className={`w-full border-collapse ${cell}`}>
          <thead><tr><th>{th.purchases.settles}</th><th>{th.purchases.vendorDocNo}</th><th className="w-32 !text-right">{th.sales.amount}</th></tr></thead>
          <tbody>
            {doc.settles.map((s) => (
              <tr key={s.id}><td className="font-num whitespace-nowrap">{s.docNo}</td><td className="font-num">{s.vendorDocNo}</td><td className="num">{formatMoney(s.amount)}</td></tr>
            ))}
          </tbody>
        </table>
        <div className="grid gap-3 @2xl:grid-cols-[minmax(0,1fr)_320px]">
          <div className="self-end border border-rule-input px-3 py-2 @max-2xl:order-2">
            <div className="text-[12px] text-ink2">{th.sales.amountInWords} ({th.purchases.netPaid})</div>
            <div>({bahtText(net)})</div>
          </div>
          <Totals doc={doc} rows={[[th.purchases.paymentTotal, doc.total, true]]} />
        </div>
        <div className="mt-6 grid grid-cols-3 gap-4 text-center text-[12px] @2xl:gap-8 @2xl:text-[13px]">
          {[th.purchases.preparedBy, th.purchases.approvedBy, th.purchases.receivedBy].map((s) => (
            <div key={s}><div className="h-9 border-b border-dotted border-ink" />{s}</div>
          ))}
        </div>
      </article>
    </div>
  );
}

/** หนังสือรับรองการหักภาษี ณ ที่จ่าย (50 ทวิ) แบบย่อเพื่อการเรียน */
export function CertificatePaper({ cert }: { cert: WhtCertificate }) {
  const party = (title: string, name: string, taxId: string | null, br: string, address: string) => (
    <div className="border border-rule-input px-3 py-2">
      <div className="font-semibold">{title}</div>
      <div>{th.purchases.cert.name} {name}</div>
      {taxId && <div>{th.purchases.cert.taxId} <span className="font-num">{formatTaxId(taxId)}</span> · {branch(br)}</div>}
      {address && <div>{th.purchases.cert.address} {address}</div>}
    </div>
  );
  return (
    <div className="@container print:break-before-page">
      <article className={`${paperCls} relative`} aria-label={th.purchases.cert.title}>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <div className="font-doc text-[17px] font-bold @2xl:text-xl">{th.purchases.cert.title}</div>
            <div>{th.purchases.cert.law}</div>
          </div>
          <div className="text-right">
            <div>{th.purchases.cert.no} <span className="font-num font-semibold">{cert.certNo}</span></div>
            {cert.voided && <div className="neg font-semibold">{th.purchases.cert.voided}</div>}
          </div>
        </div>
        <p className="text-[12px] text-ink2">{th.purchases.cert.copyNote}</p>
        {party(th.purchases.cert.payer, cert.payerName, cert.payerTaxId, cert.payerBranchNo, cert.payerAddress)}
        {party(th.purchases.cert.payee, cert.payeeName, cert.payeeTaxId, cert.payeeBranchNo, cert.payeeAddress)}
        <div className="flex flex-wrap gap-x-6">
          <span>{th.purchases.cert.form}</span>
          {(['pnd3', 'pnd53'] as const).map((f) => (
            <span key={f} className={cert.form === f ? 'font-semibold' : 'text-ink2'}>{cert.form === f ? '☒' : '☐'} {th.purchases.cert.forms[f]}</span>
          ))}
        </div>
        <div className="overflow-x-auto">
          <table className={`w-full border-collapse ${cell}`}>
            <thead>
              <tr>
                <th>{th.purchases.cert.incomeType}</th>
                <th className="w-28">{th.purchases.cert.paidDate}</th>
                <th className="w-32 !text-right">{th.purchases.cert.paidAmount}</th>
                <th className="w-32 !text-right">{th.purchases.cert.taxWithheld}</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>{th.purchases.cert.incomeRow(`${th.purchases.cert.kinds[cert.whtKind]} ${Number(cert.whtRate)}%`)}</td>
                <td className="font-num">{isoToThai(cert.date)}</td>
                <td className="num">{formatMoney(cert.base)}</td>
                <td className="num">{formatMoney(cert.amount)}</td>
              </tr>
              <tr className="font-semibold">
                <td colSpan={2}>{th.purchases.cert.total}</td>
                <td className="num"><Money value={cert.base} /></td>
                <td className="num"><Money value={cert.amount} /></td>
              </tr>
            </tbody>
          </table>
        </div>
        <div className="border border-rule-input px-3 py-2">
          <div className="text-[12px] text-ink2">{th.purchases.cert.totalWords}</div>
          <div>({bahtText(cert.amount)})</div>
        </div>
        <div>{th.purchases.cert.payerType}</div>
        <p>{th.purchases.cert.certify}</p>
        <div className="ml-auto w-64 text-center">
          <div className="h-9 border-b border-dotted border-ink" />
          {th.purchases.cert.sign}
          <div className="font-num">{isoToThai(cert.date)}</div>
        </div>
        <p className="text-[12px] text-ink2 print:hidden">{th.purchases.cert.teachingNote}</p>
      </article>
    </div>
  );
}
