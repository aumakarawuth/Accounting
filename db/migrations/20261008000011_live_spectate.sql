-- migrate:up
-- ดูสด (PLAN.md ข้อ 10): trigger ส่ง NOTIFY เบา ๆ ไปช่องของบริษัท/นักเรียน แล้วฝั่งครูดึงข้อมูลจริงผ่าน RLS
-- ช่อง: company:<id> (ลงรายการ/สถานะงาน/ร่าง), student:<id> (ครูเริ่ม/หยุดดู)

-- กิจกรรมล่าสุดของนักเรียนต่อบริษัท: หน้าที่เปิด + สำเนาร่างสมุดรายวัน (ให้ครูดูสดเท่านั้น ไม่ใช่ข้อมูลบัญชี)
-- UNLOGGED: เขียนบ่อย เขียนทับ ไม่ต้องมี WAL (self-host ย้ายไป Redis ได้)
create unlogged table acc.presence (
  company_id   uuid primary key references acc.companies(id),
  user_id      uuid not null references acc.users(id),
  page         text not null check (page in ('home','journal','ledger','trial-balance','statements','menu','other')),
  draft        jsonb,
  draft_debit  numeric(18,2),
  draft_credit numeric(18,2),
  draft_lines  int,
  updated_at   timestamptz not null default now()
);
alter table acc.presence enable row level security;
grant select on acc.presence to app_rw, app_ro;
create policy presence_read on acc.presence for select to app_rw, app_ro using (app.can_read_company(company_id));

create table acc.spectate_log (
  id           uuid primary key default gen_random_uuid(),
  teacher_id   uuid not null references acc.users(id),
  student_id   uuid not null references acc.users(id),
  company_id   uuid not null references acc.companies(id),
  started_at   timestamptz not null default now(),
  last_ping_at timestamptz not null default now(),
  ended_at     timestamptz,
  client       text
);
create index spectate_log_student on acc.spectate_log (student_id) where ended_at is null;
alter table acc.spectate_log enable row level security;  -- ไม่มี policy: อ่าน/เขียนผ่านฟังก์ชันเท่านั้น

create function app.notify(p_channel text, p_kind text, p_extra jsonb default '{}') returns void
language sql as $$
  select pg_notify('acc_events', (jsonb_build_object('ch', p_channel, 'k', p_kind) || p_extra)::text)
$$;

create function acc.notify_company_event() returns trigger
language plpgsql as $$
begin
  perform app.notify('company:' || new.company_id,
    case tg_table_name when 'journal_entries' then 'journal' else 'submission' end);
  return null;
end $$;
create trigger journal_entries_notify after insert on acc.journal_entries
  for each row execute function acc.notify_company_event();
create trigger submissions_notify after insert or update on acc.submissions
  for each row execute function acc.notify_company_event();

-- นักเรียนรายงานหน้าที่เปิดและร่าง; ยอดเดบิต/เครดิตของร่างคำนวณที่นี่ (ไม่เชื่อตัวเลขจาก client)
-- p_draft: {"date":"...","description":"...","lines":[{"account_code":"1110","debit":"100","credit":""}]}
create function app.presence_update(p_company uuid, p_page text, p_draft jsonb) returns void
language plpgsql security definer set search_path = acc, pg_temp as $$
declare v_dr numeric := 0; v_cr numeric := 0; v_n int := 0; l jsonb;
begin
  if not app.can_write_company(p_company) then
    raise exception 'ไม่มีสิทธิ์' using errcode = '42501';
  end if;
  if p_draft is not null then
    if octet_length(p_draft::text) > 32768 or jsonb_typeof(p_draft->'lines') is distinct from 'array'
       or jsonb_array_length(p_draft->'lines') > 200 then
      raise exception 'ร่างใหญ่เกินไป' using errcode = '22023';
    end if;
    for l in select * from jsonb_array_elements(p_draft->'lines') loop
      if coalesce(l->>'debit', '') ~ '^\d{1,16}(\.\d{0,2})?$' then v_dr := v_dr + (l->>'debit')::numeric; end if;
      if coalesce(l->>'credit', '') ~ '^\d{1,16}(\.\d{0,2})?$' then v_cr := v_cr + (l->>'credit')::numeric; end if;
      if coalesce(l->>'account_code', '') <> '' or coalesce(l->>'debit', '') <> '' or coalesce(l->>'credit', '') <> '' then
        v_n := v_n + 1;
      end if;
    end loop;
  end if;
  insert into acc.presence (company_id, user_id, page, draft, draft_debit, draft_credit, draft_lines, updated_at)
  values (p_company, app.current_user_id(), p_page, p_draft,
          case when p_draft is null then null else v_dr end, case when p_draft is null then null else v_cr end,
          case when p_draft is null then null else v_n end, now())
  on conflict (company_id) do update set
    user_id = excluded.user_id, page = excluded.page, updated_at = excluded.updated_at,
    -- ออกจากหน้าสมุดรายวันแล้วยังเก็บร่างล่าสุดไว้ (ร่างยังอยู่ในเครื่องนักเรียน)
    draft = coalesce(excluded.draft, acc.presence.draft),
    draft_debit = coalesce(excluded.draft_debit, acc.presence.draft_debit),
    draft_credit = coalesce(excluded.draft_credit, acc.presence.draft_credit),
    draft_lines = coalesce(excluded.draft_lines, acc.presence.draft_lines);
  perform app.notify('company:' || p_company, 'presence');
end $$;

-- ล้างร่างเมื่อผ่านรายการแล้ว (ร่างกลายเป็นรายการจริง)
create function app.presence_clear_draft(p_company uuid) returns void
language plpgsql security definer set search_path = acc, pg_temp as $$
begin
  if not app.can_write_company(p_company) then raise exception 'ไม่มีสิทธิ์' using errcode = '42501'; end if;
  update acc.presence set draft = null, draft_debit = null, draft_credit = null, draft_lines = null, updated_at = now()
   where company_id = p_company;
  perform app.notify('company:' || p_company, 'presence');
end $$;

-- ครูเริ่มดูสด: เฉพาะครูประจำห้องของบริษัทนั้น ไม่ใช่เจ้าของ; บันทึกทุกครั้ง และแจ้งนักเรียน
create function acc.spectate_start(p_company uuid) returns uuid
language plpgsql security definer set search_path = acc, pg_temp as $$
declare c acc.companies; v_id uuid; v_name text;
begin
  select * into c from acc.companies where id = p_company;
  if not found or c.classroom_id is null or not app.teaches(c.classroom_id) then
    raise exception 'ดูสดได้เฉพาะนักเรียนในห้องของครู' using errcode = '42501';
  end if;
  insert into acc.spectate_log (teacher_id, student_id, company_id, client)
  values (app.current_user_id(), c.owner_id, p_company, nullif(current_setting('app.client_info', true), ''))
  returning id into v_id;
  select display_name into v_name from acc.users where id = app.current_user_id();
  perform app.notify('student:' || c.owner_id, 'watch', jsonb_build_object('id', v_id, 'by', v_name, 'company', p_company));
  return v_id;
end $$;

create function acc.spectate_ping(p_id uuid) returns void
language plpgsql security definer set search_path = acc, pg_temp as $$
declare s acc.spectate_log; v_name text;
begin
  update acc.spectate_log set last_ping_at = now()
   where id = p_id and teacher_id = app.current_user_id() and ended_at is null
  returning * into s;
  if not found then raise exception 'ไม่พบการดูสดนี้ หรือหยุดไปแล้ว' using errcode = 'ACC04'; end if;
  select display_name into v_name from acc.users where id = s.teacher_id;
  perform app.notify('student:' || s.student_id, 'watch', jsonb_build_object('id', s.id, 'by', v_name, 'company', s.company_id));
end $$;

create function acc.spectate_stop(p_id uuid) returns void
language plpgsql security definer set search_path = acc, pg_temp as $$
declare s acc.spectate_log;
begin
  update acc.spectate_log set ended_at = now()
   where id = p_id and teacher_id = app.current_user_id() and ended_at is null
  returning * into s;
  if found then
    perform app.notify('student:' || s.student_id, 'unwatch', jsonb_build_object('id', s.id));
  end if;
end $$;

-- นักเรียนดูว่าใครกำลังดูอยู่ (ตั้งใจให้เห็นชื่อครู: แผนกำหนดให้แจ้งเด็กเสมอ)
create function app.my_watchers() returns table (id uuid, teacher_name text, company_id uuid)
language sql stable security definer set search_path = acc, pg_temp as $$
  select s.id, u.display_name, s.company_id
    from acc.spectate_log s join acc.users u on u.id = s.teacher_id
   where s.student_id = app.current_user_id() and s.ended_at is null
     and s.last_ping_at > now() - interval '45 seconds'
$$;

-- แดชบอร์ดห้อง: นักเรียนแต่ละคน + บริษัทที่เคลื่อนไหวล่าสุดในห้องนี้
create function acc.classroom_live(p_classroom uuid)
returns table (
  student_id uuid, student_code text, name text, company_id uuid, company_name text,
  page text, draft_debit numeric, draft_credit numeric, draft_lines int, presence_at timestamptz,
  last_seen_at timestamptz, last_posted_at timestamptz
)
language plpgsql stable security definer set search_path = acc, pg_temp as $$
begin
  if not app.teaches(p_classroom) then
    raise exception 'ไม่ใช่ห้องของครู' using errcode = '42501';
  end if;
  return query
  select u.id, u.student_code, u.display_name, co.id, co.name,
         p.page, p.draft_debit, p.draft_credit, p.draft_lines, p.updated_at,
         (select max(se.last_seen_at) from acc.sessions se where se.user_id = u.id and se.revoked_at is null),
         (select max(e.posted_at) from acc.journal_entries e where e.company_id = co.id)
    from acc.enrollments en
    join acc.users u on u.id = en.user_id and u.active and u.role = 'student'
    left join lateral (
      select c2.* from acc.companies c2
        left join acc.presence p2 on p2.company_id = c2.id
       where c2.owner_id = u.id and c2.classroom_id = p_classroom
       order by p2.updated_at desc nulls last, c2.created_at desc
       limit 1
    ) co on true
    left join acc.presence p on p.company_id = co.id
   where en.classroom_id = p_classroom
   order by u.student_code;
end $$;

revoke all on function app.notify(text,text,jsonb), app.presence_update(uuid,text,jsonb), app.presence_clear_draft(uuid),
  acc.spectate_start(uuid), acc.spectate_ping(uuid), acc.spectate_stop(uuid), app.my_watchers(), acc.classroom_live(uuid) from public;
grant execute on function app.presence_update(uuid,text,jsonb), app.presence_clear_draft(uuid),
  acc.spectate_start(uuid), acc.spectate_ping(uuid), acc.spectate_stop(uuid), app.my_watchers(), acc.classroom_live(uuid) to app_rw;

-- migrate:down
drop function acc.classroom_live(uuid), app.my_watchers(), acc.spectate_stop(uuid), acc.spectate_ping(uuid),
  acc.spectate_start(uuid), app.presence_clear_draft(uuid), app.presence_update(uuid,text,jsonb);
drop trigger submissions_notify on acc.submissions;
drop trigger journal_entries_notify on acc.journal_entries;
drop function acc.notify_company_event(), app.notify(text,text,jsonb);
drop table acc.spectate_log, acc.presence;
