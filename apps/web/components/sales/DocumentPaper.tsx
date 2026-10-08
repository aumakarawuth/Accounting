import { bahtText } from '@/lib/bahttext';
import { isoToThai } from '@/lib/date';
import { formatMoney, fromCents, toCents } from '@/lib/money';
import { formatTaxId } from '@/lib/taxid';
import { th } from '@/i18n/th';
import type { SalesKindSql } from '@/lib/api';

// หน้ากระดาษเอกสารขาย ใช้ทั้งตัวอย่างระหว่างร่างและเอกสารที่ผ่านรายการแล้ว (ตาม mockup ใบกำกับภาษีที่อนุมัติ)
export type Paper = {
  kind: SalesKindSql;
  isTaxInvoice: boolean;
  seller: { name: string; taxId: string | null; branchNo: string; address: string };
  party: { name: string; taxId: string | null; branchNo: string; address: string } | null;
  docNo: string | null;
  date: string | null; // ISO
  dueDate?: string | null;
  refDocNo?: string | null;
  reason?: string | null;
  lines: { description: string; qty: string; unit: string; unitPrice: string; amount: string }[];
  gross: string; discount: string; base: string; vat: string; total: string; vatRate: string;
  priceMode: 'exclusive' | 'inclusive' | 'none';
  whtAmount: string;
  stamp?: { kind: 'posted' | 'voided'; docNo: string; date: string } | null;
};

const branch = (b: string) => (b === '00000' ? th.sales.headOffice : th.sales.branch(b));
const money = (v: string) => formatMoney(v);
const minus = (a: string, b: string) => fromCents((toCents(a) ?? 0n) - (toCents(b) ?? 0n));

export function DocumentPaper({ p, className = '' }: { p: Paper; className?: string }) {
  const paid = p.kind === 'cash_sale' || p.kind === 'receipt';
  const rows: [string, string, boolean?][] = [[p.kind === 'receipt' ? th.sales.receiptTotal : th.sales.subtotal, p.gross]];
  if (Number(p.discount) > 0) rows.push([th.sales.discount, p.discount], [th.sales.afterDiscount, minus(p.gross, p.discount)]);
  if (p.priceMode === 'inclusive' && p.kind !== 'receipt') rows.push([th.sales.base, p.base]);
  if (p.priceMode !== 'none' || Number(p.vat) > 0) rows.push([th.sales.vat(String(Number(p.vatRate))), p.vat]);
  rows.push([th.sales.total, p.total, true]);
  const wht = Number(p.whtAmount) > 0;

  return (
    // จัดตามความกว้างของกระดาษเอง (container query) ไม่ใช่ความกว้างจอ: ตัวอย่างข้างฟอร์มบน iPad แคบกว่าจอมาก
    <div className={`@container ${className}`}>
    <article className="flex flex-col gap-3 border border-rule-strong bg-paper p-4 text-[13px] @2xl:gap-3.5 @2xl:p-8 @2xl:text-sm print:border-0 print:p-0">
      <div className="flex flex-wrap justify-between gap-x-6 gap-y-2">
        <div className="min-w-0">
          <div className="font-doc text-[17px] font-bold @2xl:text-xl">{p.seller.name}</div>
          {p.seller.address && <div className="whitespace-pre-line">{p.seller.address}</div>}
          {p.seller.taxId && <div>{th.sales.taxId} <span className="font-num">{formatTaxId(p.seller.taxId)}</span> · {branch(p.seller.branchNo)}</div>}
        </div>
        <div className="text-right">
          <div className="font-doc text-[17px] font-bold @2xl:text-xl">{th.sales.paperTitle(p.kind, p.isTaxInvoice)}</div>
          <div>{th.sales.original}</div>
          {/* ตราประทับใต้ชื่อเอกสาร ไม่ทับเลขที่/วันที่ */}
          {p.stamp && (
            <div className={`mt-2 inline-block -rotate-[4deg] border-2 bg-paper px-3 py-1 text-center ${p.stamp.kind === 'voided' ? 'neg border-current' : 'border-ink'}`}>
              <div className="font-semibold tracking-wide">{p.stamp.kind === 'posted' ? th.sales.stampPosted : th.sales.stampVoided}</div>
              <div className="font-num text-[12px]">{p.stamp.docNo} · {isoToThai(p.stamp.date)}</div>
            </div>
          )}
        </div>
      </div>

      <div className="grid border border-rule-input @2xl:grid-cols-[minmax(0,1fr)_220px]">
        <div className="border-rule-input px-3 py-2 @max-2xl:border-b @2xl:border-r">
          <div className="text-[12px] text-ink2">{th.sales.customer}</div>
          <div>{p.party?.name ?? '—'}</div>
          {p.party?.address && <div className="whitespace-pre-line">{p.party.address}</div>}
          {p.party?.taxId && <div>{th.sales.taxId} <span className="font-num">{formatTaxId(p.party.taxId)}</span> · {branch(p.party.branchNo)}</div>}
        </div>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] content-start gap-x-2.5 gap-y-1 px-3 py-2">
          <dt className="text-[12px] text-ink2">{th.sales.docNo}</dt>
          <dd className="font-num text-right">{p.docNo ?? <span className="text-ink2">{th.sales.docNoPending}</span>}</dd>
          <dt className="text-[12px] text-ink2">{th.sales.date}</dt>
          <dd className="font-num text-right">{p.date ? isoToThai(p.date) : '—'}</dd>
          {p.dueDate && <><dt className="text-[12px] text-ink2">{th.sales.dueDate}</dt><dd className="font-num text-right">{isoToThai(p.dueDate)}</dd></>}
          {p.refDocNo && <><dt className="text-[12px] text-ink2">{th.sales.ref}</dt><dd className="font-num text-right">{p.refDocNo}</dd></>}
        </dl>
      </div>
      {p.reason && <p><span className="text-ink2">{th.sales.reason}:</span> {p.reason}</p>}

      <div className="overflow-x-auto">
        <table className="w-full border-collapse [&_td]:border [&_td]:border-rule [&_td]:px-2 [&_td]:py-1.5 [&_th]:border [&_th]:border-rule [&_th]:bg-band [&_th]:px-2 [&_th]:py-1.5 [&_th]:text-left [&_th]:font-medium">
          <thead>
            <tr>
              <th className="w-9">{th.sales.itemNo}</th>
              <th>{th.sales.description}</th>
              <th className="w-20 !text-right">{th.sales.qty}</th>
              <th className="w-16 @max-2xl:hidden">{th.sales.unit}</th>
              <th className="w-24 !text-right @max-2xl:hidden">{th.sales.unitPrice}</th>
              <th className="w-28 !text-right">{th.sales.amount}</th>
            </tr>
          </thead>
          <tbody>
            {p.lines.map((l, i) => (
              <tr key={i}>
                <td className="font-num">{i + 1}</td>
                <td>{l.description || '—'}</td>
                <td className="num">{l.qty}<span className="@2xl:hidden"> {l.unit}</span></td>
                <td className="@max-2xl:hidden">{l.unit}</td>
                <td className="num @max-2xl:hidden">{money(l.unitPrice)}</td>
                <td className="num">{money(l.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid gap-3 @2xl:grid-cols-[minmax(0,1fr)_300px] @2xl:gap-4">
        <div className="self-end border border-rule-input px-3 py-2 @max-2xl:order-2">
          <div className="text-[12px] text-ink2">{th.sales.amountInWords}</div>
          <div>({bahtText(p.total)})</div>
        </div>
        <dl className="grid grid-cols-[minmax(0,1fr)_auto]">
          {rows.map(([label, value, strong]) => (
            <div key={label} className="contents">
              <dt className={`px-2 py-1 ${strong ? 'border-t border-ink font-semibold' : ''}`}>{label}</dt>
              <dd className={`num px-2 py-1 ${strong ? 'border-t border-b-[3px] border-double border-ink font-semibold' : ''}`}>{money(value)}</dd>
            </div>
          ))}
          {wht && (
            <>
              <dt className="px-2 py-1">{th.sales.whtByCustomer}</dt><dd className="num px-2 py-1">{money(p.whtAmount)}</dd>
              <dt className="px-2 py-1">{th.sales.netReceived}</dt><dd className="num px-2 py-1">{money(minus(p.total, p.whtAmount))}</dd>
            </>
          )}
        </dl>
      </div>

      <div className="mt-6 grid grid-cols-2 gap-6 text-center text-[12px] @2xl:gap-10 @2xl:text-[13px]">
        <div><div className="h-9 border-b border-dotted border-ink" />{paid ? th.sales.receiver : th.sales.receivedBy}</div>
        <div><div className="h-9 border-b border-dotted border-ink" />{th.sales.authorized}</div>
      </div>

    </article>
    </div>
  );
}
