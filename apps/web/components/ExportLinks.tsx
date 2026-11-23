import { th } from '@/i18n/th';
import { ExportLink } from './ExportLink';

// ปุ่มดาวน์โหลด PDF / Excel · แอปที่ติดตั้ง (PWA) ใช้หน้าแชร์ของเครื่อง ไม่เปิดไฟล์ทับแอป (ดู ExportLink)
// (ลิงก์ GET ธรรมดา: ทำงานได้แม้ JavaScript ยังไม่โหลด) ไฟล์สร้างที่เซิร์ฟเวอร์จากข้อมูลชุดเดียวกับหน้าจอ
export function ExportLinks({ base, query = '', label = th.export.label }: { base: string; query?: string; label?: string }) {
  const q = query ? `?${query}` : '';
  const cls = 'flex min-h-11 items-center justify-center rounded-doc border border-ink px-3 text-sm font-medium';
  return (
    <div role="group" aria-label={label} className="flex gap-2 print:hidden">
      <ExportLink href={`${base}.pdf${q}`} label={th.export.pdf} className={cls} />
      <ExportLink href={`${base}.xlsx${q}`} label={th.export.xlsx} className={cls} />
    </div>
  );
}
