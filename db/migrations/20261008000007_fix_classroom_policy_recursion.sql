-- migrate:up
-- แก้ RLS วนไม่จบ: classrooms_student อ่าน enrollments และ enrollments_teacher อ่าน classrooms กลับ
-- เปลี่ยนเป็นฟังก์ชัน security definer (ไม่ผ่าน RLS) แบบเดียวกับตัวช่วยอื่นใน 004
create function app.is_enrolled_in(p_classroom uuid) returns boolean
language sql stable security definer set search_path = acc, pg_temp as $$
  select exists (select 1 from acc.enrollments where classroom_id = p_classroom and user_id = app.current_user_id())
$$;

create function app.teaches(p_classroom uuid) returns boolean
language sql stable security definer set search_path = acc, pg_temp as $$
  select exists (select 1 from acc.classrooms where id = p_classroom and teacher_id = app.current_user_id())
$$;

grant execute on function app.is_enrolled_in(uuid), app.teaches(uuid) to app_rw, app_ro;

drop policy classrooms_student on acc.classrooms;
create policy classrooms_student on acc.classrooms for select to app_rw, app_ro
  using (app.is_enrolled_in(id));

drop policy enrollments_teacher on acc.enrollments;
create policy enrollments_teacher on acc.enrollments for select to app_rw, app_ro
  using (app.teaches(classroom_id));

-- migrate:down
drop policy enrollments_teacher on acc.enrollments;
drop policy classrooms_student on acc.classrooms;
drop function app.teaches(uuid), app.is_enrolled_in(uuid);
