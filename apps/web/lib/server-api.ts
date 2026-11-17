import 'server-only';
import { cache } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import type { ApiError, Me } from './api';

// Server Component เรียก API ตรง พร้อมส่ง cookie เซสชันของผู้ใช้ต่อไป
const base = process.env.API_URL ?? 'http://127.0.0.1:4000';

// Vercel (EMBED_API=1): เรียก API ในตัว ไม่ออกเน็ตแล้ววนกลับ · ที่อื่น: เรียก API ที่แยกรัน
// cache(): ภายในการแสดงหน้าเดียว (layout + page + component) path เดียวกันเรียก API ครั้งเดียว
// เช่น layout ของบริษัทกับหน้าลูกต่างใช้ /companies/:id และ /auth/me (docs/performance.md) · ข้ามคำขอไม่แชร์กัน
const call = cache(async function call(path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const cookie = (await cookies()).toString();
  if (process.env.EMBED_API === '1') {
    const { inject } = await import('@accounting/api/embedded');
    const r = await inject(path, cookie);
    return { status: r.status, body: r.body as Record<string, unknown> };
  }
  const res = await fetch(`${base}${path}`, { cache: 'no-store', headers: { cookie } });
  return { status: res.status, body: await res.json().catch(() => ({ code: 'server', message: 'server' })) };
});

export async function serverApi<T>(path: string): Promise<T> {
  const { status, body } = await call(path);
  if (status === 401) redirect('/login');
  if (status === 403 && body.code === 'must_change_password') redirect('/change-password');
  if (status < 200 || status >= 300) throw apiError(status, body);
  return body as T;
}

// โยนเป็น Error จริง (React ไม่ชอบวัตถุธรรมดา: error #441 ตอนทดสอบ 50 คน) ผู้เรียกยังอ่าน status/code ได้เหมือนเดิม
function apiError(status: number, body: Record<string, unknown>): ApiError {
  return Object.assign(new Error(String(body.message ?? status)), { status, ...body }) as unknown as ApiError;
}

/** ผู้ใช้ปัจจุบัน; ไม่มีเซสชัน (401) = null (ไม่ redirect เอง)
 * ข้อผิดพลาดอื่น (ส่งคำขอถี่เกิน 429, เซิร์ฟเวอร์ล่ม) โยนต่อให้หน้า error ไม่ใช่ถือว่าออกจากระบบแล้ว
 * (ทดสอบห้องเรียน 50 คน: ครูที่ตรวจเร็วโดนจำกัดคำขอแล้วถูกพาไปหน้าเข้าสู่ระบบ docs/load-test-class50.md) */
export async function getMe(): Promise<Me | null> {
  const { status, body } = await call('/auth/me');
  if (status === 200) return body as unknown as Me;
  if (status === 401) return null;
  throw apiError(status, body);
}

/** ใช้ใน layout: ต้องล็อกอิน ต้องไม่ค้างเปลี่ยนรหัส และ (ถ้าระบุ) ต้องเป็นบทบาทนี้ */
export async function requireMe(role?: Me['role']): Promise<Me> {
  const me = await getMe();
  if (!me) redirect('/login');
  if (me.mustChange) redirect('/change-password');
  if (role && me.role !== role) redirect('/');
  return me;
}
