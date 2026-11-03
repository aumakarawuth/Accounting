import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../apps/api/src/app';
import { devAuth } from '../apps/api/src/auth';
import { authConfigFromEnv } from '../apps/api/src/config';
import { createPool } from '../apps/api/src/db';
import { apiUrl } from './global-setup';
import { pool as db, newSchool, newUser, newClassroom, newCompany } from './helpers';

// เฟส 3.3–3.4 ผ่าน API: ทะเบียนเช็ค (รับจากใบเสร็จ นำฝาก ผ่าน คืน) สินทรัพย์ถาวร (ลงทะเบียน ค่าเสื่อม จำหน่าย กลับรายการ) และสิทธิ์
const apiPool = createPool(apiUrl());
const app = buildApp({ pool: apiPool, auth: devAuth(), cfg: { ...authConfigFromEnv({}), allowedOrigins: false } });
afterAll(async () => { await app.close(); await apiPool.end(); await db.end(); });

const teachers = new Set<string>();
const as = (user: string, method: 'GET' | 'POST', url: string, payload?: unknown, key: string | null = randomUUID()) =>
  app.inject({ method, url, payload, headers: {
    'x-dev-user-id': user, 'x-dev-role': teachers.has(user) ? 'teacher' : 'student', ...(key ? { 'idempotency-key': key } : {}) } });

let teacher: string, owner: string, other: string, co: string;
beforeAll(async () => {
  const school = await newSchool();
  teacher = await newUser(school, 'teacher');
  teachers.add(teacher);
  owner = await newUser(school, 'student');
  other = await newUser(school, 'student');
  const room = await newClassroom(school, teacher, [owner, other]);
  co = await newCompany(owner, room);
  await db.query('update acc.companies set vat_registered = false, version = version + 1 where id = $1', [co]);
  await db.query(`insert into acc.parties (company_id, code, name, is_customer, credit_days) values ($1, 'C1', 'ลูกค้าหนึ่ง', true, 30)`, [co]);
  await db.query(`insert into acc.items (company_id, code, name, unit, is_service) values ($1, 'G1', 'สินค้า', 'ชิ้น', false)`, [co]);
});

describe('API เช็ค', () => {
  it('รับเช็คจากใบเสร็จ → นำฝาก → ผ่าน · ข้อผิดพลาดบอกสาเหตุ · คำขอซ้ำได้ผลเดิม · คนอื่น 404 ครู 403', async () => {
    const invRes = await as(owner, 'POST', `/companies/${co}/sales/invoice`, { date: '2026-10-01', partyCode: 'C1', lines: [{ itemCode: 'G1', qty: '2', unitPrice: '250' }] });
    expect(invRes.statusCode).toBe(201);
    const inv = invRes.json();
    const key = randomUUID();
    const body = {
      direction: 'received', chequeNo: '7788', bankName: 'ธนาคารกรุงเทพ', chequeDate: '2026-10-15', date: '2026-10-10',
      receipt: { partyCode: 'C1', allocations: [{ documentId: inv.id, amount: '500.00' }] },
    };
    const r = await as(owner, 'POST', `/companies/${co}/cheques`, body, key);
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ status: 'on_hand', holdingCode: '1221', amount: '500.00', partyName: 'ลูกค้าหนึ่ง', postdated: true, documentNo: 'RE-0001' });
    expect((await as(owner, 'POST', `/companies/${co}/cheques`, body, key)).json().id).toBe(r.json().id);
    expect((await as(owner, 'POST', `/companies/${co}/cheques`, { ...body, receipt: undefined, counterAccount: '4110', amount: '1' }, null)).statusCode).toBe(400);
    expect((await as(owner, 'POST', `/companies/${co}/cheques`, { ...body, counterAccount: '4110' })).statusCode).toBe(400);
    const id = r.json().id as string;

    const early = await as(owner, 'POST', `/companies/${co}/cheques/${id}/actions`, { action: 'deposit', date: '2026-10-12', bankAccount: '1120' });
    expect(early.statusCode).toBe(409);
    expect(early.json()).toMatchObject({ code: 'ACC18', message: expect.stringContaining('15/10/2569') });
    expect((await as(teacher, 'POST', `/companies/${co}/cheques/${id}/actions`, { action: 'deposit', date: '2026-10-15', bankAccount: '1120' })).statusCode).toBe(403);
    expect((await as(other, 'GET', `/companies/${co}/cheques`)).statusCode).toBe(404);
    const dep = await as(owner, 'POST', `/companies/${co}/cheques/${id}/actions`, { action: 'deposit', date: '2026-10-15', bankAccount: '1120' });
    expect(dep.json()).toMatchObject({ status: 'deposited', depositCode: '1120' });
    const clear = await as(owner, 'POST', `/companies/${co}/cheques/${id}/actions`, { action: 'clear', date: '2026-10-16' });
    expect(clear.json()).toMatchObject({ status: 'cleared', statusDocNo: 'CQ-0001' });

    const list = (await as(teacher, 'GET', `/companies/${co}/cheques`)).json();
    expect(list.company.canWrite).toBe(false);
    expect(list.cheques).toHaveLength(1);
    expect(list.bankAccounts.map((a: { code: string }) => a.code)).toEqual(['1120', '1130']);
    expect(list.accounts.some((a: { code: string }) => a.code === '1220')).toBe(false);
  });
});

describe('API สินทรัพย์ถาวร', () => {
  it('ลงทะเบียน → ค่าเสื่อม AJ → ทะเบียน ณ สิ้นเดือน → กลับรายการ → ขาย มีกำไร/ขาดทุน', async () => {
    const reg = await as(owner, 'POST', `/companies/${co}/fixed-assets`, {
      code: 'car-1', name: 'รถยนต์', acquiredDate: '2026-07-01', cost: '600000', salvage: '60000', lifeMonths: 60,
      assetAccount: '1630', accumAccount: '1631', counterAccount: '1120',
    });
    expect(reg.statusCode).toBe(201);
    const assetId = reg.json().id as string;
    expect((await as(owner, 'POST', `/companies/${co}/fixed-assets`, { code: 'X', name: 'x', acquiredDate: '2026-07-01', cost: '10', lifeMonths: 0, assetAccount: '1630', accumAccount: '1631' })).statusCode).toBe(400);

    const jul = await as(owner, 'POST', `/companies/${co}/depreciation`, { month: '2026-07' });
    expect(jul.statusCode).toBe(201);
    expect(jul.json().docNo).toMatch(/^AJ-/);
    const aug = await as(owner, 'POST', `/companies/${co}/depreciation`, { month: '2026-08' });
    expect((await as(owner, 'POST', `/companies/${co}/depreciation`, { month: '2026-08' })).statusCode).toBe(409);

    const page = (await as(owner, 'GET', `/companies/${co}/fixed-assets?month=2026-08`)).json();
    expect(page.assets).toHaveLength(1);
    expect(page.assets[0]).toMatchObject({ code: 'CAR-1', monthly: '9000.00', monthsPosted: 2, accumulated: '18000.00', bookValue: '582000.00', depThisMonth: '9000.00', status: 'active', nextMonth: '2026-09' });
    expect(page.runs.map((r: { month: string }) => r.month)).toEqual(['2026-08', '2026-07']);
    expect(page.assetAccounts.map((a: { code: string }) => a.code)).toContain('1631');

    const v = await as(owner, 'POST', `/companies/${co}/depreciation/${aug.json().id}/void`, {});
    expect(v.statusCode).toBe(200);
    expect((await as(owner, 'POST', `/companies/${co}/depreciation/${aug.json().id}/void`, {})).statusCode).toBe(409);
    // ยังไม่ลง ส.ค. → ขายเดือน ก.ย. ไม่ได้
    const blocked = await as(owner, 'POST', `/companies/${co}/fixed-assets/${assetId}/dispose`, { date: '2026-09-10', proceeds: '500000', proceedsAccount: '1120' });
    expect(blocked.json()).toMatchObject({ code: 'ACC18', message: expect.stringContaining('ส.ค. 2569') });
    const sold = await as(owner, 'POST', `/companies/${co}/fixed-assets/${assetId}/dispose`, { date: '2026-08-10', proceeds: '500000', proceedsAccount: '1120' });
    expect(sold.statusCode).toBe(201);
    expect(sold.json()).toMatchObject({ gainLoss: '-91000.00', docNo: 'FD-0001' });
    const after = (await as(owner, 'GET', `/companies/${co}/fixed-assets?month=2026-08`)).json();
    expect(after.assets[0]).toMatchObject({ status: 'disposed', bookValue: '0.00', gainLoss: '-91000.00' });
    expect((await as(owner, 'POST', `/companies/${co}/asset-disposals/${sold.json().id}/void`, { reason: '' })).statusCode).toBe(400);
    expect((await as(owner, 'POST', `/companies/${co}/asset-disposals/${sold.json().id}/void`, { reason: 'ลงผิด' })).statusCode).toBe(200);
    expect((await as(teacher, 'POST', `/companies/${co}/depreciation`, { month: '2026-08' })).statusCode).toBe(403);
    expect((await as(other, 'GET', `/companies/${co}/fixed-assets`)).statusCode).toBe(404);
    const lines = (await as(owner, 'GET', `/companies/${co}/fixed-assets/${assetId}/lines`)).json();
    expect(lines.map((l: { month: string }) => l.month)).toEqual(['2026-07']);
  });
});
