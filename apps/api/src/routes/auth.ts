import type { FastifyInstance, FastifyReply } from 'fastify';
import type pg from 'pg';
import { clientInfo, newToken, tokenHash, type AuthAdapter } from '../auth.js';
import type { AuthConfig } from '../config.js';
import { withUser } from '../db.js';
import { HttpError } from '../errors.js';
import { checkPassword, hashPassword, verifyPassword } from '../passwords.js';
import type { RateLimiter } from '../ratelimit.js';
import { ChangePassword, Login } from '../schemas-auth.js';

export function authRoutes(app: FastifyInstance, deps: { pool: pg.Pool; auth: AuthAdapter; cfg: AuthConfig; limiter: RateLimiter }) {
  const { pool, auth, cfg, limiter } = deps;
  const window = `${cfg.lockMinutes} minutes`;

  function setCookie(reply: FastifyReply, token: string) {
    reply.setCookie(cfg.cookieName, token, {
      path: '/', httpOnly: true, secure: cfg.cookieSecure, sameSite: 'lax', maxAge: cfg.maxAgeSeconds,
    });
  }

  app.post('/auth/login', async (req, reply) => {
    const wait = await limiter.hit(`login:${req.ip}`, cfg.loginPerIpPerMinute, 60);
    if (wait) throw new HttpError(429, 'rate_limited', 'ส่งคำขอถี่เกินไป', { retryAfter: wait });
    const body = Login.parse(req.body);
    const ident = body.identifier;

    const lock = (await pool.query(
      'select failures, locked_until, ip_failures from app.auth_lock_state($1, $2, $3, $4, $5::interval, $6)',
      [body.kind, ident, req.ip, cfg.maxFailures, window, cfg.ipMaxFailures],
    )).rows[0];
    if (lock.ip_failures >= cfg.ipMaxFailures) {
      throw new HttpError(429, 'ip_limited', 'ล็อกอินผิดจากเครือข่ายนี้มากเกินไป', { retryAfter: cfg.lockMinutes * 60 });
    }
    if (lock.locked_until && new Date(lock.locked_until) > new Date()) {
      const minutes = Math.ceil((new Date(lock.locked_until).getTime() - Date.now()) / 60_000);
      throw new HttpError(423, 'locked', 'บัญชีถูกล็อกชั่วคราว', { minutes });
    }

    const found = (await pool.query('select * from app.auth_find($1, $2)', [body.kind, ident])).rows[0];
    const ok = await verifyPassword(found?.password_hash ?? null, body.password);
    await pool.query('select app.auth_record($1, $2, $3, $4, $5, $6, $7::interval)', [
      body.kind, ident, req.ip, found?.user_id ?? null, ok, cfg.maxFailures, window,
    ]);

    if (!ok) {
      const left = cfg.maxFailures - (lock.failures + 1);
      if (left <= 0) throw new HttpError(423, 'locked', 'บัญชีถูกล็อกชั่วคราว', { minutes: cfg.lockMinutes });
      throw new HttpError(401, 'bad_credentials', 'ข้อมูลเข้าใช้งานไม่ถูกต้อง', { left, lockMinutes: cfg.lockMinutes });
    }

    const token = newToken();
    await pool.query('select app.session_create($1, $2, $3, $4, $5::interval)', [
      found.user_id, tokenHash(token), clientInfo(req), cfg.idleSeconds, `${cfg.maxAgeSeconds} seconds`,
    ]);
    setCookie(reply, token);
    return { role: found.role, mustChange: found.must_change };
  });

  app.post('/auth/logout', async (req, reply) => {
    const u = await auth.authenticate(req);
    if (u?.tokenHash) await pool.query('select app.session_revoke($1, $2)', [u.tokenHash, 'logout']);
    reply.clearCookie(cfg.cookieName, { path: '/', secure: cfg.cookieSecure, sameSite: 'lax', httpOnly: true });
    return { ok: true };
  });

  app.get('/auth/me', async (req) => {
    const u = await auth.authenticate(req);
    if (!u) throw new HttpError(401, 'unauthenticated', 'ต้องเข้าใช้งานก่อน');
    return { id: u.id, role: u.role, displayName: u.displayName, studentCode: u.studentCode, mustChange: u.mustChange };
  });

  app.post('/auth/change-password', async (req) => {
    const u = await auth.authenticate(req);
    if (!u?.tokenHash) throw new HttpError(401, 'unauthenticated', 'ต้องเข้าใช้งานก่อน');
    const body = ChangePassword.parse(req.body);
    await withUser(pool, u, async (c) => {
      const current = (await c.query('select app.my_password_hash() h')).rows[0]?.h ?? null;
      // เปลี่ยนครั้งแรกหลังครูรีเซ็ตไม่ต้องใส่รหัสเดิม (เพิ่งยืนยันด้วยรหัสชั่วคราวในเซสชันนี้)
      if (!u.mustChange && !(await verifyPassword(current, body.currentPassword ?? ''))) {
        throw new HttpError(403, 'bad_current_password', 'รหัสผ่านเดิมไม่ถูกต้อง');
      }
      const email = u.role === 'student' ? null
        : (await c.query('select email from acc.users where id = $1', [u.id])).rows[0]?.email;
      const reason = checkPassword(body.newPassword, { studentCode: u.studentCode, email });
      if (reason) throw new HttpError(422, 'weak_password', 'รหัสผ่านใหม่ไม่ผ่านเงื่อนไข', { reason });
      if (current && (await verifyPassword(current, body.newPassword))) {
        throw new HttpError(422, 'weak_password', 'รหัสผ่านใหม่ต้องไม่ซ้ำรหัสเดิม', { reason: 'same' });
      }
      await c.query('select app.change_own_password($1, $2)', [await hashPassword(body.newPassword), u.tokenHash]);
    });
    return { ok: true };
  });
}
