import { describe, it, expect, afterAll } from 'vitest';
import { createPool } from '../apps/api/src/db';
import { apiUrl } from './global-setup';
import { pool as admin } from './helpers';

// ฐานข้อมูลตัดการเชื่อมต่อที่ว่างอยู่ (รีสตาร์ต, pooler ของ Supabase ปิด idle) ต้องไม่ทำให้ API ทั้งโปรเซสล่ม
afterAll(async () => { await admin.end(); });

describe('pool ของ API', () => {
  it('การเชื่อมต่อว่างถูกตัด: ไม่ล่ม และคำขอถัดไปต่อใหม่ได้', async () => {
    const pool = createPool(apiUrl(), 1);
    try {
      // ไม่มีตัวรับ 'error' = Node โยน error ของการเชื่อมต่อที่ว่างออกมาเป็น uncaught แล้วโปรเซสล่ม
      expect(pool.listenerCount('error')).toBeGreaterThan(0);
      const pid = (await pool.query('select pg_backend_pid() pid')).rows[0].pid;
      await admin.query('select pg_terminate_backend($1)', [pid]);
      for (let i = 0; i < 100 && pool.totalCount > 0; i++) await new Promise((r) => setTimeout(r, 20)); // pool ทิ้งการเชื่อมต่อที่เสีย
      const again = (await pool.query('select pg_backend_pid() pid, 1 as ok')).rows[0];
      expect(again.ok).toBe(1);
      expect(again.pid).not.toBe(pid);
    } finally {
      await pool.end();
    }
  });
});
