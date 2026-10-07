-- migrate:up
-- ค่าเริ่มต้นปฏิเสธทั้งหมด: เปิด RLS ทุกตาราง แล้วเปิดเท่าที่ต้องใช้
alter table acc.schools            enable row level security;
alter table acc.users              enable row level security;
alter table acc.classrooms         enable row level security;
alter table acc.enrollments        enable row level security;
alter table acc.companies          enable row level security;
alter table acc.coa_template       enable row level security;
alter table acc.chart_of_accounts  enable row level security;
alter table acc.periods            enable row level security;
alter table acc.document_sequences enable row level security;
alter table acc.journal_entries    enable row level security;
alter table acc.journal_lines      enable row level security;
alter table acc.account_balances   enable row level security;
alter table acc.idempotency_keys   enable row level security;
alter table acc.audit_log          enable row level security;

-- สิทธิ์ระดับตาราง: อ่านได้ (ถูกกรองด้วย RLS) เขียนได้เฉพาะที่จำเป็น
grant select on acc.schools, acc.users, acc.classrooms, acc.enrollments, acc.companies,
  acc.coa_template, acc.chart_of_accounts, acc.periods, acc.journal_entries, acc.journal_lines,
  acc.account_balances, acc.audit_log to app_rw, app_ro;
-- สมุดรายวัน ยอดคงเหลือ งวด เลขที่เอกสาร idempotency: เขียนผ่านฟังก์ชันเท่านั้น
grant update (name, version) on acc.companies to app_rw;
grant insert, update (name, active, version, code, type) on acc.chart_of_accounts to app_rw;

-- ผู้ใช้
create policy users_self on acc.users for select to app_rw, app_ro
  using (id = app.current_user_id());
create policy users_teacher on acc.users for select to app_rw, app_ro
  using (app.is_teacher_of_student(id));
create policy users_admin on acc.users for select to app_rw, app_ro
  using (app.user_role() = 'admin'
         and school_id = app.current_school_id());

create policy schools_own on acc.schools for select to app_rw, app_ro
  using (id = app.current_school_id());

create policy classrooms_teacher on acc.classrooms for select to app_rw, app_ro
  using (teacher_id = app.current_user_id());
create policy classrooms_student on acc.classrooms for select to app_rw, app_ro
  using (exists (select 1 from acc.enrollments e
                  where e.classroom_id = id and e.user_id = app.current_user_id()));
create policy classrooms_admin on acc.classrooms for select to app_rw, app_ro
  using (app.user_role() = 'admin');

create policy enrollments_self on acc.enrollments for select to app_rw, app_ro
  using (user_id = app.current_user_id());
create policy enrollments_teacher on acc.enrollments for select to app_rw, app_ro
  using (exists (select 1 from acc.classrooms r
                  where r.id = classroom_id and r.teacher_id = app.current_user_id()));

-- ข้อมูลบัญชี: ทุกแถวมี company_id ตัดสินด้วยฟังก์ชันเดียวกัน
create policy companies_read on acc.companies for select to app_rw, app_ro
  using (app.can_read_company(id));
create policy companies_update on acc.companies for update to app_rw
  using (app.can_write_company(id)) with check (app.can_write_company(id));

create policy coa_template_read on acc.coa_template for select to app_rw, app_ro using (true);

create policy coa_read on acc.chart_of_accounts for select to app_rw, app_ro
  using (app.can_read_company(company_id));
create policy coa_insert on acc.chart_of_accounts for insert to app_rw
  with check (app.can_write_company(company_id));
create policy coa_update on acc.chart_of_accounts for update to app_rw
  using (app.can_write_company(company_id)) with check (app.can_write_company(company_id));

create policy periods_read on acc.periods for select to app_rw, app_ro
  using (app.can_read_company(company_id));
create policy entries_read on acc.journal_entries for select to app_rw, app_ro
  using (app.can_read_company(company_id));
create policy lines_read on acc.journal_lines for select to app_rw, app_ro
  using (app.can_read_company(company_id));
create policy balances_read on acc.account_balances for select to app_rw, app_ro
  using (app.can_read_company(company_id));

-- audit log: ผู้ดูแลระบบอ่านเฉพาะโรงเรียนตัวเอง
create policy audit_admin on acc.audit_log for select to app_rw, app_ro
  using (app.user_role() = 'admin'
         and (company_id is null or app.company_in_my_school(company_id)));
-- document_sequences, idempotency_keys: ไม่มี policy = ปฏิเสธทั้งหมด (ฟังก์ชัน definer เท่านั้น)

-- migrate:down
select 1;
