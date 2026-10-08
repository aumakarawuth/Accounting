import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../apps/api/src/app';
import { devAuth } from '../apps/api/src/auth';
import { authConfigFromEnv } from '../apps/api/src/config';
import { createPool } from '../apps/api/src/db';
import { apiUrl } from './global-setup';
import { pool as db, newSchool, newUser, newClassroom, newCompany, sqlstate } from './helpers';

// กระดาษทำการ: รายการปรับปรุง AJ ลงวันสิ้นเดือน · ช่องปรับปรุงมีเฉพาะ AJ ของเดือน (และการกลับรายการของมัน)
// ทุกคู่ช่องดุล · กำไรสุทธิทำให้งบกำไรขาดทุนและงบฐานะการเงินดุล · ผู้ดูแลระบบเปิด/ปิดแบบ 6/8/10 ช่อง
const apiPool = createPool(apiUrl());
const app = buildApp({ pool: apiPool, auth: devAuth(), cfg: { ...authConfigFromEnv({}), allowedOrigins: false } });
afterAll(async () => { await app.close(); await apiPool.end(); await db.end(); });

const roles = new Map<string, string>();
const as = (user: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, payload, headers: { 'x-dev-user-id': user, 'x-dev-role': roles.get(user) ?? 'student', 'idempotency-key': randomUUID() } });

let school: string, admin: string, teacher: string, owner: string, co: string;
beforeAll(async () => {
  school = await newSchool();
  admin = await newUser(school, 'admin');
  roles.set(admin, 'admin');
  teacher = await newUser(school, 'teacher');
  roles.set(teacher, 'teacher');
  owner = await newUser(school, 'student');
  const room = await newClassroom(school, teacher, [owner]);
  co = await newCompany(owner, room);
});

const jv = (date: string, lines: { account_code: string; debit?: string; credit?: string }[], adjusting = false) =>
  as(owner, 'POST', `/companies/${co}/journal`, { date, description: adjusting ? 'ปรับปรุง' : 'ทดสอบ', lines, adjusting });

describe('กระดาษทำการ', () => {
  it('รายการปรับปรุงได้เลขที่ AJ และต้องลงวันสิ้นเดือน', async () => {
    // ลงทุน 100,000 · ซื้อวัสดุ 6,000 · ค่าเช่าจ่ายล่วงหน้า 12,000 · รายได้ 30,000 · ค่าจ้าง 8,000
    for (const [d, l] of [
      ['2026-10-01', [{ account_code: '1110', debit: '100000' }, { account_code: '3110', credit: '100000' }]],
      ['2026-10-02', [{ account_code: '1510', debit: '6000' }, { account_code: '1110', credit: '6000' }]],
      ['2026-10-03', [{ account_code: '1310', debit: '12000' }, { account_code: '1110', credit: '12000' }]],
      ['2026-10-10', [{ account_code: '1110', debit: '30000' }, { account_code: '4120', credit: '30000' }]],
      ['2026-10-20', [{ account_code: '5210', debit: '8000' }, { account_code: '1110', credit: '8000' }]],
    ] as const) expect((await jv(d, [...l])).statusCode).toBe(201);

    const bad = await jv('2026-10-30', [{ account_code: '5260', debit: '1' }, { account_code: '1510', credit: '1' }], true);
    expect(bad.statusCode).toBe(400);
    expect(bad.json().message).toContain('สิ้นเดือน (31/10/2569)');
    const aj = await jv('2026-10-31', [{ account_code: '5260', debit: '2500' }, { account_code: '1510', credit: '2500' }], true);
    expect(aj.statusCode).toBe(201);
    expect(aj.json().docNo).toBe('AJ-0001');
    expect((await jv('2026-10-31', [{ account_code: '5220', debit: '1000' }, { account_code: '1310', credit: '1000' }], true)).json().docNo).toBe('AJ-0002');
  });

  it('10 ช่อง: ช่องปรับปรุงมีเฉพาะ AJ ของเดือน ทุกคู่ช่องดุล กำไรสุทธิปิดงบกำไรขาดทุนกับงบฐานะการเงิน', async () => {
    const r = await as(owner, 'GET', `/companies/${co}/worksheet?month=2026-10`);
    expect(r.statusCode).toBe(200);
    const w = r.json();
    expect(w).toMatchObject({ format: 10, formats: [6, 8, 10] });
    const row = (code: string) => w.rows.find((x: { code: string }) => x.code === code);
    expect(row('1510')).toMatchObject({ tb: { debit: '6000.00', credit: '0.00' }, adj: { debit: '0.00', credit: '2500.00' }, atb: { debit: '3500.00' }, is: null, bs: { debit: '3500.00' } });
    expect(row('5260')).toMatchObject({ tb: { debit: '0.00', credit: '0.00' }, adj: { debit: '2500.00' }, is: { debit: '2500.00' }, bs: null });
    expect(w.totals).toEqual({
      tb: { debit: '130000.00', credit: '130000.00' },
      adj: { debit: '3500.00', credit: '3500.00' },
      atb: { debit: '130000.00', credit: '130000.00' },
      is: { debit: '11500.00', credit: '30000.00' },
      bs: { debit: '118500.00', credit: '100000.00' },
    });
    expect(w.netIncome).toBe('18500.00');
    expect(w.result).toEqual({ is: { debit: '18500.00', credit: '0.00' }, bs: { debit: '0.00', credit: '18500.00' } });
    expect(w.grand).toEqual({ is: { debit: '30000.00', credit: '30000.00' }, bs: { debit: '118500.00', credit: '118500.00' } });

    // เดือนถัดไป: AJ ของ ต.ค. อยู่ในยอดยกมาแล้ว ไม่อยู่ในช่องปรับปรุง
    const nov = (await as(owner, 'GET', `/companies/${co}/worksheet?month=2026-11`)).json();
    expect(nov.totals.adj).toEqual({ debit: '0.00', credit: '0.00' });
    expect(nov.rows.find((x: { code: string }) => x.code === '1510').tb.debit).toBe('3500.00');
  });

  it('6 ช่อง ใช้ยอดหลังปรับปรุง · 8 ช่อง งบทดลองก่อนปรับปรุง · กลับรายการ AJ ในเดือนอยู่ช่องปรับปรุง', async () => {
    const six = (await as(owner, 'GET', `/companies/${co}/worksheet?month=2026-10&format=6`)).json();
    expect(six.rows.find((x: { code: string }) => x.code === '1510').tb.debit).toBe('3500.00');
    expect(six.totals.tb).toEqual(six.totals.atb);
    const eight = (await as(owner, 'GET', `/companies/${co}/worksheet?month=2026-10&format=8`)).json();
    expect(eight.rows.find((x: { code: string }) => x.code === '1510').tb.debit).toBe('6000.00');

    const aj2 = (await db.query(`select id from acc.journal_entries where company_id = $1 and doc_no = 'AJ-0002'`, [co])).rows[0].id;
    expect((await as(owner, 'POST', `/companies/${co}/journal/${aj2}/reverse`, { date: '2026-10-31' })).statusCode).toBe(201);
    const after = (await as(owner, 'GET', `/companies/${co}/worksheet?month=2026-10`)).json();
    expect(after.totals.adj).toEqual({ debit: '4500.00', credit: '4500.00' });
    expect(after.rows.find((x: { code: string }) => x.code === '1310').atb.debit).toBe('12000.00');
    expect(after.totals.tb).toEqual({ debit: '130000.00', credit: '130000.00' });
  });

  it('ผู้ดูแลระบบเปิด/ปิดแบบกระดาษทำการ ครู/นักเรียนตั้งไม่ได้ แบบที่ปิดเปิดดูไม่ได้', async () => {
    expect((await as(teacher, 'POST', '/admin/settings/worksheet', { formats: [10] })).statusCode).toBe(403);
    expect((await as(admin, 'POST', '/admin/settings/worksheet', { formats: [7] })).statusCode).toBe(400);
    expect((await as(admin, 'GET', '/admin/settings')).json()).toEqual({ worksheetFormats: [6, 8, 10] });
    const r = await as(admin, 'POST', '/admin/settings/worksheet', { formats: [10, 6, 10] });
    expect(r.json()).toEqual({ worksheetFormats: [6, 10] });
    expect((await as(owner, 'GET', `/companies/${co}/worksheet?month=2026-10&format=8`)).statusCode).toBe(403);
    expect((await as(owner, 'GET', `/companies/${co}/worksheet?month=2026-10`)).json().format).toBe(10);
    await as(admin, 'POST', '/admin/settings/worksheet', { formats: [] });
    expect((await as(teacher, 'GET', `/companies/${co}/worksheet?month=2026-10`)).json()).toEqual({ month: '2026-10', formats: [], format: null });
    // ทำได้เฉพาะผ่านฟังก์ชันของผู้ดูแลระบบ แก้ตารางตรงไม่ได้
    expect(await db.query('update acc.schools set worksheet_formats = $2 where id = $1', [school, [9]]).then(() => 'ok', sqlstate)).toBe('23514');
    await as(admin, 'POST', '/admin/settings/worksheet', { formats: [6, 8, 10] });
  });
  it('รายการสุ่ม (ปกติ ปรับปรุง กลับรายการ) ทุกเดือน: ทุกคู่ช่องดุล งบทดลองหลังปรับปรุงตรงกับหน้างบทดลอง', async () => {
    const other = await newUser(school, 'student');
    const room2 = await newClassroom(school, teacher, [other]);
    const co2 = await newCompany(other, room2);
    let seed = 20261014;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % n; };
    const codes = ['1110', '1120', '1210', '1310', '1510', '2110', '3110', '4110', '4120', '5210', '5220', '5260'];
    const months = ['2026-09', '2026-10', '2026-11'];
    const ids: string[] = [];
    for (let i = 0; i < 60; i++) {
      const m = months[rnd(3)]!;
      const adjusting = rnd(3) === 0;
      const date = adjusting ? (m === '2026-09' ? '2026-09-30' : m === '2026-10' ? '2026-10-31' : '2026-11-30') : `${m}-${String(1 + rnd(28)).padStart(2, '0')}`;
      const amt = `${1 + rnd(50000)}.${String(rnd(100)).padStart(2, '0')}`;
      const a = codes[rnd(codes.length)]!;
      let b = codes[rnd(codes.length)]!;
      if (b === a) b = '1110' === a ? '3110' : '1110';
      const r = await app.inject({ method: 'POST', url: `/companies/${co2}/journal`, payload: { date, description: 'สุ่ม', adjusting, lines: [{ account_code: a, debit: amt }, { account_code: b, credit: amt }] },
        headers: { 'x-dev-user-id': other, 'x-dev-role': 'student', 'idempotency-key': randomUUID() } });
      expect(r.statusCode).toBe(201);
      ids.push(r.json().id);
    }
    for (const id of ids.filter(() => rnd(6) === 0)) {
      const e = (await db.query('select entry_date::text d from acc.journal_entries where id = $1', [id])).rows[0];
      const r = await app.inject({ method: 'POST', url: `/companies/${co2}/journal/${id}/reverse`, payload: { date: e.d },
        headers: { 'x-dev-user-id': other, 'x-dev-role': 'student', 'idempotency-key': randomUUID() } });
      expect(r.statusCode).toBe(201);
    }
    const get = (url: string) => app.inject({ method: 'GET', url, headers: { 'x-dev-user-id': other, 'x-dev-role': 'student' } }).then((r) => r.json());
    const cents = (x: string) => Math.round(Number(x) * 100);
    for (const m of months) {
      const w = await get(`/companies/${co2}/worksheet?month=${m}`);
      for (const k of ['tb', 'adj', 'atb'] as const) expect(w.totals[k].debit).toBe(w.totals[k].credit);
      expect(w.grand.is.debit).toBe(w.grand.is.credit);
      expect(w.grand.bs.debit).toBe(w.grand.bs.credit);
      for (const r of w.rows) {
        expect(cents(r.tb.debit) - cents(r.tb.credit) + cents(r.adj.debit) - cents(r.adj.credit)).toBe(cents(r.atb.debit) - cents(r.atb.credit));
      }
      const tb = await get(`/companies/${co2}/trial-balance?month=${m}`);
      expect(w.rows.filter((r: { atb: { debit: string; credit: string } }) => r.atb.debit !== '0.00' || r.atb.credit !== '0.00')
        .map((r: { code: string; atb: { debit: string; credit: string } }) => [r.code, r.atb.debit, r.atb.credit]))
        .toEqual(tb.rows.map((r: { code: string; debit: string; credit: string }) => [r.code, r.debit, r.credit]));
      expect(w.totals.atb).toEqual({ debit: tb.totalDebit, credit: tb.totalCredit });
    }
  });
});
