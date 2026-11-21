import type { EquityChanges } from './api';
import { th } from '../i18n/th';

/** ชื่อคอลัมน์/แถว/หัวงบส่วนของเจ้าของตามประเภทกิจการ (ใช้ทั้งหน้าจอและไฟล์ส่งออก) */
export function equityLabels(e: Pick<EquityChanges, 'entityType'>) {
  const t = th.equityChanges;
  const type = e.entityType ?? 'sole';
  return {
    title: t.titles[type] ?? t.title,
    column: (c: EquityChanges['columns'][number]) =>
      c.partner ?? (type === 'company' ? t.companyColumns[c.key] : type === 'partnership' ? t.partnerColumns[c.key] : t.columns[c.key]) ?? c.key,
    row: (key: string) => (type === 'partnership' ? t.partnerRows[key] : type === 'company' ? t.companyRows[key] : undefined) ?? t.rows[key] ?? key,
    note: t.notes[type] ?? t.note,
  };
}
