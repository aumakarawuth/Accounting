import type { FastifyRequest } from 'fastify';
import type { AuthAdapter, AuthUser } from './auth.js';
import { HttpError } from './errors.js';

/** ผู้ใช้ที่ล็อกอินแล้วและไม่ค้างเปลี่ยนรหัส (ทุก route ยกเว้น /auth/*) */
export async function requireUser(auth: AuthAdapter, req: FastifyRequest, roles?: AuthUser['role'][]): Promise<AuthUser> {
  const u = await auth.authenticate(req);
  if (!u) throw new HttpError(401, 'unauthenticated', 'ต้องเข้าใช้งานก่อน');
  if (u.mustChange) throw new HttpError(403, 'must_change_password', 'ต้องตั้งรหัสผ่านใหม่ก่อน');
  if (roles && !roles.includes(u.role)) throw new HttpError(403, 'forbidden', 'บัญชีนี้ไม่มีสิทธิ์ใช้หน้านี้');
  return u;
}
