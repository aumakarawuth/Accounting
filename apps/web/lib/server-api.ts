import 'server-only';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import type { ApiError, Me } from './api';

// Server Component เรียก API ตรง พร้อมส่ง cookie เซสชันของผู้ใช้ต่อไป
const base = process.env.API_URL ?? 'http://127.0.0.1:4000';

export async function serverApi<T>(path: string): Promise<T> {
  const jar = await cookies();
  const res = await fetch(`${base}${path}`, { cache: 'no-store', headers: { cookie: jar.toString() } });
  const body = await res.json().catch(() => ({ code: 'server', message: 'server' }));
  if (res.status === 401) redirect('/login');
  if (res.status === 403 && body.code === 'must_change_password') redirect('/change-password');
  if (!res.ok) throw { status: res.status, ...body } as ApiError;
  return body as T;
}

/** ผู้ใช้ปัจจุบัน; ไม่มีเซสชัน = null (ไม่ redirect เอง) */
export async function getMe(): Promise<Me | null> {
  const jar = await cookies();
  const res = await fetch(`${base}/auth/me`, { cache: 'no-store', headers: { cookie: jar.toString() } });
  return res.ok ? ((await res.json()) as Me) : null;
}

/** ใช้ใน layout: ต้องล็อกอิน ต้องไม่ค้างเปลี่ยนรหัส และ (ถ้าระบุ) ต้องเป็นบทบาทนี้ */
export async function requireMe(role?: Me['role']): Promise<Me> {
  const me = await getMe();
  if (!me) redirect('/login');
  if (me.mustChange) redirect('/change-password');
  if (role && me.role !== role) redirect('/');
  return me;
}
