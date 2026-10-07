-- migrate:up
-- ระบบล็อกอินเฟส 1: รหัสผ่าน (Argon2id แฮชที่ API), เซสชัน, การพยายามล็อกอิน, แจ้งเตือนครู
-- ตารางเหล่านี้ไม่มี grant ให้บทบาทแอป เข้าถึงผ่านฟังก์ชัน security definer เท่านั้น

create table acc.credentials (
  user_id             uuid primary key references acc.users(id),
  password_hash       text not null check (password_hash like '$argon2id$%'),
  must_change         boolean not null default true,
  password_changed_at timestamptz not null default now()
);

create table acc.sessions (
  token_hash   text primary key,               -- sha256 ของ token ใน cookie (ไม่เก็บ token จริง)
  user_id      uuid not null references acc.users(id),
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at   timestamptz not null,           -- เพดานอายุสูงสุด
  idle_seconds int not null,
  client       text,
  revoked_at   timestamptz,
  revoked_by   uuid references acc.users(id),
  revoked_reason text
);
create index sessions_user on acc.sessions (user_id) where revoked_at is null;

-- นับความล้มเหลวตาม "สิ่งที่พิมพ์" (รหัสนักเรียน/อีเมล) ไม่ใช่ตามผู้ใช้
-- บัญชีที่ไม่มีอยู่จริงจึงตอบเหมือนกันทุกอย่าง เดาไม่ได้ว่ารหัสไหนมีอยู่
create table acc.login_attempts (
  id         bigint generated always as identity primary key,
  at         timestamptz not null default now(),
  kind       text not null check (kind in ('student','staff')),
  identifier text not null,
  ip         text not null,
  user_id    uuid references acc.users(id),
  success    boolean not null
);
create index login_attempts_ident on acc.login_attempts (kind, identifier, at desc);
create index login_attempts_ip on acc.login_attempts (ip, at desc) where not success;

create table acc.teacher_alerts (
  id         bigint generated always as identity primary key,
  teacher_id uuid not null references acc.users(id),
  student_id uuid not null references acc.users(id),
  kind       text not null check (kind in ('locked')),
  at         timestamptz not null default now(),
  read_at    timestamptz
);
create index teacher_alerts_teacher on acc.teacher_alerts (teacher_id, at desc);

alter table acc.credentials    enable row level security;
alter table acc.sessions       enable row level security;
alter table acc.login_attempts enable row level security;
alter table acc.teacher_alerts enable row level security;
grant select on acc.teacher_alerts to app_rw;
create policy alerts_own on acc.teacher_alerts for select to app_rw using (teacher_id = app.current_user_id());

-- login_attempts ไม่ append-only แบบ audit_log: ต้องลบตามอายุเก็บข้อมูล (PDPA) ได้ แอปไม่มีสิทธิ์อยู่แล้ว

-- ค้นผู้ใช้จากสิ่งที่พิมพ์ (ก่อนล็อกอิน จึงยังไม่มี app.user_id)
-- นักเรียน: รหัสนักเรียน (ถ้าซ้ำข้ามโรงเรียนจะถือว่าไม่พบ จนกว่าจะมีหน้าเลือกโรงเรียน)
create function app.auth_find(p_kind text, p_identifier text)
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

-- สถานะล็อก: ล้มเหลวติดกัน (นับจากครั้งที่สำเร็จล่าสุด) ภายในช่วงเวลา
create function app.auth_lock_state(
  p_kind text, p_identifier text, p_ip text,
  p_max int, p_window interval, p_ip_max int
) returns table (failures int, locked_until timestamptz, ip_failures int)
language sql stable security definer set search_path = acc, pg_temp as $$
  with recent as (
    select at, success from acc.login_attempts
     where kind = p_kind and identifier = p_identifier and at > now() - p_window
  ), since_ok as (
    select at from recent
     where not success and at > coalesce((select max(at) from recent where success), '-infinity')
  )
  select (select count(*)::int from since_ok),
         case when (select count(*) from since_ok) >= p_max
              then (select max(at) from since_ok) + p_window end,
         (select count(*)::int from acc.login_attempts
           where ip = p_ip and not success and at > now() - p_window)
$$;

-- บันทึกผลการล็อกอิน; ถ้าครั้งนี้ทำให้บัญชีนักเรียนถูกล็อก แจ้งครูทุกห้องที่สอน
create function app.auth_record(
  p_kind text, p_identifier text, p_ip text, p_user uuid, p_success boolean, p_max int, p_window interval
) returns void
language plpgsql security definer set search_path = acc, pg_temp as $$
declare v_fail int;
begin
  insert into acc.login_attempts (kind, identifier, ip, user_id, success)
  values (p_kind, p_identifier, p_ip, p_user, p_success);
  if p_success or p_user is null then return; end if;
  select failures into v_fail from app.auth_lock_state(p_kind, p_identifier, p_ip, p_max, p_window, 0);
  if v_fail = p_max then
    insert into acc.teacher_alerts (teacher_id, student_id, kind)
    select distinct r.teacher_id, p_user, 'locked'
      from acc.enrollments e join acc.classrooms r on r.id = e.classroom_id
     where e.user_id = p_user;
  end if;
end $$;

create function app.session_create(
  p_user uuid, p_token_hash text, p_client text, p_idle_seconds int, p_max_age interval
) returns void
language sql security definer set search_path = acc, pg_temp as $$
  insert into acc.sessions (token_hash, user_id, client, idle_seconds, expires_at)
  values (p_token_hash, p_user, p_client, p_idle_seconds, now() + p_max_age)
$$;

-- ตรวจเซสชันทุกคำขอ: ยังไม่ถูกเพิกถอน ไม่เกินเวลาว่าง ไม่เกินอายุสูงสุด ผู้ใช้ยัง active
-- อัปเดต last_seen ไม่เกินนาทีละครั้ง (ลดการเขียนตอนคน 500 คนใช้พร้อมกัน)
create function app.session_get(p_token_hash text)
returns table (user_id uuid, role text, must_change boolean, display_name text, student_code text)
language plpgsql security definer set search_path = acc, pg_temp as $$
declare s acc.sessions;
begin
  select * into s from acc.sessions where token_hash = p_token_hash;
  if not found or s.revoked_at is not null or s.expires_at <= now()
     or s.last_seen_at + make_interval(secs => s.idle_seconds) <= now() then
    return;
  end if;
  if s.last_seen_at < now() - interval '1 minute' then
    update acc.sessions set last_seen_at = now() where token_hash = p_token_hash;
  end if;
  return query
    select u.id, u.role, c.must_change, u.display_name, u.student_code
      from acc.users u join acc.credentials c on c.user_id = u.id
     where u.id = s.user_id and u.active;
end $$;

create function app.session_revoke(p_token_hash text, p_reason text) returns void
language sql security definer set search_path = acc, pg_temp as $$
  update acc.sessions set revoked_at = now(), revoked_reason = p_reason
   where token_hash = p_token_hash and revoked_at is null
$$;

-- เปลี่ยนรหัสของตัวเอง; เพิกถอนเซสชันอื่นทั้งหมด (คงเซสชันปัจจุบัน)
create function app.change_own_password(p_hash text, p_keep_token_hash text) returns void
language plpgsql security definer set search_path = acc, pg_temp as $$
declare v_user uuid := app.current_user_id();
begin
  if v_user is null then raise exception 'ต้องเข้าใช้งานก่อน' using errcode = '42501'; end if;
  update acc.credentials set password_hash = p_hash, must_change = false, password_changed_at = now()
   where user_id = v_user;
  update acc.sessions set revoked_at = now(), revoked_reason = 'password_changed'
   where user_id = v_user and revoked_at is null and token_hash <> p_keep_token_hash;
  insert into acc.audit_log (user_id, table_name, op, row_pk, client)
  values (v_user, 'credentials', 'PASSWORD_CHANGED', v_user::text, nullif(current_setting('app.client_info', true), ''));
end $$;

create function app.my_password_hash() returns text
language sql stable security definer set search_path = acc, pg_temp as $$
  select password_hash from acc.credentials where user_id = app.current_user_id()
$$;

create function app.is_teacher_of(p_student uuid) returns boolean
language sql stable security definer set search_path = acc, pg_temp as $$
  select exists (
    select 1 from acc.enrollments e join acc.classrooms r on r.id = e.classroom_id
      join acc.users t on t.id = r.teacher_id and t.active
     where e.user_id = p_student and r.teacher_id = app.current_user_id())
$$;

-- ครูรีเซ็ตรหัสนักเรียนในห้องตัวเอง: รหัสชั่วคราวต้องเปลี่ยนเมื่อเข้าครั้งแรก, เตะทุกอุปกรณ์ออก, ปลดล็อก
create function acc.reset_student_password(p_student uuid, p_hash text) returns void
language plpgsql security definer set search_path = acc, pg_temp as $$
begin
  if not app.is_teacher_of(p_student) then
    raise exception 'ไม่ใช่นักเรียนในห้องของครู' using errcode = '42501';
  end if;
  insert into acc.credentials (user_id, password_hash, must_change) values (p_student, p_hash, true)
  on conflict (user_id) do update set password_hash = excluded.password_hash, must_change = true,
    password_changed_at = now();
  update acc.sessions set revoked_at = now(), revoked_by = app.current_user_id(), revoked_reason = 'password_reset'
   where user_id = p_student and revoked_at is null;
  -- บันทึกความสำเร็จหลอกเพื่อรีเซ็ตตัวนับล็อก (ครูยืนยันตัวตนนักเรียนแล้ว)
  insert into acc.login_attempts (kind, identifier, ip, user_id, success)
  select 'student', student_code, 'teacher-reset', id, true from acc.users where id = p_student;
  insert into acc.audit_log (user_id, table_name, op, row_pk, client)
  values (app.current_user_id(), 'credentials', 'PASSWORD_RESET', p_student::text, nullif(current_setting('app.client_info', true), ''));
end $$;

create function acc.revoke_student_sessions(p_student uuid) returns int
language plpgsql security definer set search_path = acc, pg_temp as $$
declare n int;
begin
  if not app.is_teacher_of(p_student) then
    raise exception 'ไม่ใช่นักเรียนในห้องของครู' using errcode = '42501';
  end if;
  update acc.sessions set revoked_at = now(), revoked_by = app.current_user_id(), revoked_reason = 'kicked'
   where user_id = p_student and revoked_at is null;
  get diagnostics n = row_count;
  return n;
end $$;

revoke all on function app.auth_find(text,text), app.auth_lock_state(text,text,text,int,interval,int),
  app.auth_record(text,text,text,uuid,boolean,int,interval), app.session_create(uuid,text,text,int,interval),
  app.session_get(text), app.session_revoke(text,text), app.change_own_password(text,text),
  app.my_password_hash(), app.is_teacher_of(uuid), acc.reset_student_password(uuid,text), acc.revoke_student_sessions(uuid) from public;
grant execute on function app.auth_find(text,text), app.auth_lock_state(text,text,text,int,interval,int),
  app.auth_record(text,text,text,uuid,boolean,int,interval), app.session_create(uuid,text,text,int,interval),
  app.session_get(text), app.session_revoke(text,text), app.change_own_password(text,text),
  app.my_password_hash(), app.is_teacher_of(uuid), acc.reset_student_password(uuid,text), acc.revoke_student_sessions(uuid) to app_rw;

-- migrate:down
drop function acc.revoke_student_sessions(uuid), acc.reset_student_password(uuid,text), app.is_teacher_of(uuid), app.my_password_hash(),
  app.change_own_password(text,text), app.session_revoke(text,text), app.session_get(text),
  app.session_create(uuid,text,text,int,interval), app.auth_record(text,text,text,uuid,boolean,int,interval),
  app.auth_lock_state(text,text,text,int,interval,int), app.auth_find(text,text);
drop table acc.teacher_alerts, acc.login_attempts, acc.sessions, acc.credentials;
