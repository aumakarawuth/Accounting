// วันที่บนจอเป็น วว/ดด/ปปปป (พ.ศ.) ส่ง API เป็น ISO (ค.ศ.)
const MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
const BE = 543;

export function isoToThai(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${Number(y) + BE}`;
}

/** "15/10/2569" → "2026-10-15"; รูปแบบหรือวันที่ผิด = null */
export function thaiToIso(input: string): string | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(input.trim());
  if (!m) return null;
  const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3]) - BE];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** "2026-10-15" หรือ "2026-10" → "ต.ค. 2569" */
export function monthLabel(iso: string): string {
  const [y, m] = iso.split('-');
  return `${MONTHS[Number(m) - 1]} ${Number(y) + BE}`;
}

/** วันนี้ตามเวลาไทยเสมอ: เซิร์ฟเวอร์ (Vercel = UTC) กับเบราว์เซอร์ต้องได้วันเดียวกัน ไม่อย่างนั้นช่วง 00:00–07:00 วันที่เพี้ยนและ hydrate ไม่ตรง */
const bangkok = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' });
export function todayIso(now = new Date()): string {
  return bangkok.format(now);
}

/** "2026-10" → "31 ต.ค. 2569" (วันสุดท้ายของงวด) */
export function monthEndLabel(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${last} ${MONTHS[m - 1]} ${y + BE}`;
}

/** เลื่อนเดือน: ("2026-01", -1) → "2025-12" */
export function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export const isMonth = (s: string | undefined): s is string => !!s && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);

/** "2026-10-05" + 30 → "2026-11-04" (คิดแบบ UTC ไม่เพี้ยนตามเขตเวลา) */
export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
