-- migrate:up

-- สมุดรายวัน/audit log เป็น append-only ทุกบทบาท รวมเจ้าของตาราง
create function acc.forbid_mutation() returns trigger
language plpgsql as $$
begin
  raise exception 'ตาราง % แก้ไขหรือลบไม่ได้ ให้ใช้รายการกลับรายการ', tg_table_name
    using errcode = 'ACC06';
end $$;

create trigger journal_entries_immutable before update or delete on acc.journal_entries
  for each row execute function acc.forbid_mutation();
create trigger journal_lines_immutable before update or delete on acc.journal_lines
  for each row execute function acc.forbid_mutation();
create trigger audit_log_immutable before update or delete on acc.audit_log
  for each row execute function acc.forbid_mutation();
create trigger journal_entries_no_truncate before truncate on acc.journal_entries
  for each statement execute function acc.forbid_mutation();
create trigger journal_lines_no_truncate before truncate on acc.journal_lines
  for each statement execute function acc.forbid_mutation();
create trigger audit_log_no_truncate before truncate on acc.audit_log
  for each statement execute function acc.forbid_mutation();

-- เดบิต = เครดิต ที่ระดับ DB ตรวจตอน COMMIT (deferred) ไม่ว่าใครเขียนมา
create function acc.assert_entry_balanced(v_company uuid, v_entry uuid) returns void
language plpgsql as $$
declare
  v_d numeric; v_c numeric; v_n int;
begin
  select coalesce(sum(debit),0), coalesce(sum(credit),0), count(*)
    into v_d, v_c, v_n
    from acc.journal_lines where company_id = v_company and entry_id = v_entry;
  if v_n < 2 then
    raise exception 'รายการ % ต้องมีอย่างน้อย 2 บรรทัด', v_entry using errcode = 'ACC01';
  end if;
  if v_d <> v_c then
    raise exception 'เดบิต % ไม่เท่าเครดิต % ผลต่าง %',
      to_char(v_d,'FM999,999,999,990.00'), to_char(v_c,'FM999,999,999,990.00'),
      to_char(abs(v_d-v_c),'FM999,999,999,990.00') using errcode = 'ACC01';
  end if;
end $$;

create function acc.check_lines_balanced() returns trigger
language plpgsql as $$
begin
  perform acc.assert_entry_balanced(new.company_id, new.entry_id);
  return null;
end $$;

create function acc.check_entry_has_lines() returns trigger
language plpgsql as $$
begin
  perform acc.assert_entry_balanced(new.company_id, new.id);
  return null;
end $$;

create constraint trigger journal_lines_balanced after insert on acc.journal_lines
  deferrable initially deferred for each row execute function acc.check_lines_balanced();
create constraint trigger journal_entries_balanced after insert on acc.journal_entries
  deferrable initially deferred for each row execute function acc.check_entry_has_lines();

-- ปิดงวดแล้วห้ามลงรายการ (กันที่ DB อีกชั้น นอกเหนือจาก post_journal)
create function acc.check_period_open() returns trigger
language plpgsql as $$
declare v_closed boolean; v_start date; v_end date;
begin
  select closed, start_date, end_date into v_closed, v_start, v_end
    from acc.periods where company_id = new.company_id and id = new.period_id;
  if v_closed then
    raise exception 'งวด % - % ปิดแล้ว ลงรายการไม่ได้', v_start, v_end using errcode = 'ACC02';
  end if;
  if new.entry_date < v_start or new.entry_date > v_end then
    raise exception 'วันที่ % อยู่นอกงวด % - %', new.entry_date, v_start, v_end using errcode = 'ACC02';
  end if;
  return new;
end $$;
create trigger journal_entries_period_open before insert on acc.journal_entries
  for each row execute function acc.check_period_open();

-- ล็อกเวอร์ชัน: ทุกการแก้ต้องตั้ง version = version + 1 และแอปใส่ where version = :ที่อ่านมา
create function acc.enforce_version() returns trigger
language plpgsql as $$
begin
  if new.version <> old.version + 1 then
    raise exception 'แก้ % โดยไม่เพิ่ม version (ต้องตั้ง version = version + 1)', tg_table_name
      using errcode = '40001';
  end if;
  return new;
end $$;
create trigger companies_version before update on acc.companies
  for each row execute function acc.enforce_version();
create trigger chart_of_accounts_version before update on acc.chart_of_accounts
  for each row execute function acc.enforce_version();

-- เปลี่ยนรหัส/ประเภทบัญชีที่มีรายการแล้วไม่ได้
create function acc.guard_account_identity() returns trigger
language plpgsql as $$
begin
  if (new.code <> old.code or new.type <> old.type)
     and exists (select 1 from acc.journal_lines where company_id = old.company_id and account_id = old.id) then
    raise exception 'บัญชี % มีรายการแล้ว เปลี่ยนรหัสหรือประเภทไม่ได้', old.code using errcode = 'ACC07';
  end if;
  return new;
end $$;
create trigger chart_of_accounts_guard before update on acc.chart_of_accounts
  for each row execute function acc.guard_account_identity();

-- audit log: ใคร ทำอะไร เมื่อไร จากไหน ค่าก่อน-หลัง (ผู้ใช้ปิด/แก้ไม่ได้)
create function acc.audit_row() returns trigger
language plpgsql security definer set search_path = acc, pg_temp as $$
declare
  v_new jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
  v_old jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  v_row jsonb := coalesce(v_new, v_old);
begin
  insert into acc.audit_log (user_id, company_id, table_name, op, row_pk, client, old_row, new_row)
  values (
    app.current_user_id(),
    case tg_table_name when 'companies' then (v_row->>'id')::uuid else (v_row->>'company_id')::uuid end,
    tg_table_name, tg_op,
    coalesce(v_row->>'id', v_row->>'code', v_row->>'start_date'),
    nullif(current_setting('app.client_info', true), ''),
    v_old, v_new);
  return null;
end $$;

create trigger audit_companies after insert or update or delete on acc.companies
  for each row execute function acc.audit_row();
create trigger audit_chart_of_accounts after insert or update or delete on acc.chart_of_accounts
  for each row execute function acc.audit_row();
create trigger audit_periods after insert or update or delete on acc.periods
  for each row execute function acc.audit_row();
create trigger audit_users after insert or update or delete on acc.users
  for each row execute function acc.audit_row();
create trigger audit_classrooms after insert or update or delete on acc.classrooms
  for each row execute function acc.audit_row();
create trigger audit_journal_entries after insert on acc.journal_entries
  for each row execute function acc.audit_row();

-- migrate:down
drop function acc.audit_row() cascade;
drop function acc.guard_account_identity() cascade;
drop function acc.enforce_version() cascade;
drop function acc.check_period_open() cascade;
drop function acc.check_entry_has_lines() cascade;
drop function acc.check_lines_balanced() cascade;
drop function acc.assert_entry_balanced(uuid, uuid);
drop function acc.forbid_mutation() cascade;
