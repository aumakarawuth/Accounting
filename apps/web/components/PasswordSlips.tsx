'use client';

import { th } from '@/i18n/th';

let slipSeq = 0;
/** คีย์ไม่ซ้ำสำหรับใบรหัสผ่านแต่ละใบในหน้านี้ */
export const nextSlipKey = () => `slip-${++slipSeq}`;

export type Slip = { key: string; idLabel: string; id: string; name: string; room?: string; temp: string; staff?: boolean };

// ใบรหัสผ่านสำหรับตัดแจก: ตอนพิมพ์ ซ่อนทุกอย่างในหน้าที่มี print:hidden แล้วพิมพ์เฉพาะส่วนนี้
// รหัสชั่วคราวอยู่ใน state ของหน้านี้เท่านั้น
export function PasswordSlips({ slips, onClear }: { slips: Slip[]; onClear: () => void }) {
  if (slips.length === 0) return null;
  // แสดงหลังผู้ใช้กดสร้าง/รีเซ็ตเท่านั้น (ไม่ render ฝั่งเซิร์ฟเวอร์) จึงอ่าน window ได้ตรง ๆ
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  return (
    <section className="flex flex-col gap-3 border-t-2 border-ink pt-4 print:border-0 print:pt-0" aria-label={th.slips.title(slips.length)}>
      <div className="flex flex-wrap items-center gap-3 print:hidden">
        <h2 className="text-[17px] font-semibold">{th.slips.title(slips.length)}</h2>
        <button type="button" onClick={() => window.print()} className="ml-auto min-h-11 rounded-doc bg-ink px-4 font-medium text-paper">
          {th.slips.print}
        </button>
        <button type="button" onClick={onClear} className="min-h-11 rounded-doc border border-ink px-4">{th.slips.clear}</button>
        <p className="basis-full text-sm text-ink2">{th.slips.note}</p>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 print:grid-cols-2 print:gap-0">
        {slips.map((s) => (
          <article key={s.key} className="break-inside-avoid border border-dashed border-ink2 bg-paper p-4 print:p-5">
            <div className="mb-2 border-b border-ink pb-1 font-doc text-[17px] font-bold">{th.slips.heading}</div>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 text-[15px]">
              {s.room && (<><dt className="text-ink2">{th.slips.room}</dt><dd>{s.room}</dd></>)}
              <dt className="text-ink2">{s.idLabel}</dt><dd className="font-num">{s.id}</dd>
              <dt className="text-ink2">{th.slips.name}</dt><dd>{s.name}</dd>
              <dt className="text-ink2">{th.slips.tempPassword}</dt><dd className="font-num text-xl font-medium">{s.temp}</dd>
            </dl>
            <p className="mt-2 text-[13px]">{th.slips.loginAt(`${origin}${s.staff ? '/login/staff' : '/login'}`)}</p>
            <p className="text-[13px]">{th.slips.instruction}</p>
          </article>
        ))}
      </div>
    </section>
  );
}
