-- migrate:up
-- เข้าระบบง่ายขึ้น: รหัสนักเรียนไม่สนตัวพิมพ์เล็ก/ใหญ่ (ซ้ำกันแบบไม่สนตัวพิมพ์ = ถือว่าไม่พบ เหมือนเดิม)
create or replace function app.auth_find(p_kind text, p_identifier text)
returns table (user_id uuid, role text, password_hash text, must_change boolean)
language sql stable security definer set search_path = acc, pg_temp as $$
  select u.id, u.role, c.password_hash, c.must_change
    from acc.users u join acc.credentials c on c.user_id = u.id
   where u.active
     and case p_kind
           when 'student' then u.role = 'student' and lower(u.student_code) = lower(p_identifier)
             and (select count(*) from acc.users x where x.role = 'student' and lower(x.student_code) = lower(p_identifier)) = 1
           when 'staff' then u.role <> 'student' and lower(u.email) = lower(p_identifier)
           else false
         end
$$;

-- migrate:down
create or replace function app.auth_find(p_kind text, p_identifier text)
returns table (user_id uuid, role text, password_hash text, must_change boolean)
language sql stable security definer set search_path = acc, pg_temp as $$
  select u.id, u.role, c.password_hash, c.must_change
    from acc.users u join acc.credentials c on c.user_id = u.id
   where u.active
     and case p_kind
           when 'student' then u.role = 'student' and u.student_code = p_identifier
             and (select count(*) from acc.users x where x.role = 'student' and x.student_code = p_identifier) = 1
           when 'staff' then u.role <> 'student' and lower(u.email) = lower(p_identifier)
           else false
         end
$$;
