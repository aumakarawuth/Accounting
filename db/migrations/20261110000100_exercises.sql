-- migrate:up
-- เฟส 4: ชุดโจทย์ + เฉลย, มอบหมายให้ห้อง (ฝึกหัด/ส่งงาน/สอบ/สาธิต), ตรวจอัตโนมัติเทียบเฉลย, ล็อกตามเวลาสอบ
-- รายละเอียด docs/phase4-spec.md · นักเรียนไม่มี policy บนตารางโจทย์/เฉลยเลย อ่านได้ผ่าน acc.assignment_view เท่านั้น

-- ---------- ชุดโจทย์ ----------
create table acc.exercise_sets (
  id           uuid primary key default gen_random_uuid(),
  school_id    uuid not null references acc.schools(id),
  owner_id     uuid not null references acc.users(id),
  title        text not null check (length(trim(title)) between 1 and 200),
  company_name text not null check (length(trim(company_name)) between 1 and 120),
  description  text not null default '' check (length(description) <= 4000),
  version      int  not null default 1,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index exercise_sets_owner on acc.exercise_sets (owner_id, updated_at desc);

create table acc.exercise_items (
  set_id     uuid not null references acc.exercise_sets(id) on delete cascade,
  item_no    int  not null check (item_no between 1 and 200),
  entry_date date not null,
  narrative  text not null check (length(trim(narrative)) between 1 and 2000),
  points     numeric(6,2) not null check (points > 0),
  primary key (set_id, item_no)
);

-- เฉลย: แยกตารางเพื่อไม่ให้มีทางเลือกคอลัมน์ผิดแล้วหลุดไปหานักเรียน
create table acc.exercise_answer_lines (
  set_id       uuid not null,
  item_no      int  not null,
  line_no      int  not null check (line_no between 1 and 20),
  account_code text not null,
  debit        numeric(18,2) not null default 0 check (debit >= 0),
  credit       numeric(18,2) not null default 0 check (credit >= 0),
  primary key (set_id, item_no, line_no),
  foreign key (set_id, item_no) references acc.exercise_items (set_id, item_no) on delete cascade,
  check ((debit > 0) <> (credit > 0))
);

-- ---------- มอบหมาย ----------
create table acc.assignments (
  id               uuid primary key default gen_random_uuid(),
  school_id        uuid not null references acc.schools(id),
  owner_id         uuid not null references acc.users(id),
  set_id           uuid references acc.exercise_sets(id),
  classroom_id     uuid references acc.classrooms(id),
  mode             text not null check (mode in ('practice', 'submit', 'exam', 'demo')),
  title            text not null,
  company_name     text not null check (length(trim(company_name)) between 1 and 120),
  feedback         text not null default 'items' check (feedback in ('none', 'score', 'items', 'answers')),
  reveal           text not null default 'anytime' check (reveal in ('anytime', 'after_submit', 'after_release')),
  check_date       boolean not null default true,
  opens_at         timestamptz,
  closes_at        timestamptz,
  duration_minutes int check (duration_minutes between 1 and 600),
  released_at      timestamptz,
  closed_at        timestamptz,
  created_at       timestamptz not null default now(),
  check ((mode = 'demo') = (classroom_id is null)),
  check (mode = 'demo' or set_id is not null),
  check (mode <> 'exam' or (duration_minutes is not null and reveal = 'after_release')),
  check (mode in ('submit', 'exam') or reveal <> 'after_submit'),
  check (opens_at is null or closes_at is null or closes_at > opens_at)
);
create index assignments_owner on acc.assignments (owner_id, created_at desc);
create index assignments_classroom on acc.assignments (classroom_id);
create index assignments_set on acc.assignments (set_id);

alter table acc.companies add column assignment_id uuid references acc.assignments(id);
create unique index companies_assignment_owner on acc.companies (assignment_id, owner_id) where assignment_id is not null;

create table acc.exam_attempts (
  company_id    uuid primary key references acc.companies(id),
  assignment_id uuid not null references acc.assignments(id),
  started_at    timestamptz not null default now(),
  deadline      timestamptz not null,
  extra_minutes int not null default 0
);
create index exam_attempts_assignment on acc.exam_attempts (assignment_id);

create table acc.assignment_events (
  id            bigint generated always as identity primary key,
  assignment_id uuid not null references acc.assignments(id),
  company_id    uuid references acc.companies(id),
  at            timestamptz not null default now(),
  actor         uuid not null references acc.users(id),
  action        text not null check (action in ('create', 'open_companies', 'options', 'start', 'extend', 'release', 'hide', 'close', 'reopen')),
  detail        jsonb,
  client        text
);
create index assignment_events_assignment on acc.assignment_events (assignment_id, id);
create trigger assignment_events_immutable before update or delete on acc.assignment_events
  for each row execute function acc.forbid_mutation();

-- ---------- สิทธิ์ ----------
create function app.owns_exercise_set(p_set uuid) returns boolean
language sql stable security definer set search_path = acc, pg_temp as $$
  select exists (select 1 from acc.exercise_sets s join acc.users u on u.id = s.owner_id and u.active
                  where s.id = p_set and s.owner_id = app.current_user_id())
$$;

-- ครูที่สร้างงาน หรือครูประจำห้องปัจจุบัน (ผู้ดูแลย้ายครูได้)
create function app.can_manage_assignment(p_assignment uuid) returns boolean
language sql stable security definer set search_path = acc, pg_temp as $$
  select exists (select 1 from acc.assignments a join acc.users u on u.id = app.current_user_id() and u.active
                  where a.id = p_assignment and u.role = 'teacher'
                    and (a.owner_id = u.id or (a.classroom_id is not null and app.teaches(a.classroom_id))))
$$;

alter table acc.exercise_sets enable row level security;
alter table acc.exercise_items enable row level security;
alter table acc.exercise_answer_lines enable row level security;
alter table acc.assignments enable row level security;
alter table acc.exam_attempts enable row level security;
alter table acc.assignment_events enable row level security;
grant select on acc.exercise_sets, acc.exercise_items, acc.exercise_answer_lines, acc.assignments,
  acc.exam_attempts, acc.assignment_events to app_rw, app_ro;
create policy exercise_sets_owner on acc.exercise_sets for select to app_rw, app_ro using (owner_id = app.current_user_id());
create policy exercise_items_owner on acc.exercise_items for select to app_rw, app_ro using (app.owns_exercise_set(set_id));
create policy exercise_answers_owner on acc.exercise_answer_lines for select to app_rw, app_ro using (app.owns_exercise_set(set_id));
create policy assignments_teacher on acc.assignments for select to app_rw, app_ro using (app.can_manage_assignment(id));
create policy exam_attempts_read on acc.exam_attempts for select to app_rw, app_ro using (app.can_read_company(company_id));
create policy assignment_events_teacher on acc.assignment_events for select to app_rw, app_ro using (app.can_manage_assignment(assignment_id));

-- ---------- ล็อกตามงาน ----------
-- เหตุผลที่บริษัทถูกล็อก (null = เขียนได้): ส่งตรวจแล้ว · งานยังไม่เปิด · ปิดงาน/เลยกำหนด · สอบยังไม่เริ่ม · หมดเวลาสอบ
create function app.company_lock_reason(p_company uuid) returns text
language sql stable security definer set search_path = acc, pg_temp as $$
  select case
    when exists (select 1 from acc.submissions s
                  where s.company_id = p_company and s.status in ('submitted', 'reviewing', 'passed', 'closed')) then 'submitted'
    when a.id is null or a.mode = 'demo' then null
    when a.closed_at is not null then 'closed'
    when a.opens_at is not null and a.opens_at > now() then 'not_open'
    when a.mode = 'exam' and t.company_id is null then 'exam_not_started'
    when a.mode = 'exam' and t.deadline <= now() then 'exam_over'
    when a.mode <> 'exam' and a.closes_at is not null and a.closes_at <= now() then 'closed'
  end
  from (select 1) one
  left join acc.companies c on c.id = p_company
  left join acc.assignments a on a.id = c.assignment_id
  left join acc.exam_attempts t on t.company_id = c.id
$$;
grant execute on function app.company_lock_reason(uuid) to app_rw, app_ro;

create or replace function app.company_locked(p_company uuid) returns boolean
language sql stable security definer set search_path = acc, pg_temp as $$
  select app.company_lock_reason(p_company) is not null
$$;

-- app.assignment_setup = 'on' เฉพาะระหว่าง acc.open_assignment_companies สร้างผังบัญชีให้บริษัทของงานที่ยังไม่เปิด/ยังไม่เริ่มสอบ
create or replace function acc.guard_locked_company() returns trigger
language plpgsql as $$
declare v text := app.company_lock_reason(new.company_id);
begin
  if v is null or (v in ('not_open', 'exam_not_started') and current_setting('app.assignment_setup', true) = 'on') then
    return new;
  end if;
  raise exception '%', case v
      when 'submitted' then 'งานนี้ส่งตรวจแล้ว แก้ไขไม่ได้จนกว่าครูจะส่งกลับให้แก้'
      when 'exam_not_started' then 'ยังไม่ได้เริ่มสอบ กด "เริ่มสอบ" ที่หน้างานของฉันก่อน'
      when 'exam_over' then 'หมดเวลาสอบแล้ว ลงรายการเพิ่มไม่ได้'
      when 'not_open' then 'งานนี้ยังไม่ถึงเวลาเปิด'
      else 'งานนี้ปิดแล้ว แก้ไขไม่ได้' end
    using errcode = 'ACC10';
end $$;

-- ---------- บันทึกชุดโจทย์ ----------
-- p_payload: {"title","company_name","description","items":[{"date","narrative","points","lines":[{"account_code","debit","credit"}]}]}
create function acc.save_exercise_set(p_id uuid, p_version int, p_payload jsonb) returns uuid
language plpgsql security definer set search_path = acc, pg_temp as $$
declare
  v_user acc.users;
  v_id uuid := p_id;
  v_old acc.exercise_sets;
  it record; ln record;
  v_dr numeric; v_cr numeric; v_d numeric; v_c numeric; v_n int; v_pts numeric; v_total numeric := 0;
  v_date date;
begin
  select * into v_user from acc.users where id = app.current_user_id() and active;
  if not found or v_user.role <> 'teacher' then
    raise exception 'เฉพาะครูสร้างชุดโจทย์ได้' using errcode = '42501';
  end if;
  if jsonb_typeof(p_payload->'items') is distinct from 'array'
     or jsonb_array_length(p_payload->'items') not between 1 and 200 then
    raise exception 'ชุดโจทย์ต้องมี 1–200 ข้อ' using errcode = 'ACC19';
  end if;
  if length(trim(coalesce(p_payload->>'title', ''))) = 0 then
    raise exception 'ต้องมีชื่อชุดโจทย์' using errcode = 'ACC19';
  end if;
  if length(trim(coalesce(p_payload->>'company_name', ''))) = 0 then
    raise exception 'ต้องมีชื่อบริษัทของโจทย์' using errcode = 'ACC19';
  end if;

  if v_id is null then
    insert into acc.exercise_sets (school_id, owner_id, title, company_name, description)
    values (v_user.school_id, v_user.id, trim(p_payload->>'title'), trim(p_payload->>'company_name'), coalesce(p_payload->>'description', ''))
    returning id into v_id;
  else
    select * into v_old from acc.exercise_sets where id = v_id and owner_id = v_user.id for update;
    if not found then raise exception 'ไม่พบชุดโจทย์นี้' using errcode = 'ACC04'; end if;
    if v_old.version <> p_version then
      raise exception 'ชุดโจทย์ถูกแก้จากที่อื่นแล้ว โหลดหน้าใหม่' using errcode = '40001';
    end if;
    update acc.exercise_sets set title = trim(p_payload->>'title'), company_name = trim(p_payload->>'company_name'),
           description = coalesce(p_payload->>'description', ''), version = version + 1, updated_at = now()
     where id = v_id;
    delete from acc.exercise_items where set_id = v_id;
  end if;

  for it in select i.ord::int as no, i.value as j from jsonb_array_elements(p_payload->'items') with ordinality as i(value, ord) loop
    begin
      v_date := (it.j->>'date')::date;
      v_pts := coalesce(nullif(it.j->>'points', ''), '1')::numeric;
    exception when others then
      raise exception 'ข้อ %: วันที่หรือคะแนนไม่ถูกต้อง', it.no using errcode = 'ACC19';
    end;
    if v_date is null then raise exception 'ข้อ %: ต้องมีวันที่', it.no using errcode = 'ACC19'; end if;
    if v_pts <= 0 or v_pts <> round(v_pts, 2) or v_pts > 9999 then
      raise exception 'ข้อ %: คะแนนต้องมากกว่า 0 ทศนิยมไม่เกิน 2 ตำแหน่ง', it.no using errcode = 'ACC19';
    end if;
    if length(trim(coalesce(it.j->>'narrative', ''))) = 0 then
      raise exception 'ข้อ %: ต้องมีข้อความรายการค้า', it.no using errcode = 'ACC19';
    end if;
    v_total := v_total + v_pts;
    insert into acc.exercise_items (set_id, item_no, entry_date, narrative, points)
    values (v_id, it.no, v_date, trim(it.j->>'narrative'), v_pts);

    if jsonb_typeof(it.j->'lines') is distinct from 'array' or jsonb_array_length(it.j->'lines') not between 2 and 20 then
      raise exception 'ข้อ %: เฉลยต้องมี 2–20 บรรทัด', it.no using errcode = 'ACC19';
    end if;
    v_d := 0; v_c := 0; v_n := 0;
    for ln in select l.ord::int as no, l.value as j from jsonb_array_elements(it.j->'lines') with ordinality as l(value, ord) loop
      begin
        v_dr := coalesce(nullif(ln.j->>'debit', '')::numeric, 0);
        v_cr := coalesce(nullif(ln.j->>'credit', '')::numeric, 0);
      exception when invalid_text_representation then
        raise exception 'ข้อ % บรรทัด %: จำนวนเงินไม่ถูกต้อง', it.no, ln.no using errcode = 'ACC19';
      end;
      if v_dr <> round(v_dr, 2) or v_cr <> round(v_cr, 2) or v_dr < 0 or v_cr < 0 or (v_dr > 0) = (v_cr > 0)
         or v_dr >= 1e16 or v_cr >= 1e16 then
        raise exception 'ข้อ % บรรทัด %: ต้องมียอดด้านเดียว เป็นบวก ทศนิยมไม่เกิน 2 ตำแหน่ง', it.no, ln.no using errcode = 'ACC19';
      end if;
      if not exists (select 1 from acc.coa_template where code = ln.j->>'account_code') then
        raise exception 'ข้อ % บรรทัด %: ไม่มีรหัสบัญชี % ในผังบัญชีตั้งต้น', it.no, ln.no, coalesce(ln.j->>'account_code', '(ว่าง)')
          using errcode = 'ACC19';
      end if;
      insert into acc.exercise_answer_lines (set_id, item_no, line_no, account_code, debit, credit)
      values (v_id, it.no, ln.no, ln.j->>'account_code', v_dr, v_cr);
      v_d := v_d + v_dr; v_c := v_c + v_cr; v_n := v_n + 1;
    end loop;
    if v_d <> v_c then
      raise exception 'ข้อ %: เฉลยเดบิต % ไม่เท่าเครดิต % ผลต่าง %', it.no,
        to_char(v_d, 'FM999,999,999,999,990.00'), to_char(v_c, 'FM999,999,999,999,990.00'),
        to_char(abs(v_d - v_c), 'FM999,999,999,999,990.00') using errcode = 'ACC19';
    end if;
  end loop;
  if v_total > 999.99 then
    raise exception 'คะแนนรวมทั้งชุดต้องไม่เกิน 999.99 (ตอนนี้ %)', v_total using errcode = 'ACC19';
  end if;
  return v_id;
end $$;

create function acc.delete_exercise_set(p_id uuid) returns void
language plpgsql security definer set search_path = acc, pg_temp as $$
begin
  if not app.owns_exercise_set(p_id) then raise exception 'ไม่พบชุดโจทย์นี้' using errcode = 'ACC04'; end if;
  if exists (select 1 from acc.assignments where set_id = p_id) then
    raise exception 'ชุดโจทย์นี้มอบหมายแล้ว ลบไม่ได้' using errcode = 'ACC19';
  end if;
  delete from acc.exercise_sets where id = p_id;
end $$;

-- ---------- ตรวจคำตอบ ----------
-- ฟังก์ชันบริสุทธิ์ (ไม่อ่านตาราง) ทดสอบตรงได้: tests/grading.test.ts
-- p_items:   [{"no":1,"date":"2569-..","points":"1.00","key":["1110|D|100.00", ...]}]  เรียงตามข้อ
-- p_entries: [{"id":"..","doc":"JV-0001","date":"..","key":[...]}]                    เรียงตามวันที่/เลขที่
-- key = ยอดสุทธิต่อบัญชี "รหัส|D/C|จำนวน" (ลำดับไม่มีผล)
create function app.grade_match(p_items jsonb, p_entries jsonb, p_check_date boolean) returns jsonb
language plpgsql immutable set search_path = pg_temp as $$
declare
  n int := coalesce(jsonb_array_length(p_entries), 0);
  ids text[]; docs text[]; dates text[]; keys jsonb[]; used boolean[];
  it jsonb; ikey jsonb; idate text; k int; best int; best_n int; cnt int; status text;
  out jsonb := '[]'; v_score numeric := 0; v_max numeric := 0; v_ok int := 0; extras jsonb := '[]';
  sorted jsonb;
begin
  select coalesce(array_agg(e->>'id' order by ord), '{}'), coalesce(array_agg(e->>'doc' order by ord), '{}'),
         coalesce(array_agg(e->>'date' order by ord), '{}'),
         coalesce(array_agg((select coalesce(jsonb_agg(x order by x), '[]') from jsonb_array_elements_text(e->'key') x) order by ord), '{}')
    into ids, docs, dates, keys
    from jsonb_array_elements(coalesce(p_entries, '[]')) with ordinality as t(e, ord);
  used := array_fill(false, array[greatest(n, 1)]);

  for it in select value from jsonb_array_elements(coalesce(p_items, '[]')) loop
    select coalesce(jsonb_agg(x order by x), '[]') into ikey from jsonb_array_elements_text(it->'key') x;
    idate := it->>'date';
    best := null; status := 'missing';
    -- ก. ตรงทั้งบรรทัดและวันที่
    for k in 1..n loop
      if not used[k] and keys[k] = ikey and (not p_check_date or dates[k] = idate) then best := k; status := 'correct'; exit; end if;
    end loop;
    -- ข. บรรทัดตรงแต่วันที่ผิด
    if best is null and p_check_date then
      for k in 1..n loop
        if not used[k] and keys[k] = ikey then best := k; status := 'date'; exit; end if;
      end loop;
    end if;
    -- ค. ใกล้เคียงที่สุด (วันเดียวกันเมื่อตรวจวันที่) อย่างน้อย 1 บรรทัดตรง
    if best is null then
      best_n := 0;
      for k in 1..n loop
        if not used[k] and (not p_check_date or dates[k] = idate) then
          select count(*) into cnt from jsonb_array_elements_text(ikey) x where keys[k] ? x;
          if cnt > best_n then best_n := cnt; best := k; end if;
        end if;
      end loop;
      if best is not null then status := 'wrong'; end if;
    end if;

    v_max := v_max + (it->>'points')::numeric;
    if status = 'correct' then v_score := v_score + (it->>'points')::numeric; v_ok := v_ok + 1; end if;
    if best is not null then used[best] := true; end if;
    out := out || jsonb_build_object(
      'no', (it->>'no')::int,
      'status', status,
      'points', ((it->>'points')::numeric)::numeric(8,2)::text,
      'earned', (case when status = 'correct' then (it->>'points')::numeric else 0 end)::numeric(8,2)::text,
      'entryId', case when best is not null then ids[best] end,
      'docNo', case when best is not null then docs[best] end,
      'entryDate', case when best is not null then dates[best] end,
      'missing', case when status = 'wrong'
                   then (select coalesce(jsonb_agg(x order by x), '[]') from jsonb_array_elements_text(ikey) x where not keys[best] ? x)
                   else '[]' end,
      'extra', case when status = 'wrong'
                 then (select coalesce(jsonb_agg(x order by x), '[]') from jsonb_array_elements_text(keys[best]) x where not ikey ? x)
                 else '[]' end);
  end loop;

  for k in 1..n loop
    if not used[k] then extras := extras || jsonb_build_object('id', ids[k], 'docNo', docs[k], 'date', dates[k]); end if;
  end loop;
  return jsonb_build_object('items', out, 'extraEntries', extras, 'score', v_score::numeric(8,2)::text,
                            'maxScore', v_max::numeric(8,2)::text, 'correct', v_ok,
                            'total', coalesce(jsonb_array_length(p_items), 0));
end $$;
grant execute on function app.grade_match(jsonb, jsonb, boolean) to app_rw, app_ro;

-- รายการที่นับของบริษัท (ไม่นับการกลับรายการและรายการที่ถูกกลับ) เป็น key แบบเดียวกับเฉลย
create function app.company_entry_keys(p_company uuid) returns jsonb
language sql stable security definer set search_path = acc, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'doc', e.doc_no, 'date', e.entry_date::text, 'key', k.key)
                            order by e.entry_date, e.doc_no), '[]')
    from acc.journal_entries e
    cross join lateral (
      select coalesce(jsonb_agg(x order by x), '[]') as key from (
        select a.code || '|' || case when sum(l.debit - l.credit) > 0 then 'D' else 'C' end || '|'
                      || abs(sum(l.debit - l.credit))::numeric(18,2)::text as x
          from acc.journal_lines l join acc.chart_of_accounts a on a.company_id = l.company_id and a.id = l.account_id
         where l.company_id = e.company_id and l.entry_id = e.id
         group by a.code having sum(l.debit - l.credit) <> 0) s) k
   where e.company_id = p_company and e.reverses_entry_id is null
     and not exists (select 1 from acc.journal_entries r where r.company_id = e.company_id and r.reverses_entry_id = e.id)
$$;

create function app.exercise_item_keys(p_set uuid) returns jsonb
language sql stable security definer set search_path = acc, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('no', i.item_no, 'date', i.entry_date::text, 'points', i.points::text, 'key', k.key)
                            order by i.item_no), '[]')
    from acc.exercise_items i
    cross join lateral (
      select coalesce(jsonb_agg(x order by x), '[]') as key from (
        select l.account_code || '|' || case when sum(l.debit - l.credit) > 0 then 'D' else 'C' end || '|'
                      || abs(sum(l.debit - l.credit))::numeric(18,2)::text as x
          from acc.exercise_answer_lines l
         where l.set_id = i.set_id and l.item_no = i.item_no
         group by l.account_code having sum(l.debit - l.credit) <> 0) s) k
   where i.set_id = p_set
$$;

-- ผลตรวจเต็ม (มีเฉลย) ห้ามให้ app_rw เรียกตรง: ใช้ผ่าน assignment_view / assignment_overview ที่ตัดตามสิทธิ์และเวลา
create function app.grade_company(p_company uuid) returns jsonb
language sql stable security definer set search_path = acc, pg_temp as $$
  select app.grade_match(app.exercise_item_keys(a.set_id), app.company_entry_keys(c.id), a.check_date)
    from acc.companies c join acc.assignments a on a.id = c.assignment_id
   where c.id = p_company and a.set_id is not null
$$;
revoke all on function app.company_entry_keys(uuid), app.exercise_item_keys(uuid), app.grade_company(uuid) from public;

-- ---------- มอบหมาย / เปิดบริษัท ----------
create function acc.open_assignment_companies(p_assignment uuid) returns table (created int, existing int)
language plpgsql security definer set search_path = acc, pg_temp as $$
declare a acc.assignments; v_students int; v_max numeric;
begin
  select * into a from acc.assignments where id = p_assignment;
  if not found or not app.can_manage_assignment(p_assignment) then
    raise exception 'ไม่พบงานนี้' using errcode = 'ACC04';
  end if;
  select least(coalesce(sum(points), 10), 999.99) into v_max from acc.exercise_items where set_id = a.set_id;
  perform set_config('app.assignment_setup', 'on', true);

  if a.mode = 'demo' then
    v_students := 1;
    with ins as (
      insert into acc.companies (school_id, owner_id, classroom_id, name, mode, assignment_id)
      values (a.school_id, a.owner_id, null, a.company_name, 'practice', a.id)
      on conflict do nothing returning id
    ), coa as (
      insert into acc.chart_of_accounts (company_id, code, name, type)
      select ins.id, t.code, t.name, t.type from ins cross join acc.coa_template t returning 1
    )
    select count(*)::int into created from ins;
  else
    select count(*) into v_students
      from acc.enrollments e join acc.users u on u.id = e.user_id
     where e.classroom_id = a.classroom_id and u.role = 'student' and u.active;
    with ins as (
      insert into acc.companies (school_id, owner_id, classroom_id, name, mode, assignment_id)
      select a.school_id, e.user_id, a.classroom_id, a.company_name,
             case when a.mode in ('submit', 'exam') then 'submit' else 'practice' end, a.id
        from acc.enrollments e join acc.users u on u.id = e.user_id
       where e.classroom_id = a.classroom_id and u.role = 'student' and u.active
      on conflict do nothing
      returning id
    ), coa as (
      insert into acc.chart_of_accounts (company_id, code, name, type)
      select ins.id, t.code, t.name, t.type from ins cross join acc.coa_template t returning 1
    ), sub as (
      insert into acc.submissions (company_id, max_score)
      select id, v_max from ins where a.mode in ('submit', 'exam') returning 1
    )
    select count(*)::int into created from ins;
  end if;
  perform set_config('app.assignment_setup', '', true);
  existing := v_students - created;
  if created > 0 then
    insert into acc.assignment_events (assignment_id, actor, action, detail, client)
    values (a.id, app.current_user_id(), 'open_companies', jsonb_build_object('created', created),
            nullif(current_setting('app.client_info', true), ''));
  end if;
  return next;
end $$;

-- p_opts: {"mode","company_name","feedback","reveal","check_date","opens_at","closes_at","duration_minutes"}
create function acc.create_assignment(p_set uuid, p_classroom uuid, p_opts jsonb) returns uuid
language plpgsql security definer set search_path = acc, pg_temp as $$
declare
  v_user acc.users; s acc.exercise_sets; v_id uuid;
  v_mode text := coalesce(p_opts->>'mode', 'practice');
  v_name text; v_reveal text; v_feedback text := coalesce(p_opts->>'feedback', 'items');
begin
  select * into v_user from acc.users where id = app.current_user_id() and active;
  if not found or v_user.role <> 'teacher' then raise exception 'เฉพาะครูมอบหมายงานได้' using errcode = '42501'; end if;
  if v_mode not in ('practice', 'submit', 'exam', 'demo') then raise exception 'โหมดไม่ถูกต้อง' using errcode = '22023'; end if;
  if p_set is not null then
    select * into s from acc.exercise_sets where id = p_set and owner_id = v_user.id;
    if not found then raise exception 'ไม่พบชุดโจทย์นี้' using errcode = 'ACC04'; end if;
  elsif v_mode <> 'demo' then
    raise exception 'ต้องเลือกชุดโจทย์' using errcode = 'ACC19';
  end if;
  if v_mode = 'demo' then
    if p_classroom is not null then raise exception 'บริษัทสาธิตเป็นของครู ไม่ผูกกับห้อง' using errcode = '22023'; end if;
  elsif p_classroom is null or not app.teaches(p_classroom) then
    raise exception 'ไม่มีสิทธิ์มอบหมายงานในห้องนี้' using errcode = '42501';
  end if;

  v_name := trim(coalesce(nullif(trim(p_opts->>'company_name'), ''), s.company_name, ''));
  if v_name = '' then raise exception 'ต้องมีชื่อบริษัท' using errcode = 'ACC19'; end if;
  if p_classroom is not null and exists (select 1 from acc.companies where classroom_id = p_classroom and name = v_name) then
    raise exception 'ห้องนี้มีบริษัทชื่อ "%" อยู่แล้ว ตั้งชื่อบริษัทของงานนี้ใหม่', v_name using errcode = 'ACC19';
  end if;
  v_reveal := case when v_mode = 'exam' then 'after_release' else coalesce(p_opts->>'reveal', 'anytime') end;
  if v_mode = 'exam' and nullif(p_opts->>'duration_minutes', '') is null then
    raise exception 'การสอบต้องกำหนดเวลาสอบ (นาที)' using errcode = 'ACC19';
  end if;
  if v_reveal = 'after_submit' and v_mode not in ('submit', 'exam') then
    raise exception 'โหมดฝึกหัดไม่มีการส่งตรวจ เลือกแสดงผลทันทีหรือเมื่อครูเปิดเฉลย' using errcode = 'ACC19';
  end if;

  insert into acc.assignments (school_id, owner_id, set_id, classroom_id, mode, title, company_name, feedback, reveal,
                               check_date, opens_at, closes_at, duration_minutes)
  values (v_user.school_id, v_user.id, p_set, p_classroom, v_mode, coalesce(s.title, v_name), v_name, v_feedback, v_reveal,
          coalesce((p_opts->>'check_date')::boolean, true), nullif(p_opts->>'opens_at', '')::timestamptz,
          nullif(p_opts->>'closes_at', '')::timestamptz,
          case when v_mode = 'exam' then (p_opts->>'duration_minutes')::int end)
  returning id into v_id;
  insert into acc.assignment_events (assignment_id, actor, action, detail, client)
  values (v_id, v_user.id, 'create', p_opts, nullif(current_setting('app.client_info', true), ''));
  perform acc.open_assignment_companies(v_id);
  return v_id;
end $$;

create function acc.set_assignment_options(p_assignment uuid, p_opts jsonb) returns void
language plpgsql security definer set search_path = acc, pg_temp as $$
declare a acc.assignments; v_reveal text;
begin
  select * into a from acc.assignments where id = p_assignment for update;
  if not found or not app.can_manage_assignment(p_assignment) then raise exception 'ไม่พบงานนี้' using errcode = 'ACC04'; end if;
  v_reveal := case when a.mode = 'exam' then 'after_release' else coalesce(p_opts->>'reveal', a.reveal) end;
  if v_reveal = 'after_submit' and a.mode not in ('submit', 'exam') then
    raise exception 'โหมดฝึกหัดไม่มีการส่งตรวจ เลือกแสดงผลทันทีหรือเมื่อครูเปิดเฉลย' using errcode = 'ACC19';
  end if;
  update acc.assignments set feedback = coalesce(p_opts->>'feedback', feedback), reveal = v_reveal,
         check_date = coalesce((p_opts->>'check_date')::boolean, check_date)
   where id = p_assignment;
  insert into acc.assignment_events (assignment_id, actor, action, detail, client)
  values (a.id, app.current_user_id(), 'options', p_opts, nullif(current_setting('app.client_info', true), ''));
end $$;

-- เปิด/ซ่อนเฉลย, ปิด/เปิดงานอีกครั้ง
create function acc.assignment_action(p_assignment uuid, p_action text) returns void
language plpgsql security definer set search_path = acc, pg_temp as $$
declare a acc.assignments;
begin
  select * into a from acc.assignments where id = p_assignment for update;
  if not found or not app.can_manage_assignment(p_assignment) then raise exception 'ไม่พบงานนี้' using errcode = 'ACC04'; end if;
  case p_action
    when 'release' then update acc.assignments set released_at = coalesce(released_at, now()) where id = a.id;
    when 'hide' then update acc.assignments set released_at = null where id = a.id;
    when 'close' then update acc.assignments set closed_at = coalesce(closed_at, now()) where id = a.id;
    when 'reopen' then update acc.assignments set closed_at = null where id = a.id;
    else raise exception 'ไม่รู้จักการกระทำ %', p_action using errcode = '22023';
  end case;
  insert into acc.assignment_events (assignment_id, actor, action, client)
  values (a.id, app.current_user_id(), p_action, nullif(current_setting('app.client_info', true), ''));
end $$;

-- ---------- สอบ ----------
-- เพิกถอนเซสชันอื่นของผู้ใช้ที่กำลังสอบ (1 เซสชันต่อคน) เรียกตอนล็อกอินและตอนเริ่มสอบ
create function app.exam_single_session(p_user uuid, p_keep_token_hash text) returns int
language plpgsql security definer set search_path = acc, pg_temp as $$
declare n int := 0;
begin
  if p_keep_token_hash is null then return 0; end if;
  if exists (select 1 from acc.exam_attempts t join acc.companies c on c.id = t.company_id
               join acc.assignments a on a.id = t.assignment_id
              where c.owner_id = p_user and t.deadline > now() and a.closed_at is null) then
    update acc.sessions set revoked_at = now(), revoked_reason = 'exam_single'
     where user_id = p_user and revoked_at is null and token_hash <> p_keep_token_hash;
    get diagnostics n = row_count;
  end if;
  return n;
end $$;

create function acc.start_exam(p_company uuid, p_keep_token_hash text) returns timestamptz
language plpgsql security definer set search_path = acc, pg_temp as $$
declare a acc.assignments; t acc.exam_attempts; v_deadline timestamptz;
begin
  if not app.can_write_company(p_company) then raise exception 'เฉพาะเจ้าของงานเริ่มสอบได้' using errcode = '42501'; end if;
  select a2.* into a from acc.companies c join acc.assignments a2 on a2.id = c.assignment_id where c.id = p_company;
  if not found or a.mode <> 'exam' then raise exception 'บริษัทนี้ไม่ใช่การสอบ' using errcode = 'ACC20'; end if;
  select * into t from acc.exam_attempts where company_id = p_company;
  if found then return t.deadline; end if;
  if a.closed_at is not null then raise exception 'ครูปิดการสอบนี้แล้ว' using errcode = 'ACC20'; end if;
  if a.opens_at is not null and a.opens_at > now() then
    raise exception 'ยังไม่ถึงเวลาเริ่มสอบ เริ่มได้ %', to_char(a.opens_at at time zone 'Asia/Bangkok', 'DD/MM HH24:MI')
      using errcode = 'ACC20';
  end if;
  if a.closes_at is not null and a.closes_at <= now() then raise exception 'หมดเวลารับเข้าสอบแล้ว' using errcode = 'ACC20'; end if;
  v_deadline := now() + make_interval(mins => a.duration_minutes);
  if a.closes_at is not null and a.closes_at < v_deadline then v_deadline := a.closes_at; end if;
  insert into acc.exam_attempts (company_id, assignment_id, deadline) values (p_company, a.id, v_deadline)
  on conflict (company_id) do nothing;
  select * into t from acc.exam_attempts where company_id = p_company;
  insert into acc.assignment_events (assignment_id, company_id, actor, action, detail, client)
  values (a.id, p_company, app.current_user_id(), 'start', jsonb_build_object('deadline', t.deadline),
          nullif(current_setting('app.client_info', true), ''));
  perform app.exam_single_session(app.current_user_id(), p_keep_token_hash);
  return t.deadline;
end $$;

-- เพิ่มเวลา: นับจากเวลาหมดเดิมหรือจากตอนนี้ (ถ้าหมดไปแล้ว) · p_company null = ทุกคนที่เริ่มแล้ว
create function acc.extend_exam(p_assignment uuid, p_company uuid, p_minutes int) returns int
language plpgsql security definer set search_path = acc, pg_temp as $$
declare n int;
begin
  if not app.can_manage_assignment(p_assignment) then raise exception 'ไม่พบงานนี้' using errcode = 'ACC04'; end if;
  if p_minutes is null or p_minutes not between 1 and 600 then
    raise exception 'เพิ่มเวลาได้ 1–600 นาที' using errcode = 'ACC19';
  end if;
  update acc.exam_attempts set deadline = greatest(deadline, now()) + make_interval(mins => p_minutes),
         extra_minutes = extra_minutes + p_minutes
   where assignment_id = p_assignment and (p_company is null or company_id = p_company);
  get diagnostics n = row_count;
  insert into acc.assignment_events (assignment_id, company_id, actor, action, detail, client)
  values (p_assignment, p_company, app.current_user_id(), 'extend', jsonb_build_object('minutes', p_minutes, 'attempts', n),
          nullif(current_setting('app.client_info', true), ''));
  return n;
end $$;

-- ---------- มุมมอง ----------
-- สถานะงานสั้น ๆ ของบริษัท (แถบบน/นาฬิกาสอบ) ไม่มีข้อมูลโจทย์
create function app.company_assignment(p_company uuid) returns jsonb
language sql stable security definer set search_path = acc, pg_temp as $$
  select jsonb_build_object('id', a.id, 'mode', a.mode, 'title', a.title, 'startedAt', t.started_at, 'deadline', t.deadline,
                            'closesAt', a.closes_at, 'lockReason', app.company_lock_reason(c.id), 'now', now())
    from acc.companies c join acc.assignments a on a.id = c.assignment_id
    left join acc.exam_attempts t on t.company_id = c.id
   where c.id = p_company and app.can_read_company(p_company)
$$;

-- โจทย์ + ผลตรวจของบริษัทหนึ่ง ตัดตามผู้ดู/เวลา/การตั้งค่า (จุดเดียวที่นักเรียนเห็นโจทย์และเฉลย)
create function acc.assignment_view(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = acc, pg_temp as $$
declare
  c acc.companies; a acc.assignments; t acc.exam_attempts;
  v_full boolean; v_open boolean; v_items_visible boolean; v_level text; v_hidden text; v_status text;
  g jsonb; v_items jsonb; v_result jsonb;
begin
  select * into c from acc.companies where id = p_company;
  if not found or not app.can_read_company(p_company) then raise exception 'ไม่พบบริษัทนี้' using errcode = 'ACC04'; end if;
  select * into a from acc.assignments where id = c.assignment_id;
  if not found then return null; end if;
  select * into t from acc.exam_attempts where company_id = c.id;
  select status into v_status from acc.submissions where company_id = c.id;
  v_full := app.can_manage_assignment(a.id);
  v_open := a.opens_at is null or a.opens_at <= now();
  v_items_visible := v_full or (v_open and (a.mode <> 'exam' or t.company_id is not null));

  if v_items_visible and a.set_id is not null then
    select coalesce(jsonb_agg(jsonb_build_object('no', i.item_no, 'date', i.entry_date::text, 'narrative', i.narrative,
             'points', i.points::text,
             'answer', case when v_full then (select jsonb_agg(jsonb_build_object('code', l.account_code, 'debit', l.debit::text,
                                                    'credit', l.credit::text) order by l.line_no)
                                                from acc.exercise_answer_lines l where l.set_id = i.set_id and l.item_no = i.item_no) end)
             order by i.item_no), '[]')
      into v_items from acc.exercise_items i where i.set_id = a.set_id;
  end if;

  -- ระดับผลที่นักเรียนเห็น
  if v_full then
    v_level := 'answers';
  elsif a.feedback = 'none' then
    v_hidden := 'teacher_only';
  elsif a.released_at is not null or a.reveal = 'anytime'
        or (a.reveal = 'after_submit' and v_status in ('submitted', 'reviewing', 'returned', 'passed', 'closed')) then
    v_level := a.feedback;
  else
    v_hidden := a.reveal;
  end if;
  if a.mode = 'exam' and not v_full and t.company_id is null then v_level := null; v_hidden := coalesce(v_hidden, 'after_release'); end if;

  if v_level is not null and a.set_id is not null then
    g := app.grade_company(c.id);
    v_result := jsonb_build_object('level', v_level, 'score', g->'score', 'maxScore', g->'maxScore', 'correct', g->'correct', 'total', g->'total');
    if v_level in ('items', 'answers') then
      v_result := v_result || jsonb_build_object('items', (
        select coalesce(jsonb_agg(case when v_level = 'answers' then x
                                       else x - 'missing' - 'extra' end order by (x->>'no')::int), '[]')
          from jsonb_array_elements(g->'items') x));
    end if;
    if v_level = 'answers' then
      v_result := v_result || jsonb_build_object('extraEntries', g->'extraEntries', 'answers', (
        select coalesce(jsonb_agg(jsonb_build_object('no', i.item_no, 'lines',
                 (select jsonb_agg(jsonb_build_object('code', l.account_code, 'debit', l.debit::text, 'credit', l.credit::text) order by l.line_no)
                    from acc.exercise_answer_lines l where l.set_id = i.set_id and l.item_no = i.item_no)) order by i.item_no), '[]')
          from acc.exercise_items i where i.set_id = a.set_id));
    end if;
  end if;

  return jsonb_build_object(
    'assignment', jsonb_build_object('id', a.id, 'mode', a.mode, 'title', a.title, 'feedback', a.feedback, 'reveal', a.reveal,
       'checkDate', a.check_date, 'opensAt', a.opens_at, 'closesAt', a.closes_at, 'durationMinutes', a.duration_minutes,
       'releasedAt', a.released_at, 'closedAt', a.closed_at),
    'attempt', case when t.company_id is not null then jsonb_build_object('startedAt', t.started_at, 'deadline', t.deadline) end,
    'now', now(),
    'lockReason', app.company_lock_reason(c.id),
    'viewer', case when v_full then 'teacher' else 'student' end,
    'itemsVisible', v_items_visible,
    'items', v_items,
    'result', v_result,
    'resultHidden', v_hidden);
end $$;

-- ภาพรวมงานสำหรับครู: คะแนนรายคน + สถานะรายข้อ
create function acc.assignment_overview(p_assignment uuid) returns jsonb
language plpgsql stable security definer set search_path = acc, pg_temp as $$
declare a acc.assignments; v_students jsonb; v_items jsonb;
begin
  select * into a from acc.assignments where id = p_assignment;
  if not found or not app.can_manage_assignment(p_assignment) then raise exception 'ไม่พบงานนี้' using errcode = 'ACC04'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('no', i.item_no, 'date', i.entry_date::text, 'narrative', i.narrative, 'points', i.points::text)
                            order by i.item_no), '[]')
    into v_items from acc.exercise_items i where i.set_id = a.set_id;

  select coalesce(jsonb_agg(x order by x->>'studentCode'), '[]') into v_students from (
    select jsonb_build_object(
             'studentId', u.id, 'studentCode', u.student_code, 'name', u.display_name,
             'companyId', c.id, 'companyName', c.name, 'status', s.status,
             'teacherScore', s.score::text, 'maxScore', s.max_score::text,
             'startedAt', t.started_at, 'deadline', t.deadline, 'extraMinutes', t.extra_minutes,
             'lockReason', case when c.id is not null then app.company_lock_reason(c.id) end,
             'entries', (select count(*) from acc.journal_entries e where e.company_id = c.id),
             'grade', case when c.id is not null and a.set_id is not null then
                        (select jsonb_build_object('score', g->'score', 'maxScore', g->'maxScore', 'correct', g->'correct',
                                  'items', (select jsonb_agg(jsonb_build_object('no', y->'no', 'status', y->'status', 'earned', y->'earned')
                                                             order by (y->>'no')::int) from jsonb_array_elements(g->'items') y),
                                  'extra', jsonb_array_length(g->'extraEntries'))
                           from app.grade_company(c.id) g) end) as x
      from (select e.user_id from acc.enrollments e join acc.users u2 on u2.id = e.user_id and u2.role = 'student'
             where e.classroom_id = a.classroom_id
            union select c2.owner_id from acc.companies c2 where c2.assignment_id = a.id) m
      join acc.users u on u.id = m.user_id
      left join acc.companies c on c.assignment_id = a.id and c.owner_id = u.id
      left join acc.submissions s on s.company_id = c.id
      left join acc.exam_attempts t on t.company_id = c.id
  ) z;

  return jsonb_build_object(
    'assignment', jsonb_build_object('id', a.id, 'mode', a.mode, 'title', a.title, 'companyName', a.company_name, 'setId', a.set_id,
       'classroomId', a.classroom_id, 'classroom', (select name from acc.classrooms where id = a.classroom_id),
       'feedback', a.feedback, 'reveal', a.reveal, 'checkDate', a.check_date, 'opensAt', a.opens_at, 'closesAt', a.closes_at,
       'durationMinutes', a.duration_minutes, 'releasedAt', a.released_at, 'closedAt', a.closed_at, 'createdAt', a.created_at),
    'items', v_items, 'students', v_students, 'now', now());
end $$;

revoke all on function app.owns_exercise_set(uuid), app.can_manage_assignment(uuid), acc.save_exercise_set(uuid, int, jsonb),
  acc.delete_exercise_set(uuid), acc.open_assignment_companies(uuid), acc.create_assignment(uuid, uuid, jsonb),
  acc.set_assignment_options(uuid, jsonb), acc.assignment_action(uuid, text), app.exam_single_session(uuid, text),
  acc.start_exam(uuid, text), acc.extend_exam(uuid, uuid, int), app.company_assignment(uuid), acc.assignment_view(uuid),
  acc.assignment_overview(uuid) from public;
grant execute on function app.owns_exercise_set(uuid), app.can_manage_assignment(uuid) to app_rw, app_ro;
grant execute on function acc.save_exercise_set(uuid, int, jsonb), acc.delete_exercise_set(uuid), acc.open_assignment_companies(uuid),
  acc.create_assignment(uuid, uuid, jsonb), acc.set_assignment_options(uuid, jsonb), acc.assignment_action(uuid, text),
  app.exam_single_session(uuid, text), acc.start_exam(uuid, text), acc.extend_exam(uuid, uuid, int), app.company_assignment(uuid),
  acc.assignment_view(uuid), acc.assignment_overview(uuid) to app_rw;

-- migrate:down
drop function acc.assignment_overview(uuid), acc.assignment_view(uuid), app.company_assignment(uuid), acc.extend_exam(uuid, uuid, int),
  acc.start_exam(uuid, text), app.exam_single_session(uuid, text), acc.assignment_action(uuid, text), acc.set_assignment_options(uuid, jsonb),
  acc.create_assignment(uuid, uuid, jsonb), acc.open_assignment_companies(uuid), app.grade_company(uuid), app.exercise_item_keys(uuid),
  app.company_entry_keys(uuid), app.grade_match(jsonb, jsonb, boolean), acc.delete_exercise_set(uuid), acc.save_exercise_set(uuid, int, jsonb);
create or replace function app.company_locked(p_company uuid) returns boolean
language sql stable security definer set search_path = acc, pg_temp as $$
  select exists (select 1 from acc.submissions
                  where company_id = p_company and status in ('submitted', 'reviewing', 'passed', 'closed'))
$$;
create or replace function acc.guard_locked_company() returns trigger
language plpgsql as $$
begin
  if app.company_locked(new.company_id) then
    raise exception 'งานนี้ส่งตรวจแล้ว แก้ไขไม่ได้จนกว่าครูจะส่งกลับให้แก้' using errcode = 'ACC10';
  end if;
  return new;
end $$;
drop function app.company_lock_reason(uuid);
drop table acc.assignment_events, acc.exam_attempts;
drop index acc.companies_assignment_owner;
alter table acc.companies drop column assignment_id;
drop table acc.assignments, acc.exercise_answer_lines, acc.exercise_items, acc.exercise_sets;
drop function app.can_manage_assignment(uuid), app.owns_exercise_set(uuid);
