-- migrate:up
-- 20261110000100 สร้าง acc.guard_locked_company ใหม่ด้วย create or replace หลัง 20261104000029 (ล็อก search_path ทุกฟังก์ชัน)
-- ค่า search_path ที่ 029 ตั้งไว้จึงหาย ตั้งคืนให้เหมือนฟังก์ชันอื่น (Supabase lint 0011)
alter function acc.guard_locked_company() set search_path = acc, app, public, pg_temp;

-- migrate:down
alter function acc.guard_locked_company() reset search_path;
