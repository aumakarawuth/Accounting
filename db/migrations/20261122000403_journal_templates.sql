-- migrate:up
-- แม่แบบรายการ / รายการประจำเดือน (docs/phase7-spec.md ข้อ 5, docs/assumptions.md ข้อ 62)
-- ใช้ซ้ำ = ลง JV ผ่าน acc.post_journal ตอนนักเรียนกดยืนยันเท่านั้น (ไม่มีงานเบื้องหลังลงให้)
-- รายการประจำ: เดือนละครั้งต่อแม่แบบ · รายการที่ลงแล้วถูกกลับรายการ = เดือนนั้นกลับมาค้าง

create table acc.journal_templates (
  id           uuid not null default gen_random_uuid(),
  company_id   uuid not null references acc.companies(id),
  name         text not null check (length(btrim(name)) between 1 and 120),
  description  text not null check (length(btrim(description)) between 1 and 300),
  lines        jsonb not null check (jsonb_typeof(lines) = 'array'),
  recurring    boolean not null default false,
  day_of_month smallint check (day_of_month between 1 and 31),
  start_month  date check (start_month = date_trunc('month', start_month)::date),
  active       boolean not null default true,
  version      int not null default 1,
  created_by   uuid not null references acc.users(id),
  created_at   timestamptz not null default now(),
  primary key (company_id, id),
  check (recurring = (day_of_month is not null and start_month is not null))
);
create unique index journal_templates_name on acc.journal_templates (company_id, lower(name)) where active;

create table acc.template_postings (
  company_id  uuid not null references acc.companies(id),
  template_id uuid not null,
  entry_id    uuid not null,
  month       date check (month = date_trunc('month', month)::date),  -- เดือนของรายการประจำ (null = ใช้แม่แบบทั่วไป)
  created_at  timestamptz not null default now(),
  primary key (company_id, entry_id),
  foreign key (company_id, template_id) references acc.journal_templates (company_id, id),
  foreign key (company_id, entry_id) references acc.journal_entries (company_id, id)
);
create index template_postings_month on acc.template_postings (company_id, template_id, month);

create trigger journal_templates_locked before insert or update on acc.journal_templates for each row execute function acc.guard_locked_company();
create trigger journal_templates_no_delete before delete on acc.journal_templates for each row execute function acc.forbid_mutation();
create trigger audit_journal_templates after insert or update on acc.journal_templates for each row execute function acc.audit_row();
create trigger template_postings_locked before insert or update on acc.template_postings for each row execute function acc.guard_locked_company();
create trigger template_postings_immutable before update or delete on acc.template_postings for each row execute function acc.forbid_mutation();
alter table acc.journal_templates enable row level security;
alter table acc.template_postings enable row level security;
grant select on acc.journal_templates, acc.template_postings to app_rw, app_ro;
create policy journal_templates_read on acc.journal_templates for select to app_rw, app_ro using (company_id in (select app.readable_company_ids()));
create policy template_postings_read on acc.template_postings for select to app_rw, app_ro using (company_id in (select app.readable_company_ids()));

-- บรรทัดแม่แบบ: 2–50 บรรทัด ด้านเดียว บวก ทศนิยม 2 ตำแหน่ง เดบิตรวม = เครดิตรวม บัญชีมีในผังและเปิดใช้ · คืนบรรทัดรูปแบบเดียวกับ post_journal
create function acc.normalize_template_lines(p_company uuid, p_lines jsonb) returns jsonb
language plpgsql stable security definer set search_path = acc, pg_temp as $$
declare x jsonb; v_out jsonb := '[]'; v_dr numeric; v_cr numeric; v_d numeric := 0; v_c numeric := 0; v_n int := 0;
begin
  if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) not between 2 and 50 then
    raise exception 'แม่แบบต้องมี 2–50 บรรทัด' using errcode = 'ACC05';
  end if;
  for x in select * from jsonb_array_elements(p_lines) loop
    v_n := v_n + 1;
    begin v_dr := coalesce(nullif(x->>'debit', '')::numeric, 0); v_cr := coalesce(nullif(x->>'credit', '')::numeric, 0);
    exception when others then raise exception 'บรรทัด %: จำนวนเงินไม่ถูกต้อง', v_n using errcode = 'ACC05'; end;
    if v_dr < 0 or v_cr < 0 or (v_dr > 0) = (v_cr > 0) or v_dr <> round(v_dr, 2) or v_cr <> round(v_cr, 2) then
      raise exception 'บรรทัด %: ต้องมียอดด้านเดียว เป็นบวก ทศนิยมไม่เกิน 2 ตำแหน่ง', v_n using errcode = 'ACC05';
    end if;
    if not exists (select 1 from acc.chart_of_accounts where company_id = p_company and code = x->>'account_code' and active) then
      raise exception 'บรรทัด %: ไม่มีรหัสบัญชี % ในผังบัญชี (หรือปิดใช้)', v_n, coalesce(x->>'account_code', '(ว่าง)') using errcode = 'ACC04';
    end if;
    v_out := v_out || jsonb_build_object('account_code', x->>'account_code', 'debit', v_dr::numeric(18,2)::text, 'credit', v_cr::numeric(18,2)::text,
      'memo', left(coalesce(x->>'memo', ''), 200));
    v_d := v_d + v_dr; v_c := v_c + v_cr;
  end loop;
  if v_d <> v_c then
    raise exception 'เดบิต % ไม่เท่าเครดิต % ผลต่าง %', to_char(v_d, 'FM999,999,999,990.00'), to_char(v_c, 'FM999,999,999,990.00'),
      to_char(abs(v_d - v_c), 'FM999,999,999,990.00') using errcode = 'ACC01';
  end if;
  return v_out;
end $$;

-- บันทึกแม่แบบ · p: {name, description?, lines? | from_entry?, recurring, day_of_month?, start_month?, active?} · p_id null = สร้างใหม่
create function acc.save_journal_template(p_company uuid, p_id uuid, p jsonb, p_version int) returns uuid
language plpgsql security definer set search_path = acc, pg_temp as $$
declare v_id uuid; v_lines jsonb; v_desc text := nullif(btrim(coalesce(p->>'description', '')), ''); e acc.journal_entries;
  v_rec boolean := coalesce((p->>'recurring')::boolean, false); v_day smallint; v_start date; t acc.journal_templates;
begin
  if not app.can_write_company(p_company) then raise exception 'ไม่มีสิทธิ์แก้ข้อมูลบริษัทนี้' using errcode = '42501'; end if;
  if p_id is not null then
    select * into t from acc.journal_templates where company_id = p_company and id = p_id for update;
    if not found then raise exception 'ไม่พบแม่แบบ' using errcode = 'ACC04'; end if;
    if t.version <> p_version then raise exception 'แม่แบบถูกแก้จากที่อื่นแล้ว โหลดหน้าใหม่' using errcode = '40001'; end if;
  end if;
  if nullif(p->>'from_entry', '') is not null then
    select * into e from acc.journal_entries where company_id = p_company and id = (p->>'from_entry')::uuid;
    if not found then raise exception 'ไม่พบรายการที่จะใช้เป็นแม่แบบ' using errcode = 'ACC04'; end if;
    select jsonb_agg(jsonb_build_object('account_code', a.code, 'debit', l.debit::text, 'credit', l.credit::text, 'memo', coalesce(l.memo, '')) order by l.line_no)
      into v_lines from acc.journal_lines l join acc.chart_of_accounts a on a.company_id = l.company_id and a.id = l.account_id
     where l.company_id = p_company and l.entry_id = e.id;
    v_desc := coalesce(v_desc, e.description);
  else
    v_lines := coalesce(p->'lines', t.lines);
  end if;
  v_lines := acc.normalize_template_lines(p_company, v_lines);
  v_desc := coalesce(v_desc, t.description, btrim(p->>'name'));
  if v_rec then
    begin v_day := coalesce(nullif(p->>'day_of_month', '')::smallint, t.day_of_month);
      v_start := date_trunc('month', coalesce(nullif(p->>'start_month', '')::date, t.start_month))::date;
    exception when others then raise exception 'วันที่ของเดือนหรือเดือนเริ่มไม่ถูกต้อง' using errcode = '22023'; end;
    if v_day is null or v_day not between 1 and 31 or v_start is null then
      raise exception 'รายการประจำต้องระบุวันที่ของเดือน (1–31) และเดือนเริ่ม' using errcode = '22023';
    end if;
  end if;
  if length(btrim(coalesce(p->>'name', ''))) not between 1 and 120 then raise exception 'ต้องมีชื่อแม่แบบ' using errcode = '22023'; end if;
  if exists (select 1 from acc.journal_templates where company_id = p_company and active and lower(name) = lower(btrim(p->>'name'))
               and id is distinct from p_id) then
    raise exception 'มีแม่แบบชื่อ "%" แล้ว', btrim(p->>'name') using errcode = '23505';
  end if;
  if p_id is null then
    insert into acc.journal_templates (company_id, name, description, lines, recurring, day_of_month, start_month, created_by)
    values (p_company, btrim(p->>'name'), left(v_desc, 300), v_lines, v_rec, case when v_rec then v_day end, case when v_rec then v_start end, app.current_user_id())
    returning id into v_id;
  else
    update acc.journal_templates set name = btrim(p->>'name'), description = left(v_desc, 300), lines = v_lines, recurring = v_rec,
           day_of_month = case when v_rec then v_day end, start_month = case when v_rec then v_start end,
           active = coalesce((p->>'active')::boolean, active), version = version + 1
     where company_id = p_company and id = p_id returning id into v_id;
  end if;
  return v_id;
end $$;

-- เดือนนี้ของแม่แบบลงแล้ว (รายการที่ยังไม่ถูกกลับรายการ)
create function acc.template_posted(p_company uuid, p_template uuid, p_month date) returns uuid
language sql stable security definer set search_path = acc, pg_temp as $$
  select tp.entry_id from acc.template_postings tp
   where tp.company_id = p_company and tp.template_id = p_template and tp.month = p_month and app.can_read_company(p_company)
     and not exists (select 1 from acc.journal_entries r where r.company_id = tp.company_id and r.reverses_entry_id = tp.entry_id)
   order by tp.created_at desc limit 1
$$;

-- ลงรายการจากแม่แบบ · p: {date, lines? (แก้ยอดได้), month? (รายการประจำ: เดือนที่ลง ค่าเริ่มต้น = เดือนของวันที่)}
create function acc.post_template(p_company uuid, p_template uuid, p jsonb, p_idem text) returns uuid
language plpgsql security definer set search_path = acc, pg_temp as $$
declare t acc.journal_templates; v_date date; v_month date; v_lines jsonb; v_eid uuid; v_old uuid;
begin
  if not app.can_write_company(p_company) then raise exception 'ไม่มีสิทธิ์บันทึกรายการในบริษัทนี้' using errcode = '42501'; end if;
  select entry_id into v_eid from acc.idempotency_keys where company_id = p_company and key = p_idem;
  if found and v_eid is not null then return v_eid; end if;
  select * into t from acc.journal_templates where company_id = p_company and id = p_template for update;
  if not found then raise exception 'ไม่พบแม่แบบ' using errcode = 'ACC04'; end if;
  if not t.active then raise exception 'แม่แบบ "%" เลิกใช้แล้ว', t.name using errcode = '22023'; end if;
  begin v_date := (p->>'date')::date; v_month := date_trunc('month', coalesce(nullif(p->>'month', '')::date, v_date))::date;
  exception when others then raise exception 'วันที่ไม่ถูกต้อง' using errcode = '22023'; end;
  if v_date is null then raise exception 'ต้องระบุวันที่' using errcode = '22023'; end if;
  v_lines := acc.normalize_template_lines(p_company, coalesce(p->'lines', t.lines));
  if t.recurring then
    if v_month < t.start_month then raise exception 'รายการประจำ "%" เริ่มเดือน %', t.name, to_char(t.start_month, 'MM/YYYY') using errcode = '22023'; end if;
    v_old := acc.template_posted(p_company, t.id, v_month);
    if v_old is not null then
      raise exception 'รายการประจำ "%" ของเดือนนี้ลงแล้ว (%) กลับรายการเดิมก่อนถ้าจะลงใหม่', t.name,
        (select doc_no from acc.journal_entries where company_id = p_company and id = v_old) using errcode = 'ACC16';
    end if;
  end if;
  v_eid := acc.post_journal(p_company, v_date, t.description, v_lines, p_idem, 'JV', null);
  insert into acc.template_postings (company_id, template_id, entry_id, month) values (p_company, t.id, v_eid, case when t.recurring then v_month end);
  return v_eid;
end $$;

-- รายการประจำที่ถึงกำหนดในเดือนแต่ยังไม่ลง (วันที่เกินวันสุดท้ายของเดือน = วันสุดท้าย)
create function acc.templates_due(p_company uuid, p_month date)
returns table (template_id uuid, name text, due_date date)
language sql stable security definer set search_path = acc, pg_temp as $$
  select t.id, t.name,
         least(date_trunc('month', p_month)::date + (t.day_of_month - 1), (date_trunc('month', p_month) + interval '1 month - 1 day')::date)
    from acc.journal_templates t
   where t.company_id = p_company and app.can_read_company(p_company) and t.active and t.recurring
     and t.start_month <= date_trunc('month', p_month)::date
     and acc.template_posted(p_company, t.id, date_trunc('month', p_month)::date) is null
   order by 3, t.name
$$;

revoke all on function acc.normalize_template_lines(uuid, jsonb), acc.save_journal_template(uuid, uuid, jsonb, int), acc.template_posted(uuid, uuid, date),
  acc.post_template(uuid, uuid, jsonb, text), acc.templates_due(uuid, date) from public;
grant execute on function acc.template_posted(uuid, uuid, date), acc.templates_due(uuid, date) to app_rw, app_ro;
grant execute on function acc.save_journal_template(uuid, uuid, jsonb, int), acc.post_template(uuid, uuid, jsonb, text) to app_rw;

-- migrate:down
drop function acc.templates_due(uuid, date), acc.post_template(uuid, uuid, jsonb, text), acc.template_posted(uuid, uuid, date),
  acc.save_journal_template(uuid, uuid, jsonb, int), acc.normalize_template_lines(uuid, jsonb);
drop table acc.template_postings, acc.journal_templates;
