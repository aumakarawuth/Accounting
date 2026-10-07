-- migrate:up
-- ครูเปิดบริษัทจำลองให้นักเรียนทั้งห้อง: คนละชุดบัญชี แยกขาดกัน (เจ้าของคือนักเรียน)
create unique index companies_owner_room_name on acc.companies (owner_id, classroom_id, name) where classroom_id is not null;

create function acc.open_classroom_companies(p_classroom uuid, p_name text)
returns table (created int, existing int)
language plpgsql security definer set search_path = acc, pg_temp as $$
declare v_school uuid; v_students int;
begin
  select school_id into v_school from acc.classrooms where id = p_classroom;
  if v_school is null or not (app.teaches(p_classroom)
       or (app.user_role() = 'admin' and v_school = app.current_school_id())) then
    raise exception 'ไม่มีสิทธิ์เปิดบริษัทในห้องนี้' using errcode = '42501';
  end if;
  if length(trim(coalesce(p_name, ''))) = 0 then
    raise exception 'ต้องมีชื่อบริษัท' using errcode = '22023';
  end if;

  select count(*) into v_students
    from acc.enrollments e join acc.users u on u.id = e.user_id
   where e.classroom_id = p_classroom and u.role = 'student' and u.active;

  with ins as (
    insert into acc.companies (school_id, owner_id, classroom_id, name)
    select v_school, e.user_id, p_classroom, trim(p_name)
      from acc.enrollments e join acc.users u on u.id = e.user_id
     where e.classroom_id = p_classroom and u.role = 'student' and u.active
    on conflict (owner_id, classroom_id, name) where classroom_id is not null do nothing
    returning id
  ), coa as (
    insert into acc.chart_of_accounts (company_id, code, name, type)
    select ins.id, t.code, t.name, t.type from ins cross join acc.coa_template t
    returning 1
  )
  select count(*)::int into created from ins;

  existing := v_students - created;
  return next;
end $$;

revoke all on function acc.open_classroom_companies(uuid, text) from public;
grant execute on function acc.open_classroom_companies(uuid, text) to app_rw;

-- migrate:down
drop function acc.open_classroom_companies(uuid, text);
drop index acc.companies_owner_room_name;
