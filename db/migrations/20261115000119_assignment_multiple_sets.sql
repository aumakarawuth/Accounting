-- migrate:up
-- งานเดียวหลายชุดโจทย์ (ชุด ก/ข/ค/ง) แจกนักเรียนคนละชุด กันลอกในห้อง (เจ้าของโปรเจกต์เลือก 15 พ.ย. 2569, docs/assumptions.md ข้อ 52)
-- · assignments.set_id = ชุดที่ 1 (เหมือนเดิม) ชุดเพิ่มอยู่ใน assignment_sets
-- · บริษัทจำชุดที่ได้ใน companies.exercise_set_id (บริษัทเดิมเป็น null = ชุดของงาน จึงไม่ต้องย้ายข้อมูล)
-- · แจก: rotate = เวียนตามรหัสนักเรียน (คนรหัสติดกันได้คนละชุด) · random = สุ่ม
-- · ตรวจ/แสดงโจทย์/คะแนนเต็ม ใช้ชุดของบริษัทนั้น
create table acc.assignment_sets (
  assignment_id uuid not null references acc.assignments(id),
  set_no        smallint not null check (set_no between 1 and 4),
  set_id        uuid not null references acc.exercise_sets(id),
  primary key (assignment_id, set_no),
  unique (assignment_id, set_id)
);
create index assignment_sets_set on acc.assignment_sets (set_id);
alter table acc.assignment_sets enable row level security;
grant select on acc.assignment_sets to app_rw, app_ro;
create policy assignment_sets_manage on acc.assignment_sets for select to app_rw, app_ro using (app.can_manage_assignment(assignment_id));
insert into acc.assignment_sets (assignment_id, set_no, set_id) select id, 1, set_id from acc.assignments where set_id is not null;

alter table acc.assignments add column distribution text not null default 'rotate' check (distribution in ('rotate', 'random'));
alter table acc.companies add column exercise_set_id uuid references acc.exercise_sets(id);

-- ชุดโจทย์ของบริษัท (null = ไม่ใช่บริษัทของงานที่มีโจทย์)
create function app.company_set(p_company uuid) returns uuid
language sql stable security definer set search_path = acc, pg_temp as $$
  select coalesce(c.exercise_set_id, a.set_id) from acc.companies c join acc.assignments a on a.id = c.assignment_id where c.id = p_company
$$;
revoke all on function app.company_set(uuid) from public;

create or replace function app.grade_company(p_company uuid) returns jsonb
language sql stable security definer set search_path = acc, pg_temp as $$
  select app.grade_match(app.exercise_item_keys(coalesce(c.exercise_set_id, a.set_id)), app.company_entry_keys(c.id), a.check_date)
    from acc.companies c join acc.assignments a on a.id = c.assignment_id
   where c.id = p_company and coalesce(c.exercise_set_id, a.set_id) is not null
$$;

create or replace function acc.create_assignment(p_set uuid, p_classroom uuid, p_opts jsonb) returns uuid
language plpgsql security definer set search_path = acc, pg_temp as $$
declare
  v_user acc.users; s acc.exercise_sets; v_id uuid;
  v_mode text := coalesce(p_opts->>'mode', 'practice');
  v_name text; v_reveal text; v_feedback text := coalesce(p_opts->>'feedback', 'items');
  v_extra uuid[]; v_dist text := coalesce(nullif(p_opts->>'distribution', ''), 'rotate'); x uuid; n int := 1;
begin
  select * into v_user from acc.users where id = app.current_user_id() and active;
  if not found or v_user.role <> 'teacher' then raise exception 'เฉพาะครูมอบหมายงานได้' using errcode = '42501'; end if;
  if v_mode not in ('practice', 'submit', 'exam', 'demo') then raise exception 'โหมดไม่ถูกต้อง' using errcode = '22023'; end if;
  if p_set is not null then
    select * into s from acc.exercise_sets where id = p_set and owner_id = v_user.id;
    if not found then raise exception 'ไม่พบชุดโจทย์นี้' using errcode = 'ACC04'; end if;
  elsif v_mode <> 'demo' then
    raise exception 'ต้องเลือกชุดโจทย์' using errcode = 'ACC19';
  end if;
  if v_mode = 'demo' then
    if p_classroom is not null then raise exception 'บริษัทสาธิตเป็นของครู ไม่ผูกกับห้อง' using errcode = '22023'; end if;
  elsif p_classroom is null or not app.teaches(p_classroom) then
    raise exception 'ไม่มีสิทธิ์มอบหมายงานในห้องนี้' using errcode = '42501';
  end if;
  if v_dist not in ('rotate', 'random') then raise exception 'วิธีแจกชุดโจทย์ต้องเป็นเวียนตามรหัสหรือสุ่ม' using errcode = '22023'; end if;
  begin
    select array_agg(v::uuid order by o) into v_extra from jsonb_array_elements_text(coalesce(p_opts->'extra_sets', '[]')) with ordinality t(v, o);
  exception when others then raise exception 'ชุดโจทย์เพิ่มไม่ถูกต้อง' using errcode = '22023';
  end;
  if coalesce(array_length(v_extra, 1), 0) > 0 then
    if v_mode = 'demo' then raise exception 'บริษัทสาธิตใช้ชุดโจทย์เดียว' using errcode = 'ACC19'; end if;
    if array_length(v_extra, 1) > 3 then raise exception 'ใช้ได้ไม่เกิน 4 ชุดต่องาน' using errcode = 'ACC19'; end if;
    if p_set = any (v_extra) or (select count(distinct e) from unnest(v_extra) e) <> array_length(v_extra, 1) then
      raise exception 'เลือกชุดโจทย์ซ้ำกัน' using errcode = 'ACC19';
    end if;
    if exists (select 1 from unnest(v_extra) e where not exists (select 1 from acc.exercise_sets x where x.id = e and x.owner_id = v_user.id)) then
      raise exception 'ไม่พบชุดโจทย์บางชุด' using errcode = 'ACC04';
    end if;
    if exists (select 1 from unnest(v_extra) e where not exists (select 1 from acc.exercise_items i where i.set_id = e)) then
      raise exception 'ชุดโจทย์ที่เลือกเพิ่มยังไม่มีข้อ' using errcode = 'ACC19';
    end if;
  end if;

  v_name := trim(coalesce(nullif(trim(p_opts->>'company_name'), ''), s.company_name, ''));
  if v_name = '' then raise exception 'ต้องมีชื่อบริษัท' using errcode = 'ACC19'; end if;
  if p_classroom is not null and exists (select 1 from acc.companies where classroom_id = p_classroom and name = v_name) then
    raise exception 'ห้องนี้มีบริษัทชื่อ "%" อยู่แล้ว ตั้งชื่อบริษัทของงานนี้ใหม่', v_name using errcode = 'ACC19';
  end if;
  v_reveal := case when v_mode = 'exam' then 'after_release' else coalesce(p_opts->>'reveal', 'anytime') end;
  if v_mode = 'exam' and nullif(p_opts->>'duration_minutes', '') is null then
    raise exception 'การสอบต้องกำหนดเวลาสอบ (นาที)' using errcode = 'ACC19';
  end if;
  if v_reveal = 'after_submit' and v_mode not in ('submit', 'exam') then
    raise exception 'โหมดฝึกหัดไม่มีการส่งตรวจ เลือกแสดงผลทันทีหรือเมื่อครูเปิดเฉลย' using errcode = 'ACC19';
  end if;

  insert into acc.assignments (school_id, owner_id, set_id, classroom_id, mode, title, company_name, feedback, reveal,
                               check_date, opens_at, closes_at, duration_minutes, distribution)
  values (v_user.school_id, v_user.id, p_set, p_classroom, v_mode, coalesce(s.title, v_name), v_name, v_feedback, v_reveal,
          coalesce((p_opts->>'check_date')::boolean, true), nullif(p_opts->>'opens_at', '')::timestamptz,
          nullif(p_opts->>'closes_at', '')::timestamptz,
          case when v_mode = 'exam' then (p_opts->>'duration_minutes')::int end, v_dist)
  returning id into v_id;
  if p_set is not null then
    insert into acc.assignment_sets (assignment_id, set_no, set_id) values (v_id, 1, p_set);
    foreach x in array coalesce(v_extra, '{}') loop
      n := n + 1;
      insert into acc.assignment_sets (assignment_id, set_no, set_id) values (v_id, n, x);
    end loop;
  end if;
  insert into acc.assignment_events (assignment_id, actor, action, detail, client)
  values (v_id, v_user.id, 'create', p_opts, nullif(current_setting('app.client_info', true), ''));
  perform acc.open_assignment_companies(v_id);
  return v_id;
end $$;

create or replace function acc.open_assignment_companies(p_assignment uuid) returns table (created int, existing int)
language plpgsql security definer set search_path = acc, pg_temp as $$
declare a acc.assignments; v_students int; v_sets uuid[]; n int;
begin
  select * into a from acc.assignments where id = p_assignment;
  if not found or not app.can_manage_assignment(p_assignment) then
    raise exception 'ไม่พบงานนี้' using errcode = 'ACC04';
  end if;
  select array_agg(set_id order by set_no) into v_sets from acc.assignment_sets where assignment_id = a.id;
  if v_sets is null and a.set_id is not null then v_sets := array[a.set_id]; end if;
  n := coalesce(array_length(v_sets, 1), 0);
  perform set_config('app.assignment_setup', 'on', true);

  if a.mode = 'demo' then
    v_students := 1;
    with ins as (
      insert into acc.companies (school_id, owner_id, classroom_id, name, mode, assignment_id, exercise_set_id)
      values (a.school_id, a.owner_id, null, a.company_name, 'practice', a.id, a.set_id)
      on conflict do nothing returning id
    ), coa as (
      insert into acc.chart_of_accounts (company_id, code, name, type)
      select ins.id, t.code, t.name, t.type from ins cross join acc.coa_template t returning 1
    )
    select count(*)::int into created from ins;
  else
    select count(*) into v_students
      from acc.enrollments e join acc.users u on u.id = e.user_id
     where e.classroom_id = a.classroom_id and u.role = 'student' and u.active;
    -- ลำดับเวียนนับจากนักเรียนทั้งห้องเรียงตามรหัส (คนที่เข้าห้องทีหลังก็ได้ชุดตามลำดับของตัวเอง)
    with roster as (
      select e.user_id, row_number() over (order by u.student_code, u.id) as pos
        from acc.enrollments e join acc.users u on u.id = e.user_id
       where e.classroom_id = a.classroom_id and u.role = 'student' and u.active
    ), ins as (
      insert into acc.companies (school_id, owner_id, classroom_id, name, mode, assignment_id, exercise_set_id)
      select a.school_id, r.user_id, a.classroom_id, a.company_name,
             case when a.mode in ('submit', 'exam') then 'submit' else 'practice' end, a.id,
             case when n = 0 then null
                  when a.distribution = 'random' then v_sets[1 + floor(random() * n)::int]
                  else v_sets[((r.pos - 1) % n) + 1] end
        from roster r
      on conflict do nothing
      returning id, exercise_set_id
    ), coa as (
      insert into acc.chart_of_accounts (company_id, code, name, type)
      select ins.id, t.code, t.name, t.type from ins cross join acc.coa_template t returning 1
    ), sub as (
      insert into acc.submissions (company_id, max_score)
      select ins.id, (select least(coalesce(sum(i.points), 10), 999.99) from acc.exercise_items i where i.set_id = ins.exercise_set_id)
        from ins where a.mode in ('submit', 'exam') returning 1
    )
    select count(*)::int into created from ins;
  end if;
  perform set_config('app.assignment_setup', '', true);
  existing := v_students - created;
  if created > 0 then
    insert into acc.assignment_events (assignment_id, actor, action, detail, client)
    values (a.id, app.current_user_id(), 'open_companies', jsonb_build_object('created', created),
            nullif(current_setting('app.client_info', true), ''));
  end if;
  return next;
end $$;

create or replace function acc.assignment_overview(p_assignment uuid) returns jsonb
language plpgsql stable security definer set search_path = acc, pg_temp as $$
declare a acc.assignments; v_students jsonb; v_items jsonb; v_sets jsonb;
begin
  select * into a from acc.assignments where id = p_assignment;
  if not found or not app.can_manage_assignment(p_assignment) then raise exception 'ไม่พบงานนี้' using errcode = 'ACC04'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('no', i.item_no, 'date', i.entry_date::text, 'narrative', i.narrative, 'points', i.points::text)
                            order by i.item_no), '[]')
    into v_items from acc.exercise_items i where i.set_id = a.set_id;
  -- ชุดโจทย์ของงาน (ชุด 1 = ชุดหลัก) พร้อมข้อของแต่ละชุด
  select coalesce(jsonb_agg(jsonb_build_object('no', x.set_no, 'setId', x.set_id, 'title', s.title,
           'items', (select coalesce(jsonb_agg(jsonb_build_object('no', i.item_no, 'date', i.entry_date::text, 'narrative', i.narrative,
                                                                   'points', i.points::text) order by i.item_no), '[]')
                       from acc.exercise_items i where i.set_id = x.set_id)) order by x.set_no), '[]')
    into v_sets from acc.assignment_sets x join acc.exercise_sets s on s.id = x.set_id where x.assignment_id = a.id;

  select coalesce(jsonb_agg(x order by x->>'studentCode'), '[]') into v_students from (
    select jsonb_build_object(
             'studentId', u.id, 'studentCode', u.student_code, 'name', u.display_name,
             'companyId', c.id, 'companyName', c.name, 'status', s.status,
             'teacherScore', s.score::text, 'maxScore', s.max_score::text,
             'startedAt', t.started_at, 'deadline', t.deadline, 'extraMinutes', t.extra_minutes,
             'setNo', (select x.set_no from acc.assignment_sets x where x.assignment_id = a.id and x.set_id = coalesce(c.exercise_set_id, a.set_id)),
             'lockReason', case when c.id is not null then app.company_lock_reason(c.id) end,
             'entries', (select count(*) from acc.journal_entries e where e.company_id = c.id),
             'grade', case when c.id is not null and a.set_id is not null then
                        (select jsonb_build_object('score', g->'score', 'maxScore', g->'maxScore', 'correct', g->'correct',
                                  'items', (select jsonb_agg(jsonb_build_object('no', y->'no', 'status', y->'status', 'earned', y->'earned')
                                                             order by (y->>'no')::int) from jsonb_array_elements(g->'items') y),
                                  'extra', jsonb_array_length(g->'extraEntries'))
                           from app.grade_company(c.id) g) end) as x
      from (select e.user_id from acc.enrollments e join acc.users u2 on u2.id = e.user_id and u2.role = 'student'
             where e.classroom_id = a.classroom_id
            union select c2.owner_id from acc.companies c2 where c2.assignment_id = a.id) m
      join acc.users u on u.id = m.user_id
      left join acc.companies c on c.assignment_id = a.id and c.owner_id = u.id
      left join acc.submissions s on s.company_id = c.id
      left join acc.exam_attempts t on t.company_id = c.id
  ) z;

  return jsonb_build_object(
    'assignment', jsonb_build_object('id', a.id, 'mode', a.mode, 'title', a.title, 'companyName', a.company_name, 'setId', a.set_id,
       'classroomId', a.classroom_id, 'classroom', (select name from acc.classrooms where id = a.classroom_id),
       'feedback', a.feedback, 'reveal', a.reveal, 'checkDate', a.check_date, 'opensAt', a.opens_at, 'closesAt', a.closes_at,
       'durationMinutes', a.duration_minutes, 'releasedAt', a.released_at, 'closedAt', a.closed_at, 'createdAt', a.created_at,
       'distribution', a.distribution),
    'items', v_items, 'sets', v_sets, 'students', v_students, 'now', now());
end $$;

create or replace function pg_temp.patch_function(p_fn regprocedure, p_pairs text[]) returns void language plpgsql as $$
declare v_src text := pg_get_functiondef(p_fn); i int;
begin
  for i in 1 .. array_length(p_pairs, 1) / 2 loop
    if (length(v_src) - length(replace(v_src, p_pairs[2 * i - 1], ''))) / length(p_pairs[2 * i - 1]) <> 1 then
      raise exception 'patch %: ไม่พบข้อความที่ % ครั้งเดียว', p_fn, i;
    end if;
    v_src := replace(v_src, p_pairs[2 * i - 1], p_pairs[2 * i]);
  end loop;
  execute v_src;
end $$;
-- โจทย์/เฉลย/ผลตรวจที่นักเรียนเห็น = ชุดของบริษัทนั้น (ตัวแปร a ในฟังก์ชันใช้ set_id ต่อทั้งฟังก์ชัน)
select pg_temp.patch_function('acc.assignment_view(uuid)', array[
  'select * into a from acc.assignments where id = c.assignment_id;',
  E'select * into a from acc.assignments where id = c.assignment_id;\n  a.set_id := coalesce(c.exercise_set_id, a.set_id);']);
select pg_temp.patch_function('acc.delete_exercise_set(uuid)', array[
  'if exists (select 1 from acc.assignments where set_id = p_id) then',
  'if exists (select 1 from acc.assignments where set_id = p_id) or exists (select 1 from acc.assignment_sets where set_id = p_id) then']);

-- migrate:down
create or replace function pg_temp.patch_function(p_fn regprocedure, p_pairs text[]) returns void language plpgsql as $$
declare v_src text := pg_get_functiondef(p_fn); i int;
begin
  for i in 1 .. array_length(p_pairs, 1) / 2 loop
    if (length(v_src) - length(replace(v_src, p_pairs[2 * i - 1], ''))) / length(p_pairs[2 * i - 1]) <> 1 then
      raise exception 'patch %: ไม่พบข้อความที่ % ครั้งเดียว', p_fn, i;
    end if;
    v_src := replace(v_src, p_pairs[2 * i - 1], p_pairs[2 * i]);
  end loop;
  execute v_src;
end $$;
select pg_temp.patch_function('acc.delete_exercise_set(uuid)', array[
  'if exists (select 1 from acc.assignments where set_id = p_id) or exists (select 1 from acc.assignment_sets where set_id = p_id) then',
  'if exists (select 1 from acc.assignments where set_id = p_id) then']);
select pg_temp.patch_function('acc.assignment_view(uuid)', array[
  E'select * into a from acc.assignments where id = c.assignment_id;\n  a.set_id := coalesce(c.exercise_set_id, a.set_id);',
  'select * into a from acc.assignments where id = c.assignment_id;']);
-- ฟังก์ชันที่เขียนใหม่ทั้งตัว: คืนเป็นรุ่นจาก 20261110000100_exercises.sql
create or replace function app.grade_company(p_company uuid) returns jsonb
language sql stable security definer set search_path = acc, pg_temp as $$
  select app.grade_match(app.exercise_item_keys(a.set_id), app.company_entry_keys(c.id), a.check_date)
    from acc.companies c join acc.assignments a on a.id = c.assignment_id
   where c.id = p_company and a.set_id is not null
$$;
-- create_assignment / open_assignment_companies / assignment_overview รุ่นก่อน migration นี้ (ต้องคืนก่อนลบคอลัมน์)
CREATE OR REPLACE FUNCTION acc.create_assignment(p_set uuid, p_classroom uuid, p_opts jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'acc', 'pg_temp'
AS $function$
declare
  v_user acc.users; s acc.exercise_sets; v_id uuid;
  v_mode text := coalesce(p_opts->>'mode', 'practice');
  v_name text; v_reveal text; v_feedback text := coalesce(p_opts->>'feedback', 'items');
begin
  select * into v_user from acc.users where id = app.current_user_id() and active;
  if not found or v_user.role <> 'teacher' then raise exception 'เฉพาะครูมอบหมายงานได้' using errcode = '42501'; end if;
  if v_mode not in ('practice', 'submit', 'exam', 'demo') then raise exception 'โหมดไม่ถูกต้อง' using errcode = '22023'; end if;
  if p_set is not null then
    select * into s from acc.exercise_sets where id = p_set and owner_id = v_user.id;
    if not found then raise exception 'ไม่พบชุดโจทย์นี้' using errcode = 'ACC04'; end if;
  elsif v_mode <> 'demo' then
    raise exception 'ต้องเลือกชุดโจทย์' using errcode = 'ACC19';
  end if;
  if v_mode = 'demo' then
    if p_classroom is not null then raise exception 'บริษัทสาธิตเป็นของครู ไม่ผูกกับห้อง' using errcode = '22023'; end if;
  elsif p_classroom is null or not app.teaches(p_classroom) then
    raise exception 'ไม่มีสิทธิ์มอบหมายงานในห้องนี้' using errcode = '42501';
  end if;

  v_name := trim(coalesce(nullif(trim(p_opts->>'company_name'), ''), s.company_name, ''));
  if v_name = '' then raise exception 'ต้องมีชื่อบริษัท' using errcode = 'ACC19'; end if;
  if p_classroom is not null and exists (select 1 from acc.companies where classroom_id = p_classroom and name = v_name) then
    raise exception 'ห้องนี้มีบริษัทชื่อ "%" อยู่แล้ว ตั้งชื่อบริษัทของงานนี้ใหม่', v_name using errcode = 'ACC19';
  end if;
  v_reveal := case when v_mode = 'exam' then 'after_release' else coalesce(p_opts->>'reveal', 'anytime') end;
  if v_mode = 'exam' and nullif(p_opts->>'duration_minutes', '') is null then
    raise exception 'การสอบต้องกำหนดเวลาสอบ (นาที)' using errcode = 'ACC19';
  end if;
  if v_reveal = 'after_submit' and v_mode not in ('submit', 'exam') then
    raise exception 'โหมดฝึกหัดไม่มีการส่งตรวจ เลือกแสดงผลทันทีหรือเมื่อครูเปิดเฉลย' using errcode = 'ACC19';
  end if;

  insert into acc.assignments (school_id, owner_id, set_id, classroom_id, mode, title, company_name, feedback, reveal,
                               check_date, opens_at, closes_at, duration_minutes)
  values (v_user.school_id, v_user.id, p_set, p_classroom, v_mode, coalesce(s.title, v_name), v_name, v_feedback, v_reveal,
          coalesce((p_opts->>'check_date')::boolean, true), nullif(p_opts->>'opens_at', '')::timestamptz,
          nullif(p_opts->>'closes_at', '')::timestamptz,
          case when v_mode = 'exam' then (p_opts->>'duration_minutes')::int end)
  returning id into v_id;
  insert into acc.assignment_events (assignment_id, actor, action, detail, client)
  values (v_id, v_user.id, 'create', p_opts, nullif(current_setting('app.client_info', true), ''));
  perform acc.open_assignment_companies(v_id);
  return v_id;
end $function$

;
CREATE OR REPLACE FUNCTION acc.open_assignment_companies(p_assignment uuid)
 RETURNS TABLE(created integer, existing integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'acc', 'pg_temp'
AS $function$
declare a acc.assignments; v_students int; v_max numeric;
begin
  select * into a from acc.assignments where id = p_assignment;
  if not found or not app.can_manage_assignment(p_assignment) then
    raise exception 'ไม่พบงานนี้' using errcode = 'ACC04';
  end if;
  select least(coalesce(sum(points), 10), 999.99) into v_max from acc.exercise_items where set_id = a.set_id;
  perform set_config('app.assignment_setup', 'on', true);

  if a.mode = 'demo' then
    v_students := 1;
    with ins as (
      insert into acc.companies (school_id, owner_id, classroom_id, name, mode, assignment_id)
      values (a.school_id, a.owner_id, null, a.company_name, 'practice', a.id)
      on conflict do nothing returning id
    ), coa as (
      insert into acc.chart_of_accounts (company_id, code, name, type)
      select ins.id, t.code, t.name, t.type from ins cross join acc.coa_template t returning 1
    )
    select count(*)::int into created from ins;
  else
    select count(*) into v_students
      from acc.enrollments e join acc.users u on u.id = e.user_id
     where e.classroom_id = a.classroom_id and u.role = 'student' and u.active;
    with ins as (
      insert into acc.companies (school_id, owner_id, classroom_id, name, mode, assignment_id)
      select a.school_id, e.user_id, a.classroom_id, a.company_name,
             case when a.mode in ('submit', 'exam') then 'submit' else 'practice' end, a.id
        from acc.enrollments e join acc.users u on u.id = e.user_id
       where e.classroom_id = a.classroom_id and u.role = 'student' and u.active
      on conflict do nothing
      returning id
    ), coa as (
      insert into acc.chart_of_accounts (company_id, code, name, type)
      select ins.id, t.code, t.name, t.type from ins cross join acc.coa_template t returning 1
    ), sub as (
      insert into acc.submissions (company_id, max_score)
      select id, v_max from ins where a.mode in ('submit', 'exam') returning 1
    )
    select count(*)::int into created from ins;
  end if;
  perform set_config('app.assignment_setup', '', true);
  existing := v_students - created;
  if created > 0 then
    insert into acc.assignment_events (assignment_id, actor, action, detail, client)
    values (a.id, app.current_user_id(), 'open_companies', jsonb_build_object('created', created),
            nullif(current_setting('app.client_info', true), ''));
  end if;
  return next;
end $function$

;
CREATE OR REPLACE FUNCTION acc.assignment_overview(p_assignment uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'acc', 'pg_temp'
AS $function$
declare a acc.assignments; v_students jsonb; v_items jsonb;
begin
  select * into a from acc.assignments where id = p_assignment;
  if not found or not app.can_manage_assignment(p_assignment) then raise exception 'ไม่พบงานนี้' using errcode = 'ACC04'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('no', i.item_no, 'date', i.entry_date::text, 'narrative', i.narrative, 'points', i.points::text)
                            order by i.item_no), '[]')
    into v_items from acc.exercise_items i where i.set_id = a.set_id;

  select coalesce(jsonb_agg(x order by x->>'studentCode'), '[]') into v_students from (
    select jsonb_build_object(
             'studentId', u.id, 'studentCode', u.student_code, 'name', u.display_name,
             'companyId', c.id, 'companyName', c.name, 'status', s.status,
             'teacherScore', s.score::text, 'maxScore', s.max_score::text,
             'startedAt', t.started_at, 'deadline', t.deadline, 'extraMinutes', t.extra_minutes,
             'lockReason', case when c.id is not null then app.company_lock_reason(c.id) end,
             'entries', (select count(*) from acc.journal_entries e where e.company_id = c.id),
             'grade', case when c.id is not null and a.set_id is not null then
                        (select jsonb_build_object('score', g->'score', 'maxScore', g->'maxScore', 'correct', g->'correct',
                                  'items', (select jsonb_agg(jsonb_build_object('no', y->'no', 'status', y->'status', 'earned', y->'earned')
                                                             order by (y->>'no')::int) from jsonb_array_elements(g->'items') y),
                                  'extra', jsonb_array_length(g->'extraEntries'))
                           from app.grade_company(c.id) g) end) as x
      from (select e.user_id from acc.enrollments e join acc.users u2 on u2.id = e.user_id and u2.role = 'student'
             where e.classroom_id = a.classroom_id
            union select c2.owner_id from acc.companies c2 where c2.assignment_id = a.id) m
      join acc.users u on u.id = m.user_id
      left join acc.companies c on c.assignment_id = a.id and c.owner_id = u.id
      left join acc.submissions s on s.company_id = c.id
      left join acc.exam_attempts t on t.company_id = c.id
  ) z;

  return jsonb_build_object(
    'assignment', jsonb_build_object('id', a.id, 'mode', a.mode, 'title', a.title, 'companyName', a.company_name, 'setId', a.set_id,
       'classroomId', a.classroom_id, 'classroom', (select name from acc.classrooms where id = a.classroom_id),
       'feedback', a.feedback, 'reveal', a.reveal, 'checkDate', a.check_date, 'opensAt', a.opens_at, 'closesAt', a.closes_at,
       'durationMinutes', a.duration_minutes, 'releasedAt', a.released_at, 'closedAt', a.closed_at, 'createdAt', a.created_at),
    'items', v_items, 'students', v_students, 'now', now());
end $function$

;
drop function app.company_set(uuid);
alter table acc.companies drop column exercise_set_id;
alter table acc.assignments drop column distribution;
drop table acc.assignment_sets;
