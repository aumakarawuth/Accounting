import { th } from '@/i18n/th';

// ปุ่มดาวน์โหลด PDF / Excel (ลิงก์ GET ธรรมดา: ทำงานได้แม้ JavaScript ยังไม่โหลด) ไฟล์สร้างที่เซิร์ฟเวอร์จากข้อมูลชุดเดียวกับหน้าจอ
export function ExportLinks({ base, query = '', label = th.export.label }: { base: string; query?: string; label?: string }) {
  const q = query ? `?${query}` : '';
  const cls = 'flex min-h-11 items-center justify-center rounded-doc border border-ink px-3 text-sm font-medium';
  return (
    <div role="group" aria-label={label} className="flex gap-2 print:hidden">
      <a href={`${base}.pdf${q}`} download className={cls}>{th.export.pdf}</a>
      <a href={`${base}.xlsx${q}`} download className={cls}>{th.export.xlsx}</a>
    </div>
  );
}
