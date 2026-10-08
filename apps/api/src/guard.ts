import type { FastifyRequest } from 'fastify';
import type pg from 'pg';
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

/** กัน IDOR: บริษัทที่อ่านไม่ได้ตอบ 404 เหมือนไม่มีอยู่ */
export async function requireReadable(c: pg.PoolClient, companyId: string) {
  const r = await c.query('select app.can_read_company($1) ok', [companyId]);
  if (!r.rows[0]?.ok) throw new HttpError(404, 'not_found', 'ไม่พบบริษัทนี้');
}

/** อ่านได้แต่เขียนไม่ได้ (ครู/ผู้ช่วยสอน) = 403 บอกตรง ๆ */
export async function requireWritable(c: pg.PoolClient, companyId: string) {
  await requireReadable(c, companyId);
  const r = await c.query('select app.can_write_company($1) ok', [companyId]);
  if (!r.rows[0]?.ok) throw new HttpError(403, '42501', 'บัญชีนี้ไม่มีสิทธิ์ทำรายการในบริษัทนี้');
}
