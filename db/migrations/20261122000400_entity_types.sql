-- migrate:up
-- ประเภทกิจการ: เจ้าของคนเดียว (เดิม) · ห้างหุ้นส่วน · บริษัทจำกัด (docs/phase7-spec.md ข้อ 1, docs/assumptions.md ข้อ 58)
-- บริษัทเดิมทั้งหมดเป็น sole และทำงานเหมือนเดิม · ทุกรายการลงผ่าน acc.post_journal · ยกเลิกด้วยกลับรายการ

alter table acc.companies
  add column entity_type text not null default 'sole' check (entity_type in ('sole', 'partnership', 'company')),
  add column entity jsonb not null default '{}'::jsonb,
  add column par_value numeric(18,2) check (par_value > 0),
  add column registered_shares bigint check (registered_shares > 0);
alter table acc.exercise_sets add column entity jsonb not null default '{}'::jsonb;

-- สัญญาห้างหุ้นส่วน: หุ้นส่วนลำดับ N ใช้บัญชี 31N0 ทุน · 32N0 กระแสทุน · 33N0 ถอนใช้
create table acc.partners (
  company_id    uuid not null references acc.companies(id),
  no            smallint not null check (no between 1 and 9),
  name          text not null check (length(btrim(name)) between 1 and 100),
  ratio         numeric(9,4) not null check (ratio > 0),
  interest_rate numeric(6,3) not null default 0 check (interest_rate between 0 and 100),
  salary        numeric(18,2) not null default 0 check (salary >= 0),
  primary key (company_id, no)
);
create trigger audit_partners after insert or update or delete on acc.partners for each row execute function acc.audit_row();
create trigger partners_locked before insert or update on acc.partners for each row execute function acc.guard_locked_company();
alter table acc.partners enable row level security;
grant select on acc.partners to app_rw, app_ro;
create policy partners_read on acc.partners for select to app_rw, app_ro using (company_id in (select app.readable_company_ids()));

-- เงินปันผล (บริษัทจำกัด): ประกาศ = JV Dr 3210 / Cr 2320 (+ Cr 3220) · จ่าย = JV Dr 2320 / Cr เงิน
create table acc.dividends (
  id              uuid not null default gen_random_uuid(),
  company_id      uuid not null references acc.companies(id),
  declared_on     date not null,
  per_share       numeric(18,4) check (per_share > 0),
  shares          numeric(20,4),
  amount          numeric(18,2) not null check (amount > 0),
  reserve         numeric(18,2) not null default 0 check (reserve >= 0),
  description     text not null check (length(description) <= 300),
  entry_id        uuid not null,
  idem_key        text not null,
  paid_on         date,
  cash_account_id uuid,
  pay_entry_id    uuid,
  pay_idem        text,
  voided_at       timestamptz,
  void_entry_id   uuid,
  void_reason     text check (length(void_reason) <= 300),
  created_by      uuid not null references acc.users(id),
  created_at      timestamptz not null default now(),
  primary key (company_id, id),
  unique (company_id, idem_key),
  foreign key (company_id, entry_id) references acc.journal_entries (company_id, id),
  foreign key (company_id, pay_entry_id) references acc.journal_entries (company_id, id),
  foreign key (company_id, void_entry_id) references acc.journal_entries (company_id, id),
  foreign key (company_id, cash_account_id) references acc.chart_of_accounts (company_id, id),
  check ((paid_on is null) = (pay_entry_id is null)),
  check ((voided_at is null) = (void_entry_id is null)),
  check (voided_at is null or paid_on is null)
);
create trigger dividends_no_delete before delete on acc.dividends for each row execute function acc.forbid_mutation();
create trigger dividends_locked before insert or update on acc.dividends for each row execute function acc.guard_locked_company();
create trigger audit_dividends after insert or update on acc.dividends for each row execute function acc.audit_row();
alter table acc.dividends enable row level security;
grant select on acc.dividends to app_rw, app_ro;
create policy dividends_read on acc.dividends for select to app_rw, app_ro using (company_id in (select app.readable_company_ids()));

-- ตรวจและจัดรูปข้อมูลประเภทกิจการ: {type, partners:[{name, ratio, interest_rate, salary}], par_value, registered_shares}
create function acc.normalize_entity(p jsonb) returns jsonb
language plpgsql immutable set search_path = acc, pg_temp as $$
declare v_type text := coalesce(nullif(p->>'type', ''), 'sole'); v_out jsonb; x jsonb; v_arr jsonb := '[]'; v_n int := 0;
  v_ratio numeric; v_rate numeric; v_sal numeric; v_par numeric; v_reg numeric;
begin
  if v_type not in ('sole', 'partnership', 'company') then
    raise exception 'ประเภทกิจการไม่ถูกต้อง' using errcode = '22023';
  end if;
  v_out := jsonb_build_object('type', v_type);
  if v_type = 'partnership' then
    if jsonb_typeof(p->'partners') is distinct from 'array' or jsonb_array_length(p->'partners') not between 2 and 9 then
      raise exception 'ห้างหุ้นส่วนต้องมีหุ้นส่วน 2–9 คน' using errcode = '22023';
    end if;
    for x in select * from jsonb_array_elements(p->'partners') loop
      v_n := v_n + 1;
      begin
        v_ratio := (x->>'ratio')::numeric; v_rate := coalesce(nullif(x->>'interest_rate', ''), '0')::numeric; v_sal := coalesce(nullif(x->>'salary', ''), '0')::numeric;
      exception when others then raise exception 'ข้อมูลหุ้นส่วนคนที่ % ไม่ถูกต้อง', v_n using errcode = '22023'; end;
      if length(btrim(coalesce(x->>'name', ''))) not between 1 and 100 then
        raise exception 'ต้องมีชื่อหุ้นส่วนคนที่ % (ไม่เกิน 100 ตัวอักษร)', v_n using errcode = '22023';
      end if;
      if v_ratio is null or v_ratio <= 0 or v_ratio <> round(v_ratio, 4) then
        raise exception 'อัตราส่วนแบ่งกำไรของหุ้นส่วนคนที่ % ต้องมากกว่า 0', v_n using errcode = '22023';
      end if;
      if v_rate < 0 or v_rate > 100 or v_rate <> round(v_rate, 3) then
        raise exception 'ดอกเบี้ยทุนของหุ้นส่วนคนที่ % ต้องอยู่ระหว่าง 0–100%%', v_n using errcode = '22023';
      end if;
      if v_sal < 0 or v_sal <> round(v_sal, 2) then
        raise exception 'เงินเดือนหุ้นส่วนคนที่ % ไม่ถูกต้อง', v_n using errcode = '22023';
      end if;
      v_arr := v_arr || jsonb_build_object('name', btrim(x->>'name'), 'ratio', v_ratio, 'interest_rate', v_rate, 'salary', v_sal);
    end loop;
    v_out := v_out || jsonb_build_object('partners', v_arr);
  elsif v_type = 'company' then
    begin
      v_par := coalesce(nullif(p->>'par_value', ''), '10')::numeric;
      v_reg := nullif(p->>'registered_shares', '')::numeric;
    exception when others then raise exception 'มูลค่าหุ้นหรือจำนวนหุ้นจดทะเบียนไม่ถูกต้อง' using errcode = '22023'; end;
    if v_par <= 0 or v_par <> round(v_par, 2) then raise exception 'มูลค่าที่ตราไว้ต่อหุ้นต้องมากกว่า 0' using errcode = '22023'; end if;
    if v_reg is not null and (v_reg <= 0 or v_reg <> trunc(v_reg)) then raise exception 'จำนวนหุ้นจดทะเบียนต้องเป็นจำนวนเต็มบวก' using errcode = '22023'; end if;
    v_out := v_out || jsonb_build_object('par_value', v_par, 'registered_shares', v_reg::bigint);
  end if;
  return v_out;
end $$;

-- เพิ่ม/แก้บัญชีให้ตรงชื่อและประเภท (เปิดใช้คืน)
create function acc.upsert_account(p_company uuid, p_code text, p_name text, p_type text) returns void
language sql security definer set search_path = acc, pg_temp as $$
  insert into acc.chart_of_accounts as a (company_id, code, name, type) values (p_company, p_code, p_name, p_type)
  on conflict (company_id, code) do update set name = excluded.name, type = excluded.type, active = true, version = a.version + 1
   where (a.name, a.type, a.active) is distinct from (excluded.name, excluded.type, true)
$$;

-- ตั้งผังส่วนของเจ้าของตามประเภท (ภายใน: ผู้เรียกตรวจสิทธิ์และว่ายังไม่มีรายการ)
create function acc.apply_entity(p_company uuid, p_entity jsonb) returns void
language plpgsql security definer set search_path = acc, pg_temp as $$
declare e jsonb := acc.normalize_entity(p_entity); v_type text := e->>'type'; x jsonb; v_no int := 0; v_keep text[];
begin
  if v_type = 'sole' then
    perform acc.upsert_account(p_company, '3110', 'ทุน', 'equity');
    perform acc.upsert_account(p_company, '3210', 'กำไรสะสม', 'equity');
    perform acc.upsert_account(p_company, '3310', 'ถอนใช้ส่วนตัว', 'equity');
    v_keep := array['3110', '3210', '3310'];
  elsif v_type = 'partnership' then
    v_keep := '{}';
    for x in select * from jsonb_array_elements(e->'partners') loop
      v_no := v_no + 1;
      perform acc.upsert_account(p_company, '31' || v_no || '0', 'ทุน – ' || (x->>'name'), 'equity');
      perform acc.upsert_account(p_company, '32' || v_no || '0', 'กระแสทุน – ' || (x->>'name'), 'equity');
      perform acc.upsert_account(p_company, '33' || v_no || '0', 'ถอนใช้ – ' || (x->>'name'), 'equity');
      v_keep := v_keep || array['31' || v_no || '0', '32' || v_no || '0', '33' || v_no || '0'];
    end loop;
  else
    perform acc.upsert_account(p_company, '3110', 'ทุนเรือนหุ้นสามัญ', 'equity');
    perform acc.upsert_account(p_company, '3120', 'ส่วนเกินมูลค่าหุ้นสามัญ', 'equity');
    perform acc.upsert_account(p_company, '3210', 'กำไรสะสม – ยังไม่ได้จัดสรร', 'equity');
    perform acc.upsert_account(p_company, '3220', 'กำไรสะสม – จัดสรรเป็นทุนสำรองตามกฎหมาย', 'equity');
    perform acc.upsert_account(p_company, '2320', 'เงินปันผลค้างจ่าย', 'liability');
    v_keep := array['3110', '3120', '3210', '3220', '2320'];
  end if;
  -- บัญชีของประเภทอื่นที่ไม่ใช้ (ยังไม่มีรายการ) ปิดใช้
  update acc.chart_of_accounts a set active = false, version = a.version + 1
   where a.company_id = p_company and a.active and (a.code ~ '^3[123][1-9]0$' or a.code = '2320') and not (a.code = any (v_keep))
     and not exists (select 1 from acc.journal_lines l where l.company_id = a.company_id and l.account_id = a.id);
  delete from acc.partners where company_id = p_company;
  if v_type = 'partnership' then
    insert into acc.partners (company_id, no, name, ratio, interest_rate, salary)
    select p_company, o.n, o.j->>'name', (o.j->>'ratio')::numeric, (o.j->>'interest_rate')::numeric, (o.j->>'salary')::numeric
      from jsonb_array_elements(e->'partners') with ordinality o(j, n);
  end if;
  update acc.companies set entity_type = v_type, entity = e,
         par_value = case when v_type = 'company' then (e->>'par_value')::numeric end,
         registered_shares = case when v_type = 'company' then (e->>'registered_shares')::bigint end,
         version = version + 1
   where id = p_company;
end $$;

-- บริษัทที่สร้างใหม่: ประเภทจากค่าที่ครูเลือกตอนเปิดให้ห้อง (acc.new_company_entity) หรือจากชุดโจทย์ของงาน
create function acc.company_entity_default() returns trigger
language plpgsql security definer set search_path = acc, pg_temp as $$
declare v text := nullif(current_setting('acc.new_company_entity', true), '');
begin
  if new.entity is null or new.entity = '{}'::jsonb then
    if v is not null then new.entity := v::jsonb;
    elsif new.assignment_id is not null then
      select s.entity into new.entity from acc.exercise_sets s
       where s.id = coalesce(new.exercise_set_id, (select a.set_id from acc.assignments a where a.id = new.assignment_id));
    end if;
  end if;
  new.entity := acc.normalize_entity(coalesce(new.entity, '{}'::jsonb));
  new.entity_type := new.entity->>'type';
  return new;
end $$;
create trigger companies_entity_default before insert on acc.companies for each row execute function acc.company_entity_default();

-- ผังบัญชีถูกคัดลอกหลัง insert บริษัทในทรานแซกชันเดียวกัน จึงตั้งผังตามประเภทตอน commit (ทุกทางที่สร้างบริษัท)
create function acc.company_entity_setup() returns trigger
language plpgsql security definer set search_path = acc, pg_temp as $$
declare c acc.companies;
begin
  select * into c from acc.companies where id = new.id;
  if found and c.entity_type <> 'sole' then perform acc.apply_entity(c.id, c.entity); end if;
  return null;
end $$;
create constraint trigger companies_entity_setup after insert on acc.companies deferrable initially deferred
  for each row execute function acc.company_entity_setup();

-- ครูเปิดบริษัทให้ทั้งห้องพร้อมประเภทกิจการ
create function acc.open_classroom_companies(p_classroom uuid, p_name text, p_mode text, p_entity jsonb)
returns table (created int, existing int)
language plpgsql security definer set search_path = acc, pg_temp as $$
begin
  perform set_config('acc.new_company_entity', acc.normalize_entity(coalesce(p_entity, '{}'::jsonb))::text, true);
  return query select * from acc.open_classroom_companies(p_classroom, p_name, p_mode);
  perform set_config('acc.new_company_entity', '', true);
end $$;

-- เปลี่ยนประเภทกิจการ: ได้เฉพาะบริษัทที่ยังไม่มีรายการในสมุดรายวัน
create function acc.set_company_entity(p_company uuid, p_entity jsonb, p_version int) returns int
language plpgsql security definer set search_path = acc, pg_temp as $$
declare v int;
begin
  if not app.can_write_company(p_company) then raise exception 'ไม่มีสิทธิ์แก้ข้อมูลบริษัทนี้' using errcode = '42501'; end if;
  select version into v from acc.companies where id = p_company for update;
  if v is distinct from p_version then raise exception 'ข้อมูลบริษัทถูกแก้จากที่อื่นแล้ว โหลดหน้าใหม่' using errcode = '40001'; end if;
  if exists (select 1 from acc.journal_entries where company_id = p_company) then
    raise exception 'บริษัทนี้มีรายการในสมุดรายวันแล้ว เปลี่ยนประเภทกิจการไม่ได้' using errcode = 'ACC07';
  end if;
  perform acc.apply_entity(p_company, p_entity);
  return (select version from acc.companies where id = p_company);
end $$;

-- แก้สัญญาห้างหุ้นส่วน (ชื่อ อัตราส่วน ดอกเบี้ยทุน เงินเดือน เพิ่มหุ้นส่วน) หรือข้อมูลหุ้นของบริษัทจำกัด ได้ตลอด
-- p: {partners:[...]} หรือ {par_value, registered_shares}
create function acc.save_entity_profile(p_company uuid, p jsonb, p_version int) returns int
language plpgsql security definer set search_path = acc, pg_temp as $$
declare c acc.companies; e jsonb; x jsonb; v_n int; v_old int;
begin
  if not app.can_write_company(p_company) then raise exception 'ไม่มีสิทธิ์แก้ข้อมูลบริษัทนี้' using errcode = '42501'; end if;
  select * into c from acc.companies where id = p_company for update;
  if c.version is distinct from p_version then raise exception 'ข้อมูลบริษัทถูกแก้จากที่อื่นแล้ว โหลดหน้าใหม่' using errcode = '40001'; end if;
  if c.entity_type = 'sole' then raise exception 'กิจการเจ้าของคนเดียวไม่มีข้อมูลหุ้นส่วนหรือหุ้น' using errcode = '22023'; end if;
  e := acc.normalize_entity(p || jsonb_build_object('type', c.entity_type));
  if c.entity_type = 'partnership' then
    select count(*) into v_old from acc.partners where company_id = p_company;
    if jsonb_array_length(e->'partners') < v_old then raise exception 'ลดจำนวนหุ้นส่วนไม่ได้ (มี % คน)', v_old using errcode = '22023'; end if;
    for x, v_n in select o.j, o.n from jsonb_array_elements(e->'partners') with ordinality o(j, n) loop
      insert into acc.partners as t (company_id, no, name, ratio, interest_rate, salary)
      values (p_company, v_n, x->>'name', (x->>'ratio')::numeric, (x->>'interest_rate')::numeric, (x->>'salary')::numeric)
      on conflict (company_id, no) do update set name = excluded.name, ratio = excluded.ratio, interest_rate = excluded.interest_rate, salary = excluded.salary;
      perform acc.upsert_account(p_company, '31' || v_n || '0', 'ทุน – ' || (x->>'name'), 'equity');
      perform acc.upsert_account(p_company, '32' || v_n || '0', 'กระแสทุน – ' || (x->>'name'), 'equity');
      perform acc.upsert_account(p_company, '33' || v_n || '0', 'ถอนใช้ – ' || (x->>'name'), 'equity');
    end loop;
    update acc.companies set entity = e, version = version + 1 where id = p_company;
  else
    update acc.companies set entity = e, par_value = (e->>'par_value')::numeric, registered_shares = (e->>'registered_shares')::bigint,
           version = version + 1 where id = p_company;
  end if;
  return c.version + 1;
end $$;

-- ชุดโจทย์: เฉลยใช้รหัสในผังตั้งต้น + ผังของประเภทกิจการ + บัญชีที่ระบบสร้างให้เมื่อใช้ครั้งแรก (เฟส 7) · เก็บประเภทกิจการของชุด
create function acc.exercise_allowed_codes(p_entity jsonb) returns setof text
language plpgsql stable set search_path = acc, pg_temp as $$
declare e jsonb := acc.normalize_entity(coalesce(p_entity, '{}'::jsonb)); n int;
begin
  return query select code from acc.coa_template;
  return query select unnest(array['1440', '2250', '5910', '2231', '2260', '5280']);
  if e->>'type' = 'partnership' then
    for n in 1 .. jsonb_array_length(e->'partners') loop
      return query select unnest(array['31' || n || '0', '32' || n || '0', '33' || n || '0']);
    end loop;
  elsif e->>'type' = 'company' then
    return query select unnest(array['3120', '3220', '2320']);
  end if;
end $$;

create or replace function acc.save_exercise_set(p_id uuid, p_version int, p_payload jsonb) returns uuid
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
      if not exists (select 1 from acc.exercise_allowed_codes(p_payload->'entity') x where x = ln.j->>'account_code') then
        raise exception 'ข้อ % บรรทัด %: ไม่มีรหัสบัญชี % ในผังบัญชีตั้งต้นของประเภทกิจการนี้', it.no, ln.no, coalesce(ln.j->>'account_code', '(ว่าง)')
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
  update acc.exercise_sets set entity = acc.normalize_entity(coalesce(p_payload->'entity', '{}'::jsonb)) where id = v_id;
  return v_id;
end $$;

-- แบ่งกำไร(ขาดทุน)ห้างหุ้นส่วนของเดือน p_from ถึงเดือน p_to:
-- เงินเดือน = จำนวนเดือนที่มีกิจการ × เงินเดือน · ดอกเบี้ยทุน = Σ (ทุน 31N0 สิ้นเดือน × อัตรา ÷ 12) ปัด 2 ตำแหน่ง
-- ที่เหลือ = กำไร − เงินเดือน − ดอกเบี้ย แบ่งตามอัตราส่วน ปัดครึ่งขึ้น คนสุดท้ายรับเศษ
create function acc.partnership_allocation(p_company uuid, p_from date, p_to date, p_profit numeric)
returns table (no int, name text, salary numeric, interest numeric, share numeric, total numeric)
language plpgsql stable security definer set search_path = acc, pg_temp as $$
declare v_from date := date_trunc('month', p_from)::date; v_to date := date_trunc('month', p_to)::date; v_first date;
  v_months int; ps acc.partners[]; sal numeric[] := '{}'; intr numeric[] := '{}'; v_rem numeric; v_sum_ratio numeric; v_given numeric := 0;
  i int; v_cap numeric; v_share numeric;
begin
  if not app.can_read_company(p_company) then return; end if;
  select array_agg(x order by x.no) into ps from acc.partners x where x.company_id = p_company;
  if ps is null then return; end if;
  select date_trunc('month', min(entry_date))::date into v_first from acc.journal_entries where company_id = p_company;
  v_months := case when v_first is null or greatest(v_from, v_first) > v_to then 0
    else (extract(year from age(v_to, greatest(v_from, v_first))) * 12 + extract(month from age(v_to, greatest(v_from, v_first))))::int + 1 end;
  v_rem := coalesce(p_profit, 0);
  for i in 1 .. array_length(ps, 1) loop
    select coalesce(sum(b.bal), 0) into v_cap
      from generate_series(greatest(v_from, coalesce(v_first, v_to + 1)), v_to, interval '1 month') m
      cross join lateral (
        select coalesce(sum(l.credit - l.debit), 0) as bal
          from acc.journal_lines l
          join acc.chart_of_accounts a on a.company_id = l.company_id and a.id = l.account_id and a.code = '31' || ps[i].no || '0'
          join acc.journal_entries e on e.company_id = l.company_id and e.id = l.entry_id
         where l.company_id = p_company and e.entry_date < (m + interval '1 month')) b;
    sal := sal || (ps[i].salary * v_months);
    intr := intr || round(v_cap * ps[i].interest_rate / 1200, 2);
    v_rem := v_rem - sal[i] - intr[i];
  end loop;
  select sum(x.ratio) into v_sum_ratio from unnest(ps) x;
  for i in 1 .. array_length(ps, 1) loop
    if i = array_length(ps, 1) then v_share := v_rem - v_given;
    else v_share := round(v_rem * ps[i].ratio / v_sum_ratio, 2); v_given := v_given + v_share; end if;
    no := ps[i].no; name := ps[i].name; salary := sal[i]; interest := intr[i]; share := v_share; total := sal[i] + intr[i] + v_share;
    return next;
  end loop;
end $$;

-- กำไร(ขาดทุน)ที่จะโอนในการปิดบัญชีครั้งนี้ (รายได้ − ค่าใช้จ่ายที่ยังไม่ได้ปิด ถึงวันสิ้นปี)
create function acc.year_closing_net(p_company uuid, p_year_end date) returns numeric
language sql stable set search_path = acc, pg_temp as $$
  select coalesce(sum(l.credit - l.debit), 0)::numeric(18,2)
    from acc.journal_lines l
    join acc.journal_entries e on e.company_id = l.company_id and e.id = l.entry_id
    join acc.chart_of_accounts a on a.company_id = l.company_id and a.id = l.account_id
   where l.company_id = p_company and e.entry_date <= p_year_end and a.type in ('revenue', 'expense')
$$;

-- รายการปิดบัญชี: เจ้าของคนเดียว/บริษัท ผลต่างเข้า 3210 (เดิม)
-- ห้างหุ้นส่วน: แบ่งกำไรทั้งปีตามสัญญา (หักส่วนที่ CL ก่อนหน้าของปีเดียวกันโอนไปแล้ว) เข้ากระแสทุน 32N0 และปิดถอนใช้ 33N0 เข้า 32N0
create or replace function acc.year_closing_lines(p_company uuid, p_year_end date)
returns table (code text, name text, debit numeric, credit numeric)
language plpgsql stable set search_path = acc, pg_temp as $$
declare v_type text; v_ys date; v_full numeric; r record; v_prior numeric; v_draw numeric; v_net numeric; v_code text;
begin
  select c.entity_type into v_type from acc.companies c where c.id = p_company;
  return query
    with n as (
      select a.code, a.name, sum(l.debit - l.credit) as net
        from acc.journal_lines l
        join acc.journal_entries e on e.company_id = l.company_id and e.id = l.entry_id
        join acc.chart_of_accounts a on a.company_id = l.company_id and a.id = l.account_id
       where l.company_id = p_company and e.entry_date <= p_year_end and a.type in ('revenue', 'expense')
       group by a.code, a.name having sum(l.debit - l.credit) <> 0
    )
    select n.code, n.name, greatest(-n.net, 0)::numeric(18,2), greatest(n.net, 0)::numeric(18,2) from n order by n.code;
  if v_type is distinct from 'partnership' then
    return query
      select '3210'::text,
             coalesce((select a.name from acc.chart_of_accounts a where a.company_id = p_company and a.code = '3210'), 'กำไรสะสม'),
             greatest(-t.total, 0)::numeric(18,2), greatest(t.total, 0)::numeric(18,2)
        from (select acc.year_closing_net(p_company, p_year_end) as total) t where t.total <> 0;
    return;
  end if;
  v_ys := acc.fiscal_year_start(p_company, p_year_end);
  -- กำไรทั้งปี (ไม่รวม CL) → แบ่งตามสัญญา
  select coalesce(sum(l.credit - l.debit), 0) into v_full
    from acc.journal_lines l
    join acc.journal_entries e on e.company_id = l.company_id and e.id = l.entry_id
    join acc.chart_of_accounts a on a.company_id = l.company_id and a.id = l.account_id
   where l.company_id = p_company and e.entry_date between v_ys and p_year_end and e.doc_prefix <> 'CL' and a.type in ('revenue', 'expense');
  for r in select * from acc.partnership_allocation(p_company, v_ys, p_year_end, v_full) order by 1 loop
    -- CL ก่อนหน้าของปีนี้ (ปิดซ้ำหลังครูเปิดคืน): ส่วนแบ่งที่โอนแล้ว = เครดิตสุทธิ 32N0 + 33N0 ใน CL เหล่านั้น
    select coalesce(sum(l.credit - l.debit), 0) into v_prior
      from acc.journal_lines l
      join acc.journal_entries e on e.company_id = l.company_id and e.id = l.entry_id
      join acc.chart_of_accounts a on a.company_id = l.company_id and a.id = l.account_id
     where l.company_id = p_company and e.doc_prefix = 'CL' and e.entry_date between v_ys and p_year_end
       and a.code in ('32' || r.no || '0', '33' || r.no || '0');
    v_draw := -acc.account_net_as_of(p_company, '33' || r.no || '0', p_year_end); -- ยอดถอนใช้ (เดบิต) เป็นค่าลบ
    v_net := (r.total - v_prior) + v_draw;  -- 32N0: ส่วนแบ่งคงเหลือ หัก ถอนใช้
    if v_draw <> 0 then
      v_code := '33' || r.no || '0'; code := v_code; name := (select a.name from acc.chart_of_accounts a where a.company_id = p_company and a.code = v_code);
      debit := greatest(v_draw, 0); credit := greatest(-v_draw, 0); return next;
    end if;
    if v_net <> 0 then
      v_code := '32' || r.no || '0'; code := v_code; name := (select a.name from acc.chart_of_accounts a where a.company_id = p_company and a.code = v_code);
      debit := greatest(-v_net, 0); credit := greatest(v_net, 0); return next;
    end if;
  end loop;
end $$;

-- ปิดบัญชีสิ้นปี: เหมือนเดิม (migration 105) ต่างที่กำไรที่โอนคิดจากบัญชีรายได้/ค่าใช้จ่าย (ห้างหุ้นส่วนไม่มีบรรทัด 3210 เดียว)
create or replace function acc.close_fiscal_year(p_company uuid, p_year_end date, p_key text) returns uuid
language plpgsql security definer set search_path = acc, pg_temp as $$
declare
  v_id    uuid;
  v_start date;
  v_end   date;
  v_prev  date;
  v_bad   date;
  v_open  date;
  v_lines jsonb;
  v_net   numeric(18,2);
  v_eid   uuid;
  v_month date;
  v_bs    date;
  v_type  text;
begin
  if not app.can_write_company(p_company) then
    raise exception 'ไม่มีสิทธิ์ปิดบัญชีบริษัทนี้' using errcode = '42501';
  end if;
  if p_key is null or length(p_key) < 8 then
    raise exception 'ต้องมี idempotency key' using errcode = 'ACC03';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('periods:' || p_company::text, 0));
  select id into v_id from acc.fiscal_year_closings where company_id = p_company and idempotency_key = p_key;
  if found then return v_id; end if;
  select entity_type into v_type from acc.companies where id = p_company for update;

  v_start := acc.fiscal_year_start(p_company, p_year_end);
  v_end := (v_start + interval '1 year' - interval '1 day')::date;
  if p_year_end is distinct from v_end then
    raise exception 'วันที่ % ไม่ใช่วันสิ้นปีบัญชี (ปีบัญชีนี้สิ้นสุด %)', acc.thai_date(p_year_end), acc.thai_date(v_end)
      using errcode = '22023';
  end if;
  if exists (select 1 from acc.fiscal_year_closings
              where company_id = p_company and reopened_at is null and year_end >= v_end) then
    raise exception 'ปิดบัญชีปีบัญชี % – % ไปแล้ว', acc.thai_date(v_start), acc.thai_date(v_end) using errcode = 'ACC21';
  end if;
  if not exists (select 1 from acc.journal_entries where company_id = p_company and entry_date between v_start and v_end) then
    raise exception 'ปีบัญชี % – % ยังไม่มีรายการ ไม่ต้องปิดบัญชี', acc.thai_date(v_start), acc.thai_date(v_end)
      using errcode = 'ACC04';
  end if;

  select max(year_end) into v_prev from acc.fiscal_year_closings
   where company_id = p_company and reopened_at is null and year_end < v_start;
  select min(entry_date) into v_bad from acc.journal_entries
   where company_id = p_company and entry_date < v_start and (v_prev is null or entry_date > v_prev);
  if v_bad is not null then
    v_bs := acc.fiscal_year_start(p_company, v_bad);
    raise exception 'ต้องปิดบัญชีปีบัญชี % – % ก่อน ปิดบัญชีเรียงจากปีเก่าไปใหม่',
      acc.thai_date(v_bs), acc.thai_date((v_bs + interval '1 year' - interval '1 day')::date) using errcode = 'ACC13';
  end if;
  select min(start_date) into v_open from acc.periods
   where company_id = p_company and start_date < v_start and not closed;
  if v_open is not null then
    raise exception 'ต้องปิดงวด % ก่อน ปิดงวดเรียงจากเดือนเก่าไปใหม่', to_char(v_open, 'YYYY-MM') using errcode = 'ACC13';
  end if;

  if v_type is distinct from 'partnership' then
    insert into acc.chart_of_accounts (company_id, code, name, type) values (p_company, '3210', 'กำไรสะสม', 'equity')
    on conflict (company_id, code) do nothing;
    update acc.chart_of_accounts set active = true, version = version + 1
     where company_id = p_company and code = '3210' and not active;
  end if;

  select jsonb_agg(jsonb_build_object('account_code', x.code, 'debit', x.debit::text, 'credit', x.credit::text, 'memo', 'ปิดบัญชี'))
    into v_lines from acc.year_closing_lines(p_company, v_end) x where x.debit <> 0 or x.credit <> 0;
  v_net := acc.year_closing_net(p_company, v_end);

  if v_lines is not null then
    v_month := date_trunc('month', v_end)::date;
    insert into acc.periods (company_id, start_date, end_date) values (p_company, v_month, v_end)
    on conflict (company_id, start_date) do nothing;
    update acc.periods set closed = false, closed_at = null where company_id = p_company and start_date = v_month and closed;
    perform set_config('acc.year_closing', 'on', true);
    v_eid := acc.post_journal(p_company, v_end,
      'ปิดบัญชีรายได้และค่าใช้จ่าย' || case when v_type = 'partnership' then 'เข้าบัญชีกระแสทุนหุ้นส่วน' else 'เข้ากำไรสะสม' end
        || ' ปีบัญชี ' || acc.thai_date(v_start) || ' – ' || acc.thai_date(v_end),
      v_lines, p_key, 'CL');
    perform set_config('acc.year_closing', '', true);
  end if;

  insert into acc.fiscal_year_closings (company_id, year_start, year_end, entry_id, net_income, idempotency_key, closed_by)
  values (p_company, v_start, v_end, v_eid, v_net, p_key, app.current_user_id())
  returning id into v_id;

  update acc.periods set closed = true, closed_at = now()
   where company_id = p_company and start_date between v_start and v_end and not closed;
  return v_id;
end $$;

-- ---------- เงินปันผล ----------
-- ข้อมูลประกอบการประกาศ ณ วันที่: กำไรสะสม ทุนสำรอง หุ้นที่ออก ทุนสำรองขั้นต่ำ (ป.พ.พ. ม.1202)
create function acc.dividend_preview(p_company uuid, p_date date) returns jsonb
language plpgsql stable security definer set search_path = acc, pg_temp as $$
declare c acc.companies; v_ret numeric; v_res numeric; v_cap numeric; v_reg numeric; v_last numeric; v_min numeric;
begin
  if not app.can_read_company(p_company) then raise exception 'ไม่มีสิทธิ์' using errcode = '42501'; end if;
  select * into c from acc.companies where id = p_company;
  v_ret := -acc.account_net_as_of(p_company, '3210', p_date);
  v_res := -acc.account_net_as_of(p_company, '3220', p_date);
  v_cap := -acc.account_net_as_of(p_company, '3110', p_date);
  v_reg := coalesce(c.registered_shares * c.par_value, v_cap);
  select f.net_income into v_last from acc.fiscal_year_closings f
   where f.company_id = p_company and f.reopened_at is null and f.year_end <= p_date order by f.year_end desc limit 1;
  v_min := greatest(0, least(round(greatest(coalesce(v_last, 0), 0) * 0.05, 2), round(v_reg * 0.10, 2) - v_res));
  return jsonb_build_object('date', p_date, 'retained', v_ret::numeric(18,2)::text, 'reserve', v_res::numeric(18,2)::text,
    'shareCapital', v_cap::numeric(18,2)::text, 'parValue', c.par_value::text,
    'shares', case when c.par_value > 0 then trim_scale(round(v_cap / c.par_value, 4))::text end,
    'registeredCapital', v_reg::numeric(18,2)::text, 'lastYearProfit', v_last::text, 'minReserve', v_min::numeric(18,2)::text);
end $$;

-- p: {date, per_share? | amount?, reserve, description?}
create function acc.declare_dividend(p_company uuid, p jsonb, p_idem text) returns uuid
language plpgsql security definer set search_path = acc, pg_temp as $$
declare c acc.companies; v_id uuid; v_date date; v_ps numeric; v_shares numeric; v_amt numeric; v_res numeric; v_ret numeric; v_desc text; v_lines jsonb; v_eid uuid;
begin
  if not app.can_write_company(p_company) then raise exception 'ไม่มีสิทธิ์บันทึกรายการในบริษัทนี้' using errcode = '42501'; end if;
  select id into v_id from acc.dividends where company_id = p_company and idem_key = p_idem;
  if found then return v_id; end if;
  select * into c from acc.companies where id = p_company;
  if c.entity_type <> 'company' then raise exception 'ประกาศจ่ายเงินปันผลได้เฉพาะบริษัทจำกัด' using errcode = '22023'; end if;
  begin
    v_date := (p->>'date')::date; v_ps := nullif(p->>'per_share', '')::numeric; v_amt := nullif(p->>'amount', '')::numeric;
    v_res := coalesce(nullif(p->>'reserve', ''), '0')::numeric;
  exception when others then raise exception 'วันที่หรือจำนวนเงินไม่ถูกต้อง' using errcode = '22023'; end;
  if v_date is null then raise exception 'ต้องระบุวันที่ประกาศ' using errcode = '22023'; end if;
  v_shares := round(-acc.account_net_as_of(p_company, '3110', v_date) / c.par_value, 4);
  if v_ps is not null then
    if v_ps <= 0 or v_ps <> round(v_ps, 4) then raise exception 'เงินปันผลต่อหุ้นต้องมากกว่า 0' using errcode = 'ACC05'; end if;
    if v_shares <= 0 then raise exception 'ยังไม่มีหุ้นที่ออกจำหน่าย (บัญชี 3110 ไม่มียอด)' using errcode = 'ACC05'; end if;
    v_amt := round(v_ps * v_shares, 2);
  end if;
  if v_amt is null or v_amt <= 0 or v_amt <> round(v_amt, 2) then raise exception 'จำนวนเงินปันผลต้องมากกว่า 0 ทศนิยมไม่เกิน 2 ตำแหน่ง' using errcode = 'ACC05'; end if;
  if v_res < 0 or v_res <> round(v_res, 2) then raise exception 'ทุนสำรองตามกฎหมายต้องไม่ติดลบ' using errcode = 'ACC05'; end if;
  v_ret := -acc.account_net_as_of(p_company, '3210', v_date);
  if v_amt + v_res > v_ret then
    raise exception 'เงินปันผล % + ทุนสำรอง % เกินกำไรสะสมที่ยังไม่ได้จัดสรร % (จ่ายเงินปันผลได้จากกำไรเท่านั้น ป.พ.พ. ม.1201 ปิดบัญชีสิ้นปีก่อน)',
      to_char(v_amt, 'FM999,999,999,990.00'), to_char(v_res, 'FM999,999,999,990.00'), to_char(v_ret, 'FM999,999,999,990.00') using errcode = 'ACC05';
  end if;
  perform acc.upsert_account(p_company, '2320', 'เงินปันผลค้างจ่าย', 'liability');
  if v_res > 0 then perform acc.upsert_account(p_company, '3220', 'กำไรสะสม – จัดสรรเป็นทุนสำรองตามกฎหมาย', 'equity'); end if;
  v_desc := left(coalesce(nullif(btrim(p->>'description'), ''),
    'ประกาศจ่ายเงินปันผล' || case when v_ps is not null then ' หุ้นละ ' || trim_scale(v_ps)::text || ' บาท' else '' end
      || case when v_res > 0 then ' และจัดสรรทุนสำรองตามกฎหมาย' else '' end), 300);
  v_lines := jsonb_build_array(jsonb_build_object('account_code', '3210', 'debit', (v_amt + v_res)::text),
                               jsonb_build_object('account_code', '2320', 'credit', v_amt::text));
  if v_res > 0 then v_lines := v_lines || jsonb_build_object('account_code', '3220', 'credit', v_res::text); end if;
  v_eid := acc.post_journal(p_company, v_date, v_desc, v_lines, p_idem, 'JV', null);
  insert into acc.dividends (company_id, declared_on, per_share, shares, amount, reserve, description, entry_id, idem_key, created_by)
  values (p_company, v_date, v_ps, v_shares, v_amt, v_res, v_desc, v_eid, p_idem, app.current_user_id()) returning id into v_id;
  return v_id;
end $$;

-- p: {date, cash_account}
create function acc.pay_dividend(p_company uuid, p_id uuid, p jsonb, p_idem text) returns uuid
language plpgsql security definer set search_path = acc, pg_temp as $$
declare d acc.dividends; v_date date; ca acc.chart_of_accounts; v_eid uuid; v_no text;
begin
  if not app.can_write_company(p_company) then raise exception 'ไม่มีสิทธิ์' using errcode = '42501'; end if;
  select * into d from acc.dividends where company_id = p_company and id = p_id for update;
  if not found then raise exception 'ไม่พบรายการเงินปันผล' using errcode = 'ACC04'; end if;
  if d.pay_idem = p_idem then return d.pay_entry_id; end if;
  if d.voided_at is not null then raise exception 'ประกาศจ่ายเงินปันผลนี้ยกเลิกแล้ว' using errcode = 'ACC16'; end if;
  if d.paid_on is not null then raise exception 'จ่ายเงินปันผลนี้แล้ว' using errcode = 'ACC16'; end if;
  begin v_date := (p->>'date')::date; exception when others then raise exception 'วันที่ไม่ถูกต้อง' using errcode = '22023'; end;
  if v_date is null or v_date < d.declared_on then raise exception 'วันที่จ่ายต้องไม่ก่อนวันประกาศ' using errcode = '22023'; end if;
  select * into ca from acc.chart_of_accounts where company_id = p_company and code = p->>'cash_account' and active and type = 'asset' and code like '11%';
  if not found then raise exception 'ต้องเลือกบัญชีเงินสด/เงินฝาก (11xx)' using errcode = 'ACC04'; end if;
  select doc_no into v_no from acc.journal_entries where company_id = p_company and id = d.entry_id;
  v_eid := acc.post_journal(p_company, v_date, left('จ่ายเงินปันผลตาม ' || v_no, 300),
    jsonb_build_array(jsonb_build_object('account_code', '2320', 'debit', d.amount::text), jsonb_build_object('account_code', ca.code, 'credit', d.amount::text)),
    p_idem, 'JV', null);
  update acc.dividends set paid_on = v_date, cash_account_id = ca.id, pay_entry_id = v_eid, pay_idem = p_idem where company_id = p_company and id = p_id;
  return v_eid;
end $$;

-- ยกเลิก: p_what = 'payment' (กลับรายการจ่าย) | 'declaration' (กลับรายการประกาศ ต้องยกเลิกการจ่ายก่อน)
create function acc.void_dividend(p_company uuid, p_id uuid, p_what text, p_date date, p_reason text, p_idem text) returns uuid
language plpgsql security definer set search_path = acc, pg_temp as $$
declare d acc.dividends; v_rv uuid; v_no text; v_src uuid;
begin
  if not app.can_write_company(p_company) then raise exception 'ไม่มีสิทธิ์' using errcode = '42501'; end if;
  select entry_id into v_rv from acc.idempotency_keys where company_id = p_company and key = p_idem;
  if found then return v_rv; end if;
  select * into d from acc.dividends where company_id = p_company and id = p_id for update;
  if not found then raise exception 'ไม่พบรายการเงินปันผล' using errcode = 'ACC04'; end if;
  if length(btrim(coalesce(p_reason, ''))) = 0 then raise exception 'ต้องระบุเหตุผลที่ยกเลิก' using errcode = '22023'; end if;
  if p_what = 'payment' then
    if d.paid_on is null then raise exception 'ยังไม่ได้จ่ายเงินปันผลนี้' using errcode = 'ACC16'; end if;
    if p_date < d.paid_on then raise exception 'วันที่ยกเลิกต้องไม่ก่อนวันจ่าย' using errcode = '22023'; end if;
    v_src := d.pay_entry_id;
  elsif p_what = 'declaration' then
    if d.voided_at is not null then raise exception 'ยกเลิกไปแล้ว' using errcode = 'ACC16'; end if;
    if d.paid_on is not null then raise exception 'จ่ายเงินปันผลนี้แล้ว ต้องยกเลิกการจ่ายก่อน' using errcode = 'ACC16'; end if;
    if p_date < d.declared_on then raise exception 'วันที่ยกเลิกต้องไม่ก่อนวันประกาศ' using errcode = '22023'; end if;
    v_src := d.entry_id;
  else raise exception 'คำสั่งไม่ถูกต้อง' using errcode = '22023';
  end if;
  select doc_no into v_no from acc.journal_entries where company_id = p_company and id = v_src;
  v_rv := acc.reverse_journal(p_company, v_src, p_date, p_idem, 'ยกเลิก ' || v_no || ': ' || btrim(p_reason));
  if p_what = 'payment' then
    update acc.dividends set paid_on = null, cash_account_id = null, pay_entry_id = null, pay_idem = null where company_id = p_company and id = p_id;
  else
    update acc.dividends set voided_at = now(), void_entry_id = v_rv, void_reason = btrim(p_reason) where company_id = p_company and id = p_id;
  end if;
  return v_rv;
end $$;

-- รายการจากหน้าเฉพาะ (+ เงินปันผล) แก้/กลับรายการจากสมุดรายวันไม่ได้
create or replace function acc.entry_has_source(p_company uuid, p_entry uuid) returns boolean
language sql stable security definer set search_path = acc, pg_temp as $$
  select app.can_read_company(p_company) and (
       exists (select 1 from acc.depreciation_runs r where r.company_id = p_company and r.entry_id = p_entry)
    or exists (select 1 from acc.allowance_entries x where x.company_id = p_company and x.entry_id = p_entry)
    or exists (select 1 from acc.bad_debt_writeoffs x where x.company_id = p_company and x.entry_id = p_entry)
    or exists (select 1 from acc.bad_debt_recoveries x where x.company_id = p_company and x.entry_id = p_entry)
    or exists (select 1 from acc.adjustment_entries x where x.company_id = p_company and (x.entry_id = p_entry or x.reversal_entry_id = p_entry))
    or exists (select 1 from acc.dividends x where x.company_id = p_company and (x.entry_id = p_entry or x.pay_entry_id = p_entry)))
$$;

revoke all on function acc.exercise_allowed_codes(jsonb), acc.normalize_entity(jsonb), acc.upsert_account(uuid, text, text, text), acc.apply_entity(uuid, jsonb),
  acc.open_classroom_companies(uuid, text, text, jsonb), acc.set_company_entity(uuid, jsonb, int), acc.save_entity_profile(uuid, jsonb, int),
  acc.partnership_allocation(uuid, date, date, numeric), acc.year_closing_net(uuid, date),
  acc.dividend_preview(uuid, date), acc.declare_dividend(uuid, jsonb, text), acc.pay_dividend(uuid, uuid, jsonb, text),
  acc.void_dividend(uuid, uuid, text, date, text, text) from public;
grant execute on function acc.normalize_entity(jsonb), acc.partnership_allocation(uuid, date, date, numeric), acc.year_closing_net(uuid, date),
  acc.dividend_preview(uuid, date) to app_rw, app_ro;
grant execute on function acc.open_classroom_companies(uuid, text, text, jsonb), acc.set_company_entity(uuid, jsonb, int),
  acc.save_entity_profile(uuid, jsonb, int), acc.declare_dividend(uuid, jsonb, text),
  acc.pay_dividend(uuid, uuid, jsonb, text), acc.void_dividend(uuid, uuid, text, date, text, text) to app_rw;

-- migrate:down
drop function acc.exercise_allowed_codes(jsonb), acc.void_dividend(uuid, uuid, text, date, text, text), acc.pay_dividend(uuid, uuid, jsonb, text), acc.declare_dividend(uuid, jsonb, text),
  acc.dividend_preview(uuid, date), acc.year_closing_net(uuid, date), acc.partnership_allocation(uuid, date, date, numeric),
  acc.save_entity_profile(uuid, jsonb, int), acc.set_company_entity(uuid, jsonb, int),
  acc.open_classroom_companies(uuid, text, text, jsonb);
drop trigger companies_entity_setup on acc.companies;
drop trigger companies_entity_default on acc.companies;
drop function acc.company_entity_setup(), acc.company_entity_default(), acc.apply_entity(uuid, jsonb), acc.upsert_account(uuid, text, text, text),
  acc.normalize_entity(jsonb);
drop table acc.dividends, acc.partners;
alter table acc.exercise_sets drop column entity;
alter table acc.companies drop column registered_shares, drop column par_value, drop column entity, drop column entity_type;
