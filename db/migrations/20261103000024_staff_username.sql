-- migrate:up
-- ครู/ผู้ดูแลเข้าระบบด้วยชื่อผู้ใช้แทนอีเมล (ใช้คอลัมน์ email เดิมเก็บชื่อผู้ใช้)
-- บัญชีเดิม: ตัดส่วนหลัง @ ออก ถ้าไม่ชนกับผู้ใช้อื่น
update acc.users u set email = lower(split_part(u.email, '@', 1))
 where u.email like '%@%' and length(split_part(u.email, '@', 1)) >= 3
   and not exists (select 1 from acc.users x where x.id <> u.id
                    and lower(split_part(x.email, '@', 1)) = lower(split_part(u.email, '@', 1)));

create or replace function acc.admin_create_staff(p_email text, p_name text, p_role text, p_hash text) returns uuid
language plpgsql security definer set search_path = acc, pg_temp as $$
declare v_school uuid := app.require_admin(); v_id uuid;
begin
  if p_role not in ('teacher','admin') then raise exception 'บทบาทไม่ถูกต้อง' using errcode = '22023'; end if;
  if exists (select 1 from acc.users where lower(email) = lower(p_email)) then
    raise exception 'ชื่อผู้ใช้ % มีผู้ใช้แล้ว', p_email using errcode = 'ACC08';
  end if;
  insert into acc.users (school_id, role, email, display_name) values (v_school, p_role, lower(p_email), p_name)
  returning id into v_id;
  insert into acc.credentials (user_id, password_hash, must_change) values (v_id, p_hash, true);
  return v_id;
end $$;

-- migrate:down
-- ย้อนการตัดอีเมลไม่ได้ (ไม่รู้โดเมนเดิม) ฟังก์ชันยังใช้ได้กับทั้งสองแบบ
