import type { FastifyRequest } from 'fastify';

export type AuthUser = { id: string; clientInfo: string };

// adapter เดียวที่ API รู้จัก: ช่วงพัฒนา/Supabase/Better Auth สลับได้โดยไม่แตะ route
export interface AuthAdapter {
  authenticate(req: FastifyRequest): Promise<AuthUser | null>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function clientInfo(req: FastifyRequest) {
  return `${req.ip} / ${String(req.headers['user-agent'] ?? '').slice(0, 120)}`;
}

/**
 * ใช้บนเครื่องนักพัฒนาเท่านั้น: เชื่อ header x-dev-user-id หรือ DEV_USER_ID
 * ห้ามเปิดใน production (server.ts ปฏิเสธการเริ่มถ้า NODE_ENV=production)
 */
export function devAuth(defaultUserId?: string): AuthAdapter {
  return {
    async authenticate(req) {
      const header = req.headers['x-dev-user-id'];
      const id = (typeof header === 'string' ? header : undefined) ?? defaultUserId;
      if (!id || !UUID.test(id)) return null;
      return { id, clientInfo: clientInfo(req) };
    },
  };
}
