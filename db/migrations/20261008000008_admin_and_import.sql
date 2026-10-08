-- migrate:up
-- หน้าผู้ดูแล (ครู/ห้อง) + นำเข้านักเรียนจาก CSV
-- ทุกการเขียนผ่านฟังก์ชัน security definer ที่ตรวจบทบาทและโรงเรียนเอง

-- แก้: classrooms_admin เดิมไม่กรองโรงเรียน
drop policy classrooms_admin on acc.classrooms;
create policy classrooms_admin on acc.classrooms for select to app_rw, app_ro
  using (app.user_role() = 'admin' and school_id = app.current_school_id());

create function app.classroom_in_my_school(p_classroom uuid) returns boolean
language sql stable security definer set search_path = acc, pg_temp as $$
  select exists (select 1 from acc.classrooms where id = p_classroom and school_id = app.current_school_id())
$$;
create policy enrollments_admin on acc.enrollments for select to app_rw, app_ro
  using (app.user_role() = 'admin' and app.classroom_in_my_school(classroom_id));

-- แก้: audit_admin เดิมให้ผู้ดูแลเห็นแถวที่ไม่มี company_id ของทุกโรงเรียน
create function app.user_in_my_school(p_user uuid) returns boolean
language sql stable security definer set search_path = acc, pg_temp as $$
  select exists (select 1 from acc.users where id = p_user and school_id = app.current_school_id())
$$;
drop policy audit_admin on acc.audit_log;
create policy audit_admin on acc.audit_log for select to app_rw, app_ro
  using (app.user_role() = 'admin'
         and case when company_id is not null then app.company_in_my_school(company_id)
                  else app.user_in_my_school(user_id) end);

create function app.require_admin() returns uuid
language plpgsql stable security definer set search_path = acc, pg_temp as $$
begin
  if app.user_role() is distinct from 'admin' then
    raise exception 'ต้องเป็นผู้ดูแลระบบ' using errcode = '42501';
  end if;
  return app.current_school_id();
end $$;

create function app.audit_action(p_op text, p_pk text, p_detail jsonb) returns void
language sql security definer set search_path = acc, pg_temp as $$
  insert into acc.audit_log (user_id, table_name, op, row_pk, client, new_row)
  values (app.current_user_id(), 'users', p_op, p_pk, nullif(current_setting('app.client_info', true), ''), p_detail)
$$;

-- ผู้ดูแล: สร้างบัญชีครู/ผู้ดูแล (API แฮชรหัสชั่วคราวมาให้)
create function acc.admin_create_staff(p_email text, p_name text, p_role text, p_hash text) returns uuid
language plpgsql security definer set search_path = acc, pg_temp as $$
declare v_school uuid := app.require_admin(); v_id uuid;
begin
  if p_role not in ('teacher','admin') then raise exception 'บทบาทไม่ถูกต้อง' using errcode = '22023'; end if;
  if exists (select 1 from acc.users where lower(email) = lower(p_email)) then
    raise exception 'อีเมล % มีผู้ใช้แล้ว', p_email using errcode = 'ACC08';
  end if;
  insert into acc.users (school_id, role, email, display_name) values (v_school, p_role, lower(p_email), p_name)
  returning id into v_id;
  insert into acc.credentials (user_id, password_hash, must_change) values (v_id, p_hash, true);
  return v_id;
end $$;

-- ผู้ดูแล: รีเซ็ตรหัสผู้ใช้ในโรงเรียน (ครูหรือนักเรียน) และเตะทุกอุปกรณ์
create function acc.admin_reset_password(p_user uuid, p_hash text) returns void
language plpgsql security definer set search_path = acc, pg_temp as $$
declare v_school uuid := app.require_admin();
begin
  if not exists (select 1 from acc.users where id = p_user and school_id = v_school) then
    raise exception 'ไม่พบผู้ใช้ในโรงเรียนนี้' using errcode = 'ACC04';
  end if;
  insert into acc.credentials (user_id, password_hash, must_change) values (p_user, p_hash, true)
  on conflict (user_id) do update set password_hash = excluded.password_hash, must_change = true, password_changed_at = now();
  update acc.sessions set revoked_at = now(), revoked_by = app.current_user_id(), revoked_reason = 'password_reset'
   where user_id = p_user and revoked_at is null;
  -- ปลดล็อกด้วย: บันทึกความสำเร็จแทนผู้ใช้ (ผู้ดูแลยืนยันตัวตนแล้ว)
  insert into acc.login_attempts (kind, identifier, ip, user_id, success)
  select case when role = 'student' then 'student' else 'staff' end,
         coalesce(student_code, lower(email)), 'admin-reset', id, true
    from acc.users where id = p_user;
  perform app.audit_action('PASSWORD_RESET', p_user::text, null);
end $$;

-- ผู้ดูแล: ปิด/เปิดบัญชี (ปิดแล้วล็อกอินไม่ได้และถูกเตะทันที) ห้ามปิดตัวเอง
create function acc.admin_set_active(p_user uuid, p_active boolean) returns void
language plpgsql security definer set search_path = acc, pg_temp as $$
declare v_school uuid := app.require_admin();
begin
  if p_user = app.current_user_id() then
    raise exception 'ปิดบัญชีของตัวเองไม่ได้' using errcode = 'ACC09';
  end if;
  update acc.users set active = p_active where id = p_user and school_id = v_school;
  if not found then raise exception 'ไม่พบผู้ใช้ในโรงเรียนนี้' using errcode = 'ACC04'; end if;
  if not p_active then
    update acc.sessions set revoked_at = now(), revoked_by = app.current_user_id(), revoked_reason = 'deactivated'
     where user_id = p_user and revoked_at is null;
  end if;
end $$;

create function app.require_teacher_in_school(p_teacher uuid, p_school uuid) returns void
language plpgsql stable security definer set search_path = acc, pg_temp as $$
begin
  if not exists (select 1 from acc.users where id = p_teacher and school_id = p_school and role = 'teacher' and active) then
    raise exception 'ไม่พบครูคนนี้ในโรงเรียน' using errcode = 'ACC04';
  end if;
end $$;

create function acc.admin_create_classroom(p_name text, p_teacher uuid) returns uuid
language plpgsql security definer set search_path = acc, pg_temp as $$
declare v_school uuid := app.require_admin(); v_id uuid;
begin
  perform app.require_teacher_in_school(p_teacher, v_school);
  insert into acc.classrooms (school_id, teacher_id, name) values (v_school, p_teacher, p_name) returning id into v_id;
  return v_id;
end $$;

create function acc.admin_assign_teacher(p_classroom uuid, p_teacher uuid) returns void
language plpgsql security definer set search_path = acc, pg_temp as $$
declare v_school uuid := app.require_admin();
begin
  perform app.require_teacher_in_school(p_teacher, v_school);
  update acc.classrooms set teacher_id = p_teacher where id = p_classroom and school_id = v_school;
  if not found then raise exception 'ไม่พบห้องนี้' using errcode = 'ACC04'; end if;
end $$;

-- นำเข้านักเรียน (ครูประจำห้องหรือผู้ดูแลโรงเรียน)
-- p_rows: [{"code":"65012","name":"...","hash":"$argon2id$..."|null}]
-- นักเรียนใหม่ต้องมี hash; มีอยู่แล้ว = ลงทะเบียนเข้าห้อง ไม่เปลี่ยนชื่อ/รหัสผ่าน
create function acc.import_students(p_classroom uuid, p_rows jsonb)
returns table (code text, user_id uuid, status text)
language plpgsql security definer set search_path = acc, pg_temp as $$
declare
  v_school uuid;
  r jsonb;
  v_user acc.users;
  v_created int := 0; v_enrolled int := 0;
begin
  select school_id into v_school from acc.classrooms where id = p_classroom;
  if v_school is null or not (app.teaches(p_classroom)
       or (app.user_role() = 'admin' and v_school = app.current_school_id())) then
    raise exception 'ไม่มีสิทธิ์นำเข้าห้องนี้' using errcode = '42501';
  end if;
  if jsonb_array_length(p_rows) > 1000 then
    raise exception 'นำเข้าได้ครั้งละไม่เกิน 1,000 คน' using errcode = '22023';
  end if;

  for r in select * from jsonb_array_elements(p_rows) loop
    code := r->>'code';
    select * into v_user from acc.users u where u.school_id = v_school and u.student_code = code;
    if found then
      if v_user.role <> 'student' then
        raise exception 'รหัส % เป็นบัญชีที่ไม่ใช่นักเรียน', code using errcode = 'ACC08';
      end if;
      insert into acc.enrollments (classroom_id, user_id) values (p_classroom, v_user.id) on conflict do nothing;
      user_id := v_user.id;
      status := case when found then 'enrolled' else 'already' end;
      if status = 'enrolled' then v_enrolled := v_enrolled + 1; end if;
    else
      if coalesce(r->>'hash', '') = '' then
        status := 'needs_password'; user_id := null;   -- เกิดชนกันระหว่างตรวจกับนำเข้า: API ออกรหัสแล้วส่งซ้ำ
        return next; continue;
      end if;
      insert into acc.users (school_id, role, student_code, display_name)
      values (v_school, 'student', code, r->>'name') returning id into user_id;
      insert into acc.credentials (user_id, password_hash, must_change) values (user_id, r->>'hash', true);
      insert into acc.enrollments (classroom_id, user_id) values (p_classroom, user_id);
      status := 'created'; v_created := v_created + 1;
    end if;
    return next;
  end loop;
  perform app.audit_action('IMPORT_STUDENTS', p_classroom::text,
    jsonb_build_object('created', v_created, 'enrolled', v_enrolled, 'rows', jsonb_array_length(p_rows)));
end $$;

-- รหัสที่มีอยู่แล้วในโรงเรียนของห้องนี้ (ใช้ตัดสินว่าต้องออกรหัสชั่วคราวให้ใคร)
create function acc.existing_student_codes(p_classroom uuid, p_codes text[]) returns setof text
language plpgsql stable security definer set search_path = acc, pg_temp as $$
declare v_school uuid;
begin
  select school_id into v_school from acc.classrooms where id = p_classroom;
  if v_school is null or not (app.teaches(p_classroom)
       or (app.user_role() = 'admin' and v_school = app.current_school_id())) then
    raise exception 'ไม่มีสิทธิ์นำเข้าห้องนี้' using errcode = '42501';
  end if;
  return query select u.student_code from acc.users u where u.school_id = v_school and u.student_code = any(p_codes);
end $$;

revoke all on function app.user_in_my_school(uuid), app.classroom_in_my_school(uuid), app.require_admin(), app.audit_action(text,text,jsonb),
  acc.admin_create_staff(text,text,text,text), acc.admin_reset_password(uuid,text), acc.admin_set_active(uuid,boolean),
  app.require_teacher_in_school(uuid,uuid), acc.admin_create_classroom(text,uuid), acc.admin_assign_teacher(uuid,uuid),
  acc.import_students(uuid,jsonb), acc.existing_student_codes(uuid,text[]) from public;
grant execute on function app.classroom_in_my_school(uuid), acc.admin_create_staff(text,text,text,text),
  acc.admin_reset_password(uuid,text), acc.admin_set_active(uuid,boolean), acc.admin_create_classroom(text,uuid),
  acc.admin_assign_teacher(uuid,uuid), acc.import_students(uuid,jsonb), acc.existing_student_codes(uuid,text[]) to app_rw;
grant execute on function app.classroom_in_my_school(uuid), app.user_in_my_school(uuid) to app_ro;
grant execute on function app.user_in_my_school(uuid) to app_rw;

-- migrate:down
drop function acc.existing_student_codes(uuid,text[]), acc.import_students(uuid,jsonb), acc.admin_assign_teacher(uuid,uuid),
  acc.admin_create_classroom(text,uuid), app.require_teacher_in_school(uuid,uuid), acc.admin_set_active(uuid,boolean),
  acc.admin_reset_password(uuid,text), acc.admin_create_staff(text,text,text,text), app.audit_action(text,text,jsonb),
  app.require_admin();
drop policy enrollments_admin on acc.enrollments;
drop function app.classroom_in_my_school(uuid);
drop policy audit_admin on acc.audit_log;
create policy audit_admin on acc.audit_log for select to app_rw, app_ro
  using (app.user_role() = 'admin' and (company_id is null or app.company_in_my_school(company_id)));
drop function app.user_in_my_school(uuid);
drop policy classrooms_admin on acc.classrooms;
create policy classrooms_admin on acc.classrooms for select to app_rw, app_ro using (app.user_role() = 'admin');
