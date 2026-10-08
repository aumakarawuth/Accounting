import Link from 'next/link';
import { Money } from '@/components/Money';
import { isoToThai } from '@/lib/date';
import { th } from '@/i18n/th';

// รายการเอกสารขาย/ซื้อ: จอใหญ่เป็นตาราง มือถือเป็นรายการแตะเปิด · สถานะบอกยอดค้าง/รับ(จ่าย)ครบ/ยกเลิก
type Row = { id: string; kind: string; docNo: string; date: string; partyName: string; total: string; open: string | null; voidedAt: string | null; vendorDocNo?: string | null };
function status(r: Row, paid: string) {
  if (r.voidedAt) return <span className="neg">{th.sales.voided}</span>;
  if (r.open === null) return null;
  return Number(r.open) > 0 ? <>{th.sales.open} <Money value={r.open} /></> : <span className="text-ink2">{paid}</span>;
}

export function DocTable({ companyId, rows, area, kinds, party, paid }: {
  companyId: string; rows: Row[]; area: 'sales' | 'purchases'; kinds: Record<string, string>; party: string; paid?: string;
}) {
  const href = (id: string) => `/c/${companyId}/${area}/documents/${id}`;
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
            <th className={`${cell} font-medium`}>{party}</th>
            <th className={`${cell} w-36 text-right font-medium`}>{th.sales.amount}</th>
            <th className={`${cell} w-44 font-medium`}>{th.sales.status}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className={r.voidedAt ? 'text-ink2' : ''}>
              <td className={`${cell} font-num`}>{isoToThai(r.date)}</td>
              <td className={`${cell} font-num`}><Link href={href(r.id)} className="underline decoration-rule-input">{r.docNo}</Link></td>
              <td className={cell}>{kinds[r.kind]}</td>
              <td className={cell}>{r.partyName}{r.vendorDocNo && <span className="font-num text-[13px] text-ink2"> · {r.vendorDocNo}</span>}</td>
              <td className={`${cell} text-right`}><Money value={r.total} /></td>
              <td className={`${cell} text-sm`}>{status(r, paid ?? th.sales.paid)}</td>
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
              <span className="font-num text-[13px] text-ink2">{r.docNo} · {kinds[r.kind]} · {isoToThai(r.date)}{r.vendorDocNo ? ` · ${r.vendorDocNo}` : ''}</span>
              <span className="text-right text-[13px]">{status(r, paid ?? th.sales.paid)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
