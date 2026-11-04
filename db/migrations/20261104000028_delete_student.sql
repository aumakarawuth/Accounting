-- migrate:up
-- ครูประจำห้อง (หรือผู้ดูแล) ลบนักเรียนที่ยังไม่มีงานในระบบได้ เช่น นำเข้าผิด/ทดลอง
create function acc.delete_student(p_student uuid) returns void
language plpgsql security definer set search_path = acc, pg_temp as $$
begin
  if not exists (select 1 from acc.users where id = p_student and role = 'student') then
    raise exception 'ไม่พบนักเรียน' using errcode = 'ACC04';
  end if;
  if not (app.is_teacher_of(p_student) or exists (
    select 1 from acc.users me join acc.users s on s.school_id = me.school_id
     where me.id = app.current_user_id() and me.role = 'admin' and me.active and s.id = p_student)) then
    raise exception 'ไม่ใช่นักเรียนในห้องของครู' using errcode = '42501';
  end if;
  begin
    delete from acc.login_attempts where user_id = p_student;
    delete from acc.sessions where user_id = p_student;
    delete from acc.credentials where user_id = p_student;
    delete from acc.enrollments where user_id = p_student;
    delete from acc.presence where user_id = p_student;
    delete from acc.users where id = p_student;
  exception when foreign_key_violation then
    raise exception 'นักเรียนคนนี้มีงานในระบบแล้ว ลบไม่ได้' using errcode = 'ACC17';
  end;
end $$;
revoke all on function acc.delete_student(uuid) from public;
grant execute on function acc.delete_student(uuid) to app_rw;

-- migrate:down
drop function acc.delete_student(uuid);
