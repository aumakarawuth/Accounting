-- migrate:up
-- โหมดส่งงาน: บริษัทจำลอง 1 บริษัท = งาน 1 ชิ้น (ตารางโจทย์มาในเฟส 4)
-- วงจร: ร่าง → ส่งตรวจ → ครูกำลังตรวจ → ส่งกลับให้แก้ / ผ่าน → ปิด ทุกขั้นบันทึกใน submission_events

alter table acc.companies add column mode text not null default 'practice' check (mode in ('practice', 'submit'));

create table acc.submissions (
  company_id uuid primary key references acc.companies(id),
  status     text not null default 'draft'
             check (status in ('draft', 'submitted', 'reviewing', 'returned', 'passed', 'closed')),
  round      int not null default 0,          -- ส่งครั้งที่เท่าไร
  score      numeric(5,2),
  max_score  numeric(5,2) not null default 10 check (max_score > 0),
  updated_at timestamptz not null default now()
);

create table acc.submission_events (
  id          bigint generated always as identity primary key,
  company_id  uuid not null references acc.companies(id),
  at          timestamptz not null default now(),
  actor       uuid not null references acc.users(id),
  action      text not null check (action in ('submit', 'review', 'return', 'pass', 'close')),
  from_status text not null,
  to_status   text not null,
  round       int not null,
  note        text,
  score       numeric(5,2),
  snapshot    jsonb                             -- งบทดลอง ณ ตอนส่ง
);
create index submission_events_company on acc.submission_events (company_id, id);
create trigger submission_events_immutable before update or delete on acc.submission_events
  for each row execute function acc.forbid_mutation();

alter table acc.submissions enable row level security;
alter table acc.submission_events enable row level security;
grant select on acc.submissions, acc.submission_events to app_rw, app_ro;
create policy submissions_read on acc.submissions for select to app_rw, app_ro using (app.can_read_company(company_id));
create policy submission_events_read on acc.submission_events for select to app_rw, app_ro using (app.can_read_company(company_id));

-- ส่งตรวจแล้ว (จนกว่าครูส่งกลับ) บริษัทถูกล็อก: กันที่ DB ทุกเส้นทางที่เขียน
create function app.company_locked(p_company uuid) returns boolean
language sql stable security definer set search_path = acc, pg_temp as $$
  select exists (select 1 from acc.submissions
                  where company_id = p_company and status in ('submitted', 'reviewing', 'passed', 'closed'))
$$;

create function acc.guard_locked_company() returns trigger
language plpgsql as $$
begin
  if app.company_locked(new.company_id) then
    raise exception 'งานนี้ส่งตรวจแล้ว แก้ไขไม่ได้จนกว่าครูจะส่งกลับให้แก้' using errcode = 'ACC10';
  end if;
  return new;
end $$;
create trigger journal_entries_locked before insert on acc.journal_entries
  for each row execute function acc.guard_locked_company();
create trigger chart_of_accounts_locked before insert or update on acc.chart_of_accounts
  for each row execute function acc.guard_locked_company();
create trigger periods_locked before update on acc.periods
  for each row execute function acc.guard_locked_company();

-- เปลี่ยนสถานะงาน; p_expected = สถานะที่ผู้ใช้เห็นอยู่ (กันกดทับกันจากสองหน้าจอ)
create function acc.submission_action(
  p_company uuid, p_action text, p_expected text, p_note text default null, p_score numeric default null
) returns text
language plpgsql security definer set search_path = acc, pg_temp as $$
declare
  c acc.companies;
  s acc.submissions;
  v_owner boolean;
  v_teacher boolean;
  v_to text;
  v_snapshot jsonb;
begin
  select * into c from acc.companies where id = p_company;
  if not found or not app.can_read_company(p_company) then
    raise exception 'ไม่พบบริษัทนี้' using errcode = 'ACC04';
  end if;
  if c.mode <> 'submit' then
    raise exception 'บริษัทนี้อยู่ในโหมดฝึกหัด ไม่มีการส่งงาน' using errcode = 'ACC11';
  end if;
  v_owner := app.can_write_company(p_company);
  v_teacher := c.classroom_id is not null and app.teaches(c.classroom_id);

  insert into acc.submissions (company_id) values (p_company) on conflict do nothing;
  select * into s from acc.submissions where company_id = p_company for update;
  if s.status <> p_expected then
    raise exception 'สถานะงานเปลี่ยนไปแล้ว โหลดหน้าใหม่' using errcode = '40001';
  end if;

  case p_action
    when 'submit' then
      if not v_owner then raise exception 'เฉพาะเจ้าของงานส่งตรวจได้' using errcode = '42501'; end if;
      if s.status not in ('draft', 'returned') then
        raise exception 'ส่งตรวจได้เฉพาะงานที่เป็นร่างหรือถูกส่งกลับ' using errcode = 'ACC11';
      end if;
      if not exists (select 1 from acc.journal_entries where company_id = p_company) then
        raise exception 'ยังไม่มีรายการในสมุดรายวัน ส่งตรวจไม่ได้' using errcode = 'ACC11';
      end if;
      v_to := 'submitted';
      s.round := s.round + 1;
      select jsonb_build_object(
               'entries', (select count(*) from acc.journal_entries where company_id = p_company),
               'last_doc_no', (select max(doc_no) from acc.journal_entries where company_id = p_company),
               'trial_balance', coalesce(jsonb_agg(jsonb_build_object(
                   'code', t.code, 'debit', t.debit_total, 'credit', t.credit_total) order by t.code)
                   filter (where t.debit_total <> 0 or t.credit_total <> 0), '[]'))
        into v_snapshot from acc.trial_balance(p_company) t;
    when 'review' then
      if not v_teacher then raise exception 'เฉพาะครูประจำห้อง' using errcode = '42501'; end if;
      if s.status <> 'submitted' then raise exception 'เริ่มตรวจได้เฉพาะงานที่ส่งแล้ว' using errcode = 'ACC11'; end if;
      v_to := 'reviewing';
    when 'return' then
      if not v_teacher then raise exception 'เฉพาะครูประจำห้อง' using errcode = '42501'; end if;
      if s.status not in ('submitted', 'reviewing') then raise exception 'ส่งกลับได้เฉพาะงานที่ส่งแล้ว' using errcode = 'ACC11'; end if;
      if length(trim(coalesce(p_note, ''))) = 0 then
        raise exception 'ต้องเขียนเหตุผลที่ส่งกลับให้แก้' using errcode = 'ACC11';
      end if;
      v_to := 'returned';
    when 'pass' then
      if not v_teacher then raise exception 'เฉพาะครูประจำห้อง' using errcode = '42501'; end if;
      if s.status not in ('submitted', 'reviewing') then raise exception 'ให้ผ่านได้เฉพาะงานที่ส่งแล้ว' using errcode = 'ACC11'; end if;
      if p_score is null or p_score < 0 or p_score > s.max_score then
        raise exception 'คะแนนต้องอยู่ระหว่าง 0 ถึง %', s.max_score using errcode = 'ACC11';
      end if;
      v_to := 'passed';
      s.score := p_score;
    when 'close' then
      if not v_teacher then raise exception 'เฉพาะครูประจำห้อง' using errcode = '42501'; end if;
      if s.status not in ('passed', 'returned') then raise exception 'ปิดได้เฉพาะงานที่ผ่านหรือส่งกลับแล้ว' using errcode = 'ACC11'; end if;
      v_to := 'closed';
    else
      raise exception 'ไม่รู้จักการกระทำ %', p_action using errcode = '22023';
  end case;

  insert into acc.submission_events (company_id, actor, action, from_status, to_status, round, note, score, snapshot)
  values (p_company, app.current_user_id(), p_action, s.status, v_to, s.round, nullif(trim(p_note), ''),
          case when p_action = 'pass' then p_score end, v_snapshot);
  update acc.submissions set status = v_to, round = s.round, score = s.score, updated_at = now()
   where company_id = p_company;
  return v_to;
end $$;

-- ครูเปิดดูงานของนักเรียน: บันทึกทุกครั้ง (PLAN.md: ครูดูงานเด็ก บันทึก audit log ทุกครั้ง)
create function app.log_company_view(p_company uuid) returns void
language plpgsql security definer set search_path = acc, pg_temp as $$
begin
  if app.can_read_company(p_company) and not app.can_write_company(p_company) then
    insert into acc.audit_log (user_id, company_id, table_name, op, row_pk, client)
    values (app.current_user_id(), p_company, 'companies', 'VIEW', p_company::text,
            nullif(current_setting('app.client_info', true), ''));
  end if;
end $$;

-- เปิดบริษัททั้งห้อง: เพิ่มโหมด (ฝึกหัด/ส่งงาน)
drop function acc.open_classroom_companies(uuid, text);
create function acc.open_classroom_companies(p_classroom uuid, p_name text, p_mode text default 'practice')
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
  if p_mode not in ('practice', 'submit') then
    raise exception 'โหมดไม่ถูกต้อง' using errcode = '22023';
  end if;

  select count(*) into v_students
    from acc.enrollments e join acc.users u on u.id = e.user_id
   where e.classroom_id = p_classroom and u.role = 'student' and u.active;

  with ins as (
    insert into acc.companies (school_id, owner_id, classroom_id, name, mode)
    select v_school, e.user_id, p_classroom, trim(p_name), p_mode
      from acc.enrollments e join acc.users u on u.id = e.user_id
     where e.classroom_id = p_classroom and u.role = 'student' and u.active
    on conflict (owner_id, classroom_id, name) where classroom_id is not null do nothing
    returning id
  ), coa as (
    insert into acc.chart_of_accounts (company_id, code, name, type)
    select ins.id, t.code, t.name, t.type from ins cross join acc.coa_template t
    returning 1
  ), sub as (
    insert into acc.submissions (company_id) select id from ins where p_mode = 'submit'
    returning 1
  )
  select count(*)::int into created from ins;

  existing := v_students - created;
  return next;
end $$;

revoke all on function app.company_locked(uuid), acc.submission_action(uuid,text,text,text,numeric),
  app.log_company_view(uuid), acc.open_classroom_companies(uuid,text,text) from public;
grant execute on function app.company_locked(uuid), acc.submission_action(uuid,text,text,text,numeric),
  app.log_company_view(uuid), acc.open_classroom_companies(uuid,text,text) to app_rw;
grant execute on function app.company_locked(uuid) to app_ro;

-- migrate:down
drop function acc.open_classroom_companies(uuid,text,text), app.log_company_view(uuid),
  acc.submission_action(uuid,text,text,text,numeric);
drop trigger periods_locked on acc.periods;
drop trigger chart_of_accounts_locked on acc.chart_of_accounts;
drop trigger journal_entries_locked on acc.journal_entries;
drop function acc.guard_locked_company(), app.company_locked(uuid);
drop table acc.submission_events, acc.submissions;
alter table acc.companies drop column mode;
