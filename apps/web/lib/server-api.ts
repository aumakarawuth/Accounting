import 'server-only';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import type { ApiError, Me } from './api';

// Server Component เรียก API ตรง พร้อมส่ง cookie เซสชันของผู้ใช้ต่อไป
const base = process.env.API_URL ?? 'http://127.0.0.1:4000';

// Vercel (EMBED_API=1): เรียก API ในตัว ไม่ออกเน็ตแล้ววนกลับ · ที่อื่น: เรียก API ที่แยกรัน
async function call(path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const cookie = (await cookies()).toString();
  if (process.env.EMBED_API === '1') {
    const { inject } = await import('@accounting/api/embedded');
    const r = await inject(path, cookie);
    return { status: r.status, body: r.body as Record<string, unknown> };
  }
  const res = await fetch(`${base}${path}`, { cache: 'no-store', headers: { cookie } });
  return { status: res.status, body: await res.json().catch(() => ({ code: 'server', message: 'server' })) };
}

export async function serverApi<T>(path: string): Promise<T> {
  const { status, body } = await call(path);
  if (status === 401) redirect('/login');
  if (status === 403 && body.code === 'must_change_password') redirect('/change-password');
  if (status < 200 || status >= 300) throw { status, ...body } as ApiError;
  return body as T;
}

/** ผู้ใช้ปัจจุบัน; ไม่มีเซสชัน = null (ไม่ redirect เอง) */
export async function getMe(): Promise<Me | null> {
  const { status, body } = await call('/auth/me');
  return status === 200 ? (body as unknown as Me) : null;
}

/** ใช้ใน layout: ต้องล็อกอิน ต้องไม่ค้างเปลี่ยนรหัส และ (ถ้าระบุ) ต้องเป็นบทบาทนี้ */
export async function requireMe(role?: Me['role']): Promise<Me> {
  const me = await getMe();
  if (!me) redirect('/login');
  if (me.mustChange) redirect('/change-password');
  if (role && me.role !== role) redirect('/');
  return me;
}
