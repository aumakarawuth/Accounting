import { createHash, randomBytes } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type pg from 'pg';

export type AuthUser = {
  id: string;
  role: 'admin' | 'teacher' | 'student' | 'ta';
  mustChange: boolean;
  displayName: string;
  studentCode: string | null;
  clientInfo: string;
  tokenHash?: string;
};

// adapter เดียวที่ API รู้จัก: session (ใช้จริง) / dev (เครื่องนักพัฒนา) / Better Auth/Keycloak ภายหลัง
export interface AuthAdapter {
  authenticate(req: FastifyRequest): Promise<AuthUser | null>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function clientInfo(req: FastifyRequest) {
  return `${req.ip} / ${String(req.headers['user-agent'] ?? '').slice(0, 120)}`;
}

export const newToken = () => randomBytes(32).toString('base64url');
export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

/** เซสชันใน Postgres: cookie เก็บ token, DB เก็บเฉพาะ sha256 */
export function sessionAuth(pool: pg.Pool, cookieName: string): AuthAdapter {
  return {
    async authenticate(req) {
      const token = req.cookies?.[cookieName];
      if (!token || token.length > 100) return null;
      const th = tokenHash(token);
      const r = await pool.query('select * from app.session_get($1)', [th]);
      const u = r.rows[0];
      if (!u) return null;
      return {
        id: u.user_id, role: u.role, mustChange: u.must_change, displayName: u.display_name,
        studentCode: u.student_code, clientInfo: clientInfo(req), tokenHash: th,
      };
    },
  };
}

/**
 * ใช้บนเครื่องนักพัฒนา/เทสต์เท่านั้น: เชื่อ header x-dev-user-id หรือ DEV_USER_ID
 * ห้ามเปิดใน production (server.ts ปฏิเสธการเริ่มถ้า NODE_ENV=production)
 */
export function devAuth(defaultUserId?: string): AuthAdapter {
  return {
    async authenticate(req) {
      const header = req.headers['x-dev-user-id'];
      const id = (typeof header === 'string' ? header : undefined) ?? defaultUserId;
      if (!id || !UUID.test(id)) return null;
      // บทบาทใช้แค่ตัดสินว่าเรียก route ไหนได้; สิทธิ์ข้อมูลจริงยังตัดสินที่ RLS/ฟังก์ชันใน DB
      const r = req.headers['x-dev-role'];
      const role = r === 'teacher' || r === 'admin' || r === 'ta' ? r : 'student';
      return { id, role, mustChange: false, displayName: '', studentCode: null, clientInfo: clientInfo(req) };
    },
  };
}
