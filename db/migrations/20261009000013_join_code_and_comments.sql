-- migrate:up
-- เฟส 1: รหัสห้อง/QR ให้นักเรียนเข้าห้องเอง และคอมเมนต์ปากกาแดงของครู (docs/assumptions.md ข้อ 21–22)

-- รหัสห้อง: 6 ตัว จากตัวอักษรที่อ่านไม่สับสน (ไม่มี I O 0 1) แอปสุ่มด้วย crypto; null = ปิดรหัส
alter table acc.classrooms add column join_code text unique check (join_code ~ '^[A-HJ-NP-Z2-9]{6}$');

-- ครูประจำห้อง (หรือผู้ดูแลโรงเรียนเดียวกัน) ตั้ง/เปลี่ยน/ปิดรหัส; รหัสเดิมใช้ไม่ได้ทันที
create function acc.set_join_code(p_classroom uuid, p_code text) returns text
language plpgsql security definer set search_path = acc, pg_temp as $$
begin
  if not exists (select 1 from acc.classrooms r
                  where r.id = p_classroom
                    and (r.teacher_id = app.current_user_id()
                         or (app.user_role() = 'admin' and r.school_id = app.current_school_id()))) then
    raise exception 'ตั้งรหัสห้องได้เฉพาะครูประจำห้อง' using errcode = '42501';
  end if;
  update acc.classrooms set join_code = p_code where id = p_classroom;
  return p_code;
end $$;

-- นักเรียนเข้าห้องด้วยรหัส: ได้เฉพาะห้องในโรงเรียนเดียวกัน ไม่สร้างบัญชีใหม่ (บัญชียังมาจากครู/CSV)
create function acc.join_classroom(p_code text)
returns table (classroom_id uuid, name text, already boolean)
language plpgsql security definer set search_path = acc, pg_temp as $$
declare
  v_room acc.classrooms;
  v_me   uuid := app.current_user_id();
begin
  if app.user_role() is distinct from 'student' then
    raise exception 'รหัสห้องใช้สำหรับนักเรียน' using errcode = '42501';
  end if;
  select * into v_room from acc.classrooms
   where join_code = upper(btrim(p_code)) and school_id = app.current_school_id();
  if not found then
    raise exception 'ไม่พบห้องที่ใช้รหัสนี้ ตรวจรหัสกับครูอีกครั้ง' using errcode = 'ACC04';
  end if;
  insert into acc.enrollments (classroom_id, user_id) values (v_room.id, v_me) on conflict do nothing;
  already := not found;
  if not already then
    insert into acc.audit_log (user_id, table_name, op, row_pk, client, new_row)
    values (v_me, 'enrollments', 'JOIN_BY_CODE', v_room.id::text, nullif(current_setting('app.client_info', true), ''),
            jsonb_build_object('classroom_id', v_room.id, 'user_id', v_me));
  end if;
  classroom_id := v_room.id; name := v_room.name;
  return next;
end $$;

-- คอมเมนต์ครูที่รายการ (line_no = null) หรือที่บรรทัด; เขียนผ่านฟังก์ชันเท่านั้น ลบ = ซ่อน (เก็บไว้ใน audit)
create table acc.comments (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references acc.companies(id),
  entry_id   uuid not null,
  line_no    int,
  author_id  uuid not null references acc.users(id),
  body       text not null check (length(btrim(body)) between 1 and 1000),
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  foreign key (company_id, entry_id) references acc.journal_entries (company_id, id)
);
create index comments_entry on acc.comments (company_id, entry_id);
alter table acc.comments enable row level security;
grant select on acc.comments to app_rw, app_ro;
create policy comments_read on acc.comments for select to app_rw, app_ro
  using (deleted_at is null and app.can_read_company(company_id));
create trigger audit_comments after insert or update on acc.comments
  for each row execute function acc.audit_row();

-- ผู้เขียนคอมเมนต์ = ครูของห้องที่บริษัทสังกัด (อ่านได้แต่ไม่ใช่เจ้าของ) เขียนได้แม้งานถูกล็อกระหว่างตรวจ
create function acc.add_comment(p_company uuid, p_entry uuid, p_line int, p_body text) returns uuid
language plpgsql security definer set search_path = acc, pg_temp as $$
declare v_id uuid;
begin
  if not app.can_read_company(p_company)
     or (select owner_id from acc.companies where id = p_company) = app.current_user_id() then
    raise exception 'คอมเมนต์ได้เฉพาะครูประจำห้อง' using errcode = '42501';
  end if;
  if not exists (select 1 from acc.journal_entries where company_id = p_company and id = p_entry) then
    raise exception 'ไม่พบรายการนี้' using errcode = 'ACC04';
  end if;
  if p_line is not null and not exists (
       select 1 from acc.journal_lines where company_id = p_company and entry_id = p_entry and line_no = p_line) then
    raise exception 'ไม่พบบรรทัดที่ % ในรายการนี้', p_line using errcode = 'ACC04';
  end if;
  insert into acc.comments (company_id, entry_id, line_no, author_id, body)
  values (p_company, p_entry, p_line, app.current_user_id(), btrim(p_body))
  returning id into v_id;
  perform app.notify('company:' || p_company, 'comment', jsonb_build_object('entry', p_entry));
  return v_id;
end $$;

create function acc.delete_comment(p_comment uuid) returns void
language plpgsql security definer set search_path = acc, pg_temp as $$
declare v_company uuid;
begin
  update acc.comments set deleted_at = now()
   where id = p_comment and author_id = app.current_user_id() and deleted_at is null
  returning company_id into v_company;
  if not found then raise exception 'ไม่พบคอมเมนต์ของคุณ' using errcode = 'ACC04'; end if;
  perform app.notify('company:' || v_company, 'comment', '{}');
end $$;

revoke all on function acc.set_join_code(uuid,text), acc.join_classroom(text),
  acc.add_comment(uuid,uuid,int,text), acc.delete_comment(uuid) from public;
grant execute on function acc.set_join_code(uuid,text), acc.join_classroom(text),
  acc.add_comment(uuid,uuid,int,text), acc.delete_comment(uuid) to app_rw;

-- migrate:down
drop function acc.delete_comment(uuid), acc.add_comment(uuid,uuid,int,text),
  acc.join_classroom(text), acc.set_join_code(uuid,text);
drop table acc.comments;
alter table acc.classrooms drop column join_code;
