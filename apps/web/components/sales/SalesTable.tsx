import Link from 'next/link';
import { Money } from '@/components/Money';
import type { SalesRow } from '@/lib/api';
import { isoToThai } from '@/lib/date';
import { th } from '@/i18n/th';

// รายการเอกสารขาย: จอใหญ่เป็นตาราง มือถือเป็นรายการแตะเปิด · สถานะบอกยอดค้าง/รับครบ/ยกเลิก
function status(r: SalesRow) {
  if (r.voidedAt) return <span className="neg">{th.sales.voided}</span>;
  if (r.open === null) return null;
  return Number(r.open) > 0 ? <>{th.sales.open} <Money value={r.open} /></> : <span className="text-ink2">{th.sales.paid}</span>;
}

export function SalesTable({ companyId, rows }: { companyId: string; rows: SalesRow[] }) {
  const href = (id: string) => `/c/${companyId}/sales/documents/${id}`;
  const cell = 'h-11 border border-rule px-2.5';
  if (rows.length === 0) return <p className="text-ink2">{th.sales.empty}</p>;
  return (
    <>
      <table className="w-full border-collapse bg-paper text-[15px] max-sm:hidden">
        <thead className="bg-band text-left text-sm">
          <tr>
            <th className={`${cell} w-28 font-medium`}>{th.sales.date}</th>
            <th className={`${cell} w-28 font-medium`}>{th.sales.docNo}</th>
            <th className={`${cell} w-24 font-medium`}>{th.sales.kind}</th>
            <th className={`${cell} font-medium`}>{th.sales.customer}</th>
            <th className={`${cell} w-36 text-right font-medium`}>{th.sales.amount}</th>
            <th className={`${cell} w-44 font-medium`}>{th.sales.status}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className={r.voidedAt ? 'text-ink2' : ''}>
              <td className={`${cell} font-num`}>{isoToThai(r.date)}</td>
              <td className={`${cell} font-num`}><Link href={href(r.id)} className="underline decoration-rule-input">{r.docNo}</Link></td>
              <td className={cell}>{th.sales.kinds[r.kind]}</td>
              <td className={cell}>{r.partyName}</td>
              <td className={`${cell} text-right`}><Money value={r.total} /></td>
              <td className={`${cell} text-sm`}>{status(r)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <ul className="border-t border-rule-strong bg-paper sm:hidden">
        {rows.map((r) => (
          <li key={r.id} className="border-b border-rule">
            <Link href={href(r.id)} className="grid min-h-14 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 px-4 py-2">
              <span className="truncate">{r.partyName}</span>
              <Money value={r.total} />
              <span className="font-num text-[13px] text-ink2">{r.docNo} · {th.sales.kinds[r.kind]} · {isoToThai(r.date)}</span>
              <span className="text-right text-[13px]">{status(r)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
