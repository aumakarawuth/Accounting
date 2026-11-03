import Link from 'next/link';
import { Money } from '@/components/Money';
import type { VatRow } from '@/lib/api';
import { isoToThai } from '@/lib/date';
import { fromCents, toCents } from '@/lib/money';
import { th } from '@/i18n/th';

// รายงานภาษีขาย/ภาษีซื้อ: ลำดับ วันที่ เลขที่ใบกำกับ ชื่อคู่ค้า เลขผู้เสียภาษี/สาขา มูลค่า ภาษี (เรียงตามวันที่)
// ภาษีซื้อ: เลขที่ใบกำกับเป็นของผู้ขาย เลขเอกสารของเราแสดงรอง · จอเล็กเป็นรายการ
export function VatTable({ companyId, side, rows }: { companyId: string; side: 'sales' | 'purchases'; rows: VatRow[] }) {
  const c = th.tax.col;
  const href = (r: VatRow) => `/c/${companyId}/${side}/documents/${r.documentId}`;
  const invoiceNo = (r: VatRow) => (side === 'purchases' ? r.refNo ?? r.docNo : r.docNo);
  const sum = (k: 'base' | 'vat') => fromCents(rows.reduce((s, r) => s + (toCents(r[k]) ?? 0n), 0n));
  const note = (r: VatRow) => (r.status === 'normal' ? null : <span className="text-[13px] text-ink2"> · {th.tax.status[r.status]}</span>);
  const cell = 'h-11 border border-rule px-2.5';
  if (rows.length === 0) return <p className="text-ink2">{th.tax.noRows}</p>;
  return (
    <>
      <table className="w-full border-collapse bg-paper text-[15px] max-sm:hidden">
        <thead className="bg-band text-left text-sm">
          <tr>
            <th className={`${cell} w-12 font-medium`}>{c.no}</th>
            <th className={`${cell} w-28 font-medium`}>{c.date}</th>
            <th className={`${cell} w-32 font-medium`}>{c.invoice}</th>
            <th className={`${cell} font-medium`}>{side === 'sales' ? c.buyer : c.seller}</th>
            <th className={`${cell} w-36 font-medium`}>{c.taxId} / {c.branch}</th>
            <th className={`${cell} w-32 text-right font-medium`}>{c.base}</th>
            <th className={`${cell} w-28 text-right font-medium`}>{c.vat}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.documentId}-${r.status}`} className={r.status === 'normal' ? '' : 'text-ink2'}>
              <td className={`${cell} font-num`}>{i + 1}</td>
              <td className={`${cell} font-num`}>{isoToThai(r.date)}</td>
              <td className={`${cell} font-num`}>
                <Link href={href(r)} className="underline decoration-rule-input">{invoiceNo(r)}</Link>
                {side === 'purchases' && r.refNo && <span className="block text-[13px] text-ink2">{r.docNo}</span>}
              </td>
              <td className={cell}>{r.partyName}{note(r)}</td>
              <td className={`${cell} font-num text-sm`}>{r.partyTaxId ?? '-'}<span className="block text-[13px] text-ink2">{th.tax.branch(r.partyBranchNo)}</span></td>
              <td className={`${cell} text-right`}><Money value={r.base} /></td>
              <td className={`${cell} text-right`}><Money value={r.vat} /></td>
            </tr>
          ))}
        </tbody>
        <tfoot className="font-semibold">
          <tr>
            <td className={cell} colSpan={5}>{th.tax.total}</td>
            <td className={`${cell} text-right`}><Money value={sum('base')} /></td>
            <td className={`${cell} text-right`}><Money value={sum('vat')} /></td>
          </tr>
        </tfoot>
      </table>
      <ul className="border-t border-rule-strong bg-paper sm:hidden">
        {rows.map((r) => (
          <li key={`${r.documentId}-${r.status}`} className="border-b border-rule">
            <Link href={href(r)} className="grid min-h-14 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 px-4 py-2">
              <span className="truncate">{r.partyName}</span>
              <Money value={r.vat} />
              <span className="font-num text-[13px] text-ink2">{invoiceNo(r)} · {isoToThai(r.date)}{note(r)}</span>
              <span className="text-right text-[13px] text-ink2"><Money value={r.base} /></span>
            </Link>
          </li>
        ))}
        <li className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 border-b border-rule-strong px-4 py-2 font-semibold">
          <span>{th.tax.total}</span>
          <Money value={sum('vat')} />
        </li>
      </ul>
    </>
  );
}
