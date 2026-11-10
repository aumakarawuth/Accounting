import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createPool, withUser } from '../apps/api/src/db';
import { apiUrl } from './global-setup';
import { pool as db, asUser, newSchool, newUser, newClassroom, newCompany } from './helpers';

// ความเร็ว (docs/performance.md): RLS แบบชุด id บริษัท และการตั้งตัวตนรอบเดียว — ต้องไม่เปลี่ยนสิทธิ์และไม่ทำให้ค่าเพี้ยน
const apiPool = createPool(apiUrl());
afterAll(async () => { await apiPool.end(); await db.end(); });

describe('withUser ตั้งตัวตนในรอบเดียวกับ begin', () => {
  it('ค่าที่มีอัญประกาศ/backslash/อัฒภาค ถูกเก็บตรงตัว ไม่กลายเป็นคำสั่ง SQL', async () => {
    const id = randomUUID();
    const info = `1.2.3.4 / Mozilla'); drop table acc.users; -- \\ "x" ไทย`;
    const got = await withUser(apiPool, { id, role: 'student', mustChange: false, displayName: '', studentCode: null, clientInfo: info }, async (c) =>
      (await c.query(`select current_setting('app.user_id') as id, current_setting('app.client_info') as info`)).rows[0]);
    expect(got).toEqual({ id, info });
    expect((await db.query(`select to_regclass('acc.users') is not null as ok`)).rows[0].ok).toBe(true);
    // ค่าหมดอายุพร้อมทรานแซกชัน (transaction pooling ไม่รั่วข้ามคำขอ)
    const c = await apiPool.connect();
    try { expect((await c.query(`select coalesce(current_setting('app.user_id', true), '') as id`)).rows[0].id).toBe(''); } finally { c.release(); }
  });
});

describe('RLS: app.readable_company_ids ตรงกับ app.can_read_company ทุกกรณี', () => {
  it('เจ้าของ ครูประจำห้อง ครูห้องอื่น ครูที่ถูกปิดบัญชี นักเรียนคนอื่น ผู้ดูแล', async () => {
    const school = await newSchool();
    const t1 = await newUser(school, 'teacher');
    const t2 = await newUser(school, 'teacher');
    const off = await newUser(school, 'teacher');
    const admin = await newUser(school, 'admin');
    const [s1, s2] = [await newUser(school, 'student'), await newUser(school, 'student')];
    const r1 = await newClassroom(school, t1, [s1, s2]);
    const r3 = await newClassroom(school, off, [s2]);
    const companies = [await newCompany(s1, r1), await newCompany(s2, r1), await newCompany(s2, r3), await newCompany(s1, null)];
    await db.query('update acc.users set active = false where id = $1', [off]);
    for (const u of [s1, s2, t1, t2, off, admin]) {
      const viaFn = await asUser(u, async (c) =>
        (await c.query('select id from acc.companies where id = any($1) and app.can_read_company(id) order by id', [companies])).rows.map((r) => r.id));
      // ผ่าน policy ใหม่ของตาราง (RLS) โดยตรง
      const viaRls = await asUser(u, async (c) =>
        (await c.query('select id from acc.companies where id = any($1) order by id', [companies])).rows.map((r) => r.id));
      const viaSet = await asUser(u, async (c) =>
        (await c.query('select x as id from app.readable_company_ids() x where x = any($1) order by 1', [companies])).rows.map((r) => r.id));
      expect(viaRls).toEqual(viaFn);
      expect(viaSet).toEqual(viaFn);
    }
  });

  it('ไม่มีตัวตน (app.user_id ว่าง) = ไม่เห็นบริษัทใด', async () => {
    expect(await asUser(null, async (c) => (await c.query('select count(*)::int n from app.readable_company_ids()')).rows[0].n)).toBe(0);
  });

  it('policy อ่านของตารางบัญชีทุกตัวไม่เรียกฟังก์ชันรายแถวแล้ว (กันถอยหลัง)', async () => {
    const r = await db.query(`select tablename, policyname from pg_policies
      where schemaname = 'acc' and cmd = 'SELECT' and qual like '%can_read_company%'`);
    expect(r.rows).toEqual([]);
    const school = await newSchool();
    const s = await newUser(school, 'student');
    const co = await newCompany(s, null);
    const plan = await asUser(s, async (c) =>
      (await c.query(`explain (costs off) select count(*) from acc.journal_entries where company_id = $1`, [co])).rows.map((x) => x['QUERY PLAN']).join('\n'));
    expect(plan).not.toContain('can_read_company');
    expect(plan).toContain('hashed SubPlan');
  });
});
