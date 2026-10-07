import { describe, it, expect } from 'vitest';
import { addDays, todayIso } from '../apps/web/lib/date';

describe('วันที่ตามเวลาไทย', () => {
  it('todayIso ใช้เวลาไทยไม่ว่าเครื่องอยู่เขตเวลาไหน (กัน hydrate ไม่ตรงช่วง 00:00–07:00)', () => {
    expect(todayIso(new Date('2026-10-07T16:59:59Z'))).toBe('2026-10-07');
    expect(todayIso(new Date('2026-10-07T17:00:00Z'))).toBe('2026-10-08'); // เที่ยงคืนที่ไทย
    expect(todayIso(new Date('2026-12-31T20:00:00Z'))).toBe('2027-01-01');
  });
  it('addDays ข้ามเดือน/ปี/ปีอธิกสุรทิน', () => {
    expect(addDays('2026-10-05', 30)).toBe('2026-11-04');
    expect(addDays('2026-12-15', 30)).toBe('2027-01-14');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-10-05', 0)).toBe('2026-10-05');
  });
});
