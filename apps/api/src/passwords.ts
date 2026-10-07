import { hash, verify, type Algorithm } from '@node-rs/argon2';
import { randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';

// Argon2id ตามค่าแนะนำ OWASP (m=19 MiB, t=2, p=1); ปรับเมื่อวัดโหลดจริง
const OPTIONS = { algorithm: 2 as Algorithm /* Argon2id */, memoryCost: 19_456, timeCost: 2, parallelism: 1 };

export const hashPassword = (pw: string) => hash(pw, OPTIONS);

export async function verifyPassword(stored: string | null, pw: string): Promise<boolean> {
  // ไม่มีผู้ใช้ก็ยังเสียเวลาเท่ากัน กันการวัดเวลาเพื่อเดาว่ารหัสนักเรียนไหนมีอยู่
  const target = stored ?? (await dummy);
  const ok = await verify(target, pw).catch(() => false);
  return stored !== null && ok;
}
const dummy = hash('dummy-password-for-timing', OPTIONS);

const common = new Set(
  readFileSync(new URL('../data/common-passwords.txt', import.meta.url), 'utf8')
    .split('\n').map((s) => s.trim().toLowerCase()).filter(Boolean),
);

export type WeakReason = 'length' | 'student_code' | 'common';

/** กติกา PLAN.md ข้อ 5: ยาว ≥ 8, ไม่ใช่รหัสนักเรียน, ไม่อยู่ในรายการยอดแย่; ไม่บังคับสัญลักษณ์ */
export function checkPassword(pw: string, ctx: { studentCode?: string | null; email?: string | null }): WeakReason | null {
  const len = [...pw].length; // นับตัวอักษร (ภาษาไทยหลายไบต์)
  if (len < 8 || len > 128) return 'length';
  const lower = pw.toLowerCase();
  const code = ctx.studentCode?.toLowerCase();
  if (code && lower.includes(code)) return 'student_code';
  const local = ctx.email?.split('@')[0]?.toLowerCase();
  if (local && local.length >= 3 && lower.includes(local)) return 'student_code';
  if (common.has(lower) || /^(.)\1+$/.test(pw) || /^(0123456789|123456789|12345678)/.test(pw)) return 'common';
  return null;
}

// รหัสชั่วคราวสำหรับพิมพ์แจก: ตัดตัวที่สับสน (0 O 1 l I) ออก เช่น k7mp-3xra-9wfe
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export function temporaryPassword(): string {
  const group = () => Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
  return `${group()}-${group()}-${group()}`;
}
