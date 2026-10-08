-- ข้อมูลตัวอย่างสำหรับเครื่องนักพัฒนาเท่านั้น (ห้ามรันบน staging/production)
-- psql "$ADMIN_DATABASE_URL" -f db/dev/fixture.sql
do $$ begin
  if not exists (select from pg_roles where rolname = 'app_dev') then
    create role app_dev login password 'app_dev' in role app_rw;  -- API ช่วงพัฒนาต่อด้วยบทบาทนี้
  end if;
end $$;

insert into acc.schools (id, name) values ('00000000-0000-4000-8000-000000000001', 'โรงเรียนตัวอย่าง')
on conflict do nothing;
insert into acc.users (id, school_id, role, student_code, email, display_name) values
  ('00000000-0000-4000-8000-000000000010', '00000000-0000-4000-8000-000000000001', 'teacher', null, 'teacher@example.test', 'ครูสมศรี'),
  ('00000000-0000-4000-8000-000000000020', '00000000-0000-4000-8000-000000000001', 'student', '65012', null, 'ณัฐวุฒิ'),
  ('00000000-0000-4000-8000-000000000030', '00000000-0000-4000-8000-000000000001', 'admin', null, 'admin-e2e@example.test', 'ผู้ดูแลระบบทดสอบ')
on conflict do nothing;
insert into acc.classrooms (id, school_id, teacher_id, name) values
  ('00000000-0000-4000-8000-000000000100', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000010', 'ม.5/2 บัญชี')
on conflict do nothing;
insert into acc.enrollments values ('00000000-0000-4000-8000-000000000100', '00000000-0000-4000-8000-000000000020')
on conflict do nothing;

-- บริษัทของนักเรียน 65012 สร้างผ่าน create_company เหมือนผู้ใช้จริง
do $$
declare v uuid;
begin
  if not exists (select 1 from acc.companies where owner_id = '00000000-0000-4000-8000-000000000020') then
    perform set_config('app.user_id', '00000000-0000-4000-8000-000000000020', true);
    v := acc.create_company('บริษัท ก. จำกัด', '00000000-0000-4000-8000-000000000100');
  end if;
end $$;
select 'บริษัทตัวอย่าง: ' || name from acc.companies where owner_id = '00000000-0000-4000-8000-000000000020';
