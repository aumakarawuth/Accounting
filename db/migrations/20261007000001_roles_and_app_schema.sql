-- migrate:up
-- บทบาทฐานข้อมูล (ตั้งรหัส/สิทธิ์ login ที่ชั้น infra ไม่ใส่ในมิเกรชัน)
do $$
begin
  if not exists (select from pg_roles where rolname = 'app_rw')   then create role app_rw nologin;   end if;
  if not exists (select from pg_roles where rolname = 'app_ro')   then create role app_ro nologin;   end if;
  if not exists (select from pg_roles where rolname = 'migrator') then create role migrator nologin; end if;
end $$;

create schema if not exists app;   -- ชั้นเชื่อมต่อกับระบบ auth (adapter)
create schema if not exists acc;   -- ข้อมูลบัญชีทั้งหมด

revoke all on schema public from public;
revoke all on schema app from public;
revoke all on schema acc from public;
grant usage on schema app to app_rw, app_ro;
grant usage on schema acc to app_rw, app_ro;

-- จุดเดียวที่ RLS ถามว่า "ผู้ใช้คือใคร"
-- Supabase: adapter ตั้ง app.user_id จาก JWT sub ต่อทรานแซกชัน
-- Self-host: API ตั้งค่าเดียวกันหลังตรวจเซสชัน  (ห้ามเรียก auth.uid() ตรง ๆ)
create function app.current_user_id() returns uuid
language sql stable as $$
  select nullif(current_setting('app.user_id', true), '')::uuid
$$;
grant execute on function app.current_user_id() to app_rw, app_ro;

-- migrate:down
drop function app.current_user_id();
drop schema app;
