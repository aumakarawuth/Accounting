import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../apps/api/src/app';
import { devAuth } from '../apps/api/src/auth';
import { createPool } from '../apps/api/src/db';
import { authConfigFromEnv } from '../apps/api/src/config';
import { apiUrl } from './global-setup';
import { pool as adminPool, newSchool, newUser, newClassroom, newCompany } from './helpers';

const apiPool = createPool(apiUrl());
// devAuth ไม่ใช้ cookie จึงไม่ตรวจ Origin (CSRF ทดสอบใน auth.test.ts)
const app = buildApp({ pool: apiPool, auth: devAuth(), cfg: { ...authConfigFromEnv({}), allowedOrigins: false } });
let a: string, b: string, teacher: string, coA: string, coB: string;

beforeAll(async () => {
  const school = await newSchool();
  a = await newUser(school, 'student');
  b = await newUser(school, 'student');
  teacher = await newUser(school, 'teacher');
  const room = await newClassroom(school, teacher, [a]);
  coA = await newCompany(a, room);
  coB = await newCompany(b);
});
afterAll(async () => { await app.close(); await apiPool.end(); await adminPool.end(); });

const lines = [{ account_code: '1110', debit: '12500.00' }, { account_code: '4120', credit: '12500.00' }];
const post = (user: string, company: string, payload: unknown, key: string | null = randomUUID()) =>
  app.inject({
    method: 'POST', url: `/companies/${company}/journal`, payload,
    headers: { 'x-dev-user-id': user, ...(key ? { 'idempotency-key': key } : {}) },
  });

describe('API (Fastify → post_journal)', () => {
  it('ผ่านรายการแล้วได้เลขที่เอกสาร และกดซ้ำด้วย key เดิมได้รายการเดิม', async () => {
    const key = randomUUID();
    const r1 = await post(a, coA, { date: '2026-10-15', description: 'รับเงินค่าบริการ', lines }, key);
    expect(r1.statusCode).toBe(201);
    expect(r1.json().docNo).toBe('JV-0001');
    const r2 = await post(a, coA, { date: '2026-10-15', description: 'รับเงินค่าบริการ', lines }, key);
    expect(r2.json()).toEqual(r1.json());
    const n = await adminPool.query('select count(*)::int n from acc.journal_entries where company_id=$1', [coA]);
    expect(n.rows[0].n).toBe(1);
  });

  it('ไม่ดุลได้ 422 พร้อมข้อความผลต่างจาก DB', async () => {
    const r = await post(a, coA, { date: '2026-10-15', lines: [lines[0], { account_code: '4120', credit: '12000.00' }] });
    expect(r.statusCode).toBe(422);
    expect(r.json()).toEqual({ code: 'ACC01', message: 'เดบิต 12,500.00 ไม่เท่าเครดิต 12,000.00 ผลต่าง 500.00' });
  });

  it('ปฏิเสธเงินที่เป็น number (กัน float) และฟิลด์แปลกปลอม ด้วย 400', async () => {
    const r1 = await post(a, coA, { date: '2026-10-15', lines: [{ account_code: '1110', debit: 100.1 }, { account_code: '4120', credit: '100.10' }] });
    expect(r1.statusCode).toBe(400);
    const r2 = await post(a, coA, { date: '2026-10-15', lines, company_id: coB });
    expect(r2.statusCode).toBe(400);
  });

  it('ไม่มี idempotency key ได้ 400, ไม่ระบุผู้ใช้ได้ 401', async () => {
    expect((await post(a, coA, { date: '2026-10-15', lines }, null)).statusCode).toBe(400);
    const r = await app.inject({ method: 'GET', url: `/companies/${coA}/journal` });
    expect(r.statusCode).toBe(401);
  });

  it('IDOR: นักเรียน A อ่านบริษัท B ได้ 404 และลงบัญชีบริษัท B ได้ 403', async () => {
    for (const path of ['', '/journal', '/accounts', '/trial-balance']) {
      const r = await app.inject({ method: 'GET', url: `/companies/${coB}${path}`, headers: { 'x-dev-user-id': a } });
      expect(r.statusCode, path).toBe(404);
    }
    expect((await post(a, coB, { date: '2026-10-15', lines })).statusCode).toBe(403);
  });

  it('ครูอ่านบริษัทนักเรียนในห้องได้ แต่ลงบัญชีไม่ได้', async () => {
    const r = await app.inject({ method: 'GET', url: `/companies/${coA}/journal`, headers: { 'x-dev-user-id': teacher } });
    expect(r.statusCode).toBe(200);
    expect(r.json().length).toBeGreaterThan(0);
    expect((await post(teacher, coA, { date: '2026-10-15', lines })).statusCode).toBe(403);
  });

  it('งบทดลองคืนเงินเป็นสตริง และดุล; กลับรายการได้ RV', async () => {
    const tb = await app.inject({ method: 'GET', url: `/companies/${coA}/trial-balance`, headers: { 'x-dev-user-id': a } });
    const rows = tb.json() as { code: string; debit: string; credit: string }[];
    expect(rows.find((x) => x.code === '1110')?.debit).toBe('12500.00');
    const entry = (await app.inject({ method: 'GET', url: `/companies/${coA}/journal`, headers: { 'x-dev-user-id': a } })).json()[0];
    const rv = await app.inject({
      method: 'POST', url: `/companies/${coA}/journal/${entry.id}/reverse`, payload: { date: '2026-10-16' },
      headers: { 'x-dev-user-id': a, 'idempotency-key': randomUUID() },
    });
    expect(rv.statusCode).toBe(201);
    expect(rv.json().docNo).toBe('RV-0001');
  });
});
