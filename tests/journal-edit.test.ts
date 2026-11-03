import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../apps/api/src/app';
import { devAuth } from '../apps/api/src/auth';
import { authConfigFromEnv } from '../apps/api/src/config';
import { createPool } from '../apps/api/src/db';
import { apiUrl } from './global-setup';
import { pool as db, newSchool, newUser, newClassroom, newCompany } from './helpers';

// แก้ไขรายการ = กลับรายการเดิม + ลงรายการใหม่ในธุรกรรมเดียว · เอกสารขาย/ซื้อแก้ทางนี้ไม่ได้ · แก้ซ้ำไม่ได้
const apiPool = createPool(apiUrl());
const app = buildApp({ pool: apiPool, auth: devAuth(), cfg: { ...authConfigFromEnv({}), allowedOrigins: false } });
afterAll(async () => { await app.close(); await apiPool.end(); await db.end(); });

let owner: string, co: string;
beforeAll(async () => {
  const school = await newSchool();
  const teacher = await newUser(school, 'teacher');
  owner = await newUser(school, 'student');
  co = await newCompany(owner, await newClassroom(school, teacher, [owner]));
});
const post = (url: string, payload: unknown, key = randomUUID()) =>
  app.inject({ method: 'POST', url, payload, headers: { 'x-dev-user-id': owner, 'x-dev-role': 'student', 'idempotency-key': key } });
const lines = (amt: string) => [{ account_code: '1110', debit: amt }, { account_code: '3110', credit: amt }];

describe('แก้ไขรายการสมุดรายวัน', () => {
  it('กลับรายการเดิมแล้วลงใหม่ เลขที่ต่อเนื่อง งบยังดุล แก้ซ้ำไม่ได้ กดซ้ำได้ผลเดิม', async () => {
    const a = (await post(`/companies/${co}/journal`, { date: '2026-10-05', description: 'ลงทุน', lines: lines('1000') })).json();
    expect(a.docNo).toBe('JV-0001');
    const key = randomUUID();
    const r = await post(`/companies/${co}/journal/${a.id}/replace`, { date: '2026-10-05', description: 'ลงทุน (แก้)', lines: lines('1500') }, key);
    expect(r.statusCode).toBe(201);
    expect(r.json().docNo).toBe('JV-0002');
    expect((await post(`/companies/${co}/journal/${a.id}/replace`, { date: '2026-10-05', description: 'ลงทุน (แก้)', lines: lines('1500') }, key)).json().docNo).toBe('JV-0002');
    const rv = (await db.query(`select doc_no, description from acc.journal_entries where company_id = $1 and reverses_entry_id = $2`, [co, a.id])).rows;
    expect(rv).toEqual([{ doc_no: 'RV-0001', description: 'แก้ไข JV-0001' }]);
    const cash = (await db.query(`select sum(l.debit - l.credit)::text b from acc.journal_lines l join acc.chart_of_accounts c on c.id = l.account_id where l.company_id = $1 and c.code = '1110'`, [co])).rows[0].b;
    expect(cash).toBe('1500.00');
    expect((await post(`/companies/${co}/journal/${a.id}/replace`, { date: '2026-10-05', lines: lines('9') })).statusCode).toBe(409);
  });

  it('รายการไม่สมดุลแล้วไม่กลับรายการเดิม (ทั้งธุรกรรมยกเลิก)', async () => {
    const a = (await post(`/companies/${co}/journal`, { date: '2026-10-06', lines: lines('200') })).json();
    const bad = await post(`/companies/${co}/journal/${a.id}/replace`, { date: '2026-10-06', lines: [{ account_code: '1110', debit: '5' }, { account_code: '3110', credit: '4' }] });
    expect(bad.statusCode).toBeGreaterThanOrEqual(400);
    expect((await db.query('select count(*)::int n from acc.journal_entries where company_id = $1 and reverses_entry_id = $2', [co, a.id])).rows[0].n).toBe(0);
  });
});
