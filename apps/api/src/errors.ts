import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';

export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string, public extra: Record<string, unknown> = {}) {
    super(message);
  }
}

type PgError = { code?: string; message: string };

// SQLSTATE จาก db/migrations → HTTP; ข้อความจาก DB เป็นภาษาไทยที่บอกสาเหตุจริงแล้ว
const STATUS: Record<string, number> = {
  ACC01: 422, // ไม่ดุล
  ACC02: 422, // งวดปิด
  ACC03: 409, // idempotency key ซ้ำแต่เนื้อหาต่าง
  ACC04: 422, // ไม่พบบัญชี/รายการ
  ACC05: 422, // จำนวนเงินผิด
  ACC06: 409, // แก้สมุดรายวันที่ผ่านแล้ว
  ACC07: 409,
  ACC08: 409, // ซ้ำกับผู้ใช้ที่มีอยู่
  ACC09: 409, // ทำกับบัญชีตัวเองไม่ได้
  ACC10: 409, // งานส่งตรวจแล้ว ถูกล็อก
  ACC11: 422, // เปลี่ยนสถานะงานไม่ได้
  ACC12: 409, // กลับรายการซ้ำ/กลับรายการที่เป็นการกลับรายการ
  ACC13: 422, // ปิด/เปิดงวดผิดลำดับ
  '22023': 400,
  '42501': 403,
  '40001': 409,
  '23505': 409,
};

export function toHttp(err: unknown): { status: number; body: { code: string; message: string; ref?: string; [k: string]: unknown } } {
  if (err instanceof HttpError) return { status: err.status, body: { code: err.code, message: err.message, ...err.extra } };
  if (err instanceof ZodError) {
    return { status: 400, body: { code: 'invalid', message: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') } };
  }
  // error ฝั่งคำขอของ Fastify (body ว่าง/JSON เสีย/ใหญ่เกิน) = ผู้ส่งผิด ไม่ใช่ 500
  const fe = err as { statusCode?: number; code?: string };
  if (typeof fe?.statusCode === 'number' && fe.statusCode >= 400 && fe.statusCode < 500 && fe.code?.startsWith('FST_')) {
    return { status: fe.statusCode === 413 ? 413 : 400, body: { code: 'invalid', message: 'รูปแบบคำขอไม่ถูกต้อง' } };
  }
  const pgErr = err as PgError;
  // check/FK ของ DB เป็นด่านสุดท้าย (Zod ตรวจก่อนแล้ว) ข้อความ DB เป็นชื่อ constraint ภาษาอังกฤษ จึงไม่ส่งต่อ
  if (pgErr?.code === '23514') return { status: 422, body: { code: '23514', message: 'ข้อมูลไม่ผ่านเงื่อนไขของระบบ ตรวจช่องที่กรอกอีกครั้ง' } };
  if (pgErr?.code === '23503') return { status: 422, body: { code: '23503', message: 'ข้อมูลที่อ้างถึงไม่มีอยู่ในบริษัทนี้' } };
  const status = pgErr?.code ? STATUS[pgErr.code] : undefined;
  if (status) return { status, body: { code: pgErr.code!, message: pgErr.message } };
  const ref = randomUUID().slice(0, 8);
  return { status: 500, body: { code: 'server', message: 'server', ref } };
}
