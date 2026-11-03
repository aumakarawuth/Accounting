-- migrate:up
-- ผู้ดูแลลบบัญชีที่ยังไม่มีงานในระบบได้ (เช่น สร้างผิด/ทดลอง) ถ้ามีงานแล้วให้ใช้ปิดบัญชีแทน
create function acc.admin_delete_user(p_user uuid) returns void
language plpgsql security definer set search_path = acc, pg_temp as $$
declare v_school uuid := app.require_admin();
begin
  if p_user = app.current_user_id() then
    raise exception 'ลบบัญชีของตัวเองไม่ได้' using errcode = 'ACC09';
  end if;
  perform 1 from acc.users where id = p_user and school_id = v_school for update;
  if not found then raise exception 'ไม่พบผู้ใช้ในโรงเรียนนี้' using errcode = 'ACC04'; end if;
  begin
    delete from acc.login_attempts where user_id = p_user;
    update acc.sessions set revoked_by = null where revoked_by = p_user and user_id <> p_user;
    delete from acc.sessions where user_id = p_user;
    delete from acc.credentials where user_id = p_user;
    delete from acc.enrollments where user_id = p_user;
    delete from acc.presence where user_id = p_user;
    delete from acc.users where id = p_user;
  exception when foreign_key_violation then
    raise exception 'บัญชีนี้มีงานในระบบแล้ว ลบไม่ได้ ใช้ปิดบัญชีแทน' using errcode = 'ACC17';
  end;
end $$;
revoke all on function acc.admin_delete_user(uuid) from public;
grant execute on function acc.admin_delete_user(uuid) to app_rw;

-- migrate:down
drop function acc.admin_delete_user(uuid);
