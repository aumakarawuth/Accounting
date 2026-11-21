import { randomUUID } from 'node:crypto';
import { buildApp } from '../apps/api/src/app';
import { devAuth } from '../apps/api/src/auth';
import { authConfigFromEnv } from '../apps/api/src/config';
import { createPool } from '../apps/api/src/db';
import { apiUrl } from './global-setup';
import { pool as db, newSchool, newUser, newClassroom, newCompany, taxId } from './helpers';

// ชุดช่วยของเฟส 6 (docs/phase6-spec.md): API จริงบน Postgres จริง บริษัทจด VAT พร้อมลูกค้า/ผู้ขาย/สินค้าไม่ติดตามสต็อก
export function curriculumApp() {
  const apiPool = createPool(apiUrl());
  const app = buildApp({ pool: apiPool, auth: devAuth(), cfg: { ...authConfigFromEnv({}), allowedOrigins: false } });
  type Method = 'GET' | 'POST' | 'PATCH' | 'PUT';
  const as = (user: string, method: Method, url: string, payload?: unknown, key = randomUUID()) =>
    app.inject({ method, url, payload: payload as object, headers: { 'x-dev-user-id': user, 'x-dev-role': 'student', 'idempotency-key': key } });
  async function ok(user: string, method: Method, url: string, payload?: unknown, key?: string) {
    const r = await as(user, method, url, payload, key);
    if (r.statusCode >= 300) throw new Error(`${method} ${url} → ${r.statusCode} ${r.body}`);
    return r.statusCode === 204 ? null : r.json();
  }
  async function close() { await app.close(); await apiPool.end(); await db.end(); }

  /** นักเรียนเจ้าของบริษัทจด VAT + นักเรียนอีกคนในห้องเดียวกัน */
  async function setup(opts: { vat?: boolean } = {}) {
    const school = await newSchool();
    const teacher = await newUser(school, 'teacher');
    const owner = await newUser(school, 'student');
    const other = await newUser(school, 'student');
    const room = await newClassroom(school, teacher, [owner, other]);
    const co = await newCompany(owner, room);
    if (opts.vat !== false) {
      const prof = await ok(owner, 'GET', `/companies/${co}/profile`);
      await ok(owner, 'PATCH', `/companies/${co}/profile`, { version: prof.version, taxId: taxId(8001), address: 'กรุงเทพฯ', vatRegistered: true });
    }
    for (const p of [
      { code: 'C1', name: 'ร้าน ลูกค้าหนึ่ง', isCustomer: true, isVendor: false, taxId: taxId(8101), vatRegistered: true, creditDays: 30 },
      { code: 'C2', name: 'ร้าน ลูกค้าสอง', isCustomer: true, isVendor: false, taxId: taxId(8102), vatRegistered: true, creditDays: 30 },
      { code: 'V1', name: 'ร้าน ขายส่ง', isCustomer: false, isVendor: true, taxId: taxId(8201), vatRegistered: true },
    ]) await ok(owner, 'POST', `/companies/${co}/parties`, p);
    await ok(owner, 'POST', `/companies/${co}/items`, { code: 'G', name: 'สินค้าทั่วไป', unit: 'ชิ้น', isService: false });
    return { school, teacher, owner, other, room, co };
  }
  return { app, as, ok, close, setup };
}

/** สตางค์ (BigInt) จากสตริงทศนิยม */
export const cents = (v: string) => {
  const neg = v.startsWith('-');
  const [i, f = ''] = (neg ? v.slice(1) : v).split('.');
  const c = BigInt(i || '0') * 100n + BigInt((f + '00').slice(0, 2));
  return neg ? -c : c;
};
export const fromCents = (c: bigint) => `${c < 0n ? '-' : ''}${(c < 0n ? -c : c) / 100n}.${String((c < 0n ? -c : c) % 100n).padStart(2, '0')}`;
