-- migrate:up
-- เงินเดือนแบบง่าย: ทะเบียนพนักงาน · ลงเงินเดือนรายเดือน · ประกันสังคม · ภาษีหัก ณ ที่จ่าย ภ.ง.ด.1 (กรอกเอง) · นำส่ง
-- (docs/phase7-spec.md ข้อ 3, docs/assumptions.md ข้อ 60) ลงผ่าน acc.post_journal · ยกเลิกด้วยกลับรายการ

create table acc.employees (
  id         uuid not null default gen_random_uuid(),
  company_id uuid not null references acc.companies(id),
  code       text not null check (code ~ '^[A-Z0-9-]{1,20}$'),
  name       text not null check (length(btrim(name)) between 1 and 120),
  position   text not null default '' check (length(position) <= 120),
  salary     numeric(18,2) not null check (salary >= 0),
  sso        boolean not null default true,
  active     boolean not null default true,
  version    int not null default 1,
  created_at timestamptz not null default now(),
  primary key (company_id, id),
  unique (company_id, code)
);
create trigger employees_locked before insert or update on acc.employees for each row execute function acc.guard_locked_company();
create trigger employees_no_delete before delete on acc.employees for each row execute function acc.forbid_mutation();
create trigger audit_employees after insert or update on acc.employees for each row execute function acc.audit_row();

create table acc.payroll_runs (
  id              uuid not null default gen_random_uuid(),
  company_id      uuid not null references acc.companies(id),
  month           date not null check (month = date_trunc('month', month)::date),
  pay_date        date not null,
  cash_account_id uuid not null,
  wages           numeric(18,2) not null,
  sso_employee    numeric(18,2) not null,
  sso_employer    numeric(18,2) not null,
  wht             numeric(18,2) not null,
  net             numeric(18,2) not null,
  entry_id        uuid not null,
  idem_key        text not null,
  voided_at       timestamptz,
  void_entry_id   uuid,
  void_reason     text check (length(void_reason) <= 300),
  created_by      uuid not null references acc.users(id),
  created_at      timestamptz not null default now(),
  primary key (company_id, id),
  unique (company_id, idem_key),
  foreign key (company_id, entry_id) references acc.journal_entries (company_id, id),
  foreign key (company_id, void_entry_id) references acc.journal_entries (company_id, id),
  foreign key (company_id, cash_account_id) references acc.chart_of_accounts (company_id, id),
  check (net = wages - sso_employee - wht),
  check ((voided_at is null) = (void_entry_id is null))
);
create unique index payroll_runs_month on acc.payroll_runs (company_id, month) where voided_at is null;

create table acc.payroll_lines (
  company_id   uuid not null,
  run_id       uuid not null,
  employee_id  uuid not null,
  salary       numeric(18,2) not null check (salary >= 0),
  other_income numeric(18,2) not null check (other_income >= 0),
  wage_base    numeric(18,2) not null,
  sso_employee numeric(18,2) not null check (sso_employee >= 0),
  sso_employer numeric(18,2) not null check (sso_employer >= 0),
  wht          numeric(18,2) not null check (wht >= 0),
  net          numeric(18,2) not null check (net >= 0),
  primary key (company_id, run_id, employee_id),
  foreign key (company_id, run_id) references acc.payroll_runs (company_id, id),
  foreign key (company_id, employee_id) references acc.employees (company_id, id),
  check (net = salary + other_income - sso_employee - wht)
);

-- นำส่งประกันสังคม (สปส.1-10 ลูกจ้าง + นายจ้าง) และ ภ.ง.ด.1 ของเดือน
create table acc.payroll_remittances (
  id              uuid not null default gen_random_uuid(),
  company_id      uuid not null references acc.companies(id),
  month           date not null check (month = date_trunc('month', month)::date),
  kind            text not null check (kind in ('sso', 'pnd1')),
  remit_date      date not null,
  amount          numeric(18,2) not null check (amount > 0),
  cash_account_id uuid not null,
  entry_id        uuid not null,
  idem_key        text not null,
  voided_at       timestamptz,
  void_entry_id   uuid,
  void_reason     text check (length(void_reason) <= 300),
  created_by      uuid not null references acc.users(id),
  created_at      timestamptz not null default now(),
  primary key (company_id, id),
  unique (company_id, idem_key),
  foreign key (company_id, entry_id) references acc.journal_entries (company_id, id),
  foreign key (company_id, void_entry_id) references acc.journal_entries (company_id, id),
  foreign key (company_id, cash_account_id) references acc.chart_of_accounts (company_id, id),
  check ((voided_at is null) = (void_entry_id is null))
);
create unique index payroll_remittances_month on acc.payroll_remittances (company_id, month, kind) where voided_at is null;

do $$ declare t text; begin
  foreach t in array array['payroll_runs', 'payroll_lines', 'payroll_remittances'] loop
    execute format('create trigger %1$s_locked before insert or update on acc.%1$s for each row execute function acc.guard_locked_company()', t);
    execute format('create trigger %1$s_no_delete before delete on acc.%1$s for each row execute function acc.forbid_mutation()', t);
    execute format('create trigger audit_%1$s after insert or update on acc.%1$s for each row execute function acc.audit_row()', t);
  end loop;
  foreach t in array array['employees', 'payroll_runs', 'payroll_lines', 'payroll_remittances'] loop
    execute format('alter table acc.%1$s enable row level security', t);
    execute format('grant select on acc.%1$s to app_rw, app_ro', t);
    execute format('create policy %1$s_read on acc.%1$s for select to app_rw, app_ro using (company_id in (select app.readable_company_ids()))', t);
  end loop;
end $$;

-- เพดานค่าจ้างคำนวณเงินสมทบ (กฎกระทรวง ลงวันที่ 11 ธ.ค. 2568): ถึงปี 2568 15,000 · 2569–2571 17,500 · 2572–2574 20,000 · ตั้งแต่ 2575 23,000
create function acc.sso_ceiling(p_month date) returns numeric
language sql immutable set search_path = acc, pg_temp as $$
  select case when p_month < date '2026-01-01' then 15000 when p_month < date '2029-01-01' then 17500
              when p_month < date '2032-01-01' then 20000 else 23000 end::numeric
$$;
-- เงินสมทบร้อยละ 5 ของค่าจ้าง (ฐานต่ำสุด 1,650 สูงสุดตามเพดาน) เศษตั้งแต่ 50 สตางค์ปัดเป็น 1 บาท ต่ำกว่าปัดทิ้ง
create function acc.sso_contribution(p_wage numeric, p_month date) returns numeric
language sql immutable set search_path = acc, pg_temp as $$
  select case when coalesce(p_wage, 0) <= 0 then 0::numeric(18,2)
    else floor(least(greatest(p_wage, 1650), acc.sso_ceiling(p_month)) * 0.05 + 0.5)::numeric(18,2) end
$$;

create function acc.ensure_payroll_accounts(p_company uuid) returns void
language sql security definer set search_path = acc, pg_temp as $$
  insert into acc.chart_of_accounts (company_id, code, name, type) values
    (p_company, '5210', 'เงินเดือนและค่าแรง', 'expense'),
    (p_company, '5280', 'เงินสมทบกองทุนประกันสังคม', 'expense'),
    (p_company, '2260', 'เงินประกันสังคมค้างจ่าย', 'liability'),
    (p_company, '2231', 'ภาษีหัก ณ ที่จ่ายค้างจ่าย – ภ.ง.ด.1', 'liability')
  on conflict (company_id, code) do update set active = true, version = acc.chart_of_accounts.version + 1 where not acc.chart_of_accounts.active
$$;

-- เพิ่ม/แก้พนักงาน · p: {code, name, position?, salary, sso?, active?} · p_id null = เพิ่ม
create function acc.save_employee(p_company uuid, p_id uuid, p jsonb, p_version int) returns uuid
language plpgsql security definer set search_path = acc, pg_temp as $$
declare v_id uuid; v_sal numeric; v_code text := upper(btrim(coalesce(p->>'code', '')));
begin
  if not app.can_write_company(p_company) then raise exception 'ไม่มีสิทธิ์แก้ข้อมูลบริษัทนี้' using errcode = '42501'; end if;
  begin v_sal := (p->>'salary')::numeric; exception when others then raise exception 'เงินเดือนไม่ถูกต้อง' using errcode = '22023'; end;
  if v_sal is null or v_sal < 0 or v_sal <> round(v_sal, 2) then raise exception 'เงินเดือนต้องไม่ติดลบ ทศนิยมไม่เกิน 2 ตำแหน่ง' using errcode = 'ACC05'; end if;
  if v_code !~ '^[A-Z0-9-]{1,20}$' then raise exception 'รหัสพนักงานใช้ตัวอักษรอังกฤษ ตัวเลข ขีด ไม่เกิน 20 ตัว' using errcode = '22023'; end if;
  if length(btrim(coalesce(p->>'name', ''))) not between 1 and 120 then raise exception 'ต้องมีชื่อพนักงาน' using errcode = '22023'; end if;
  if p_id is null then
    if exists (select 1 from acc.employees where company_id = p_company and code = v_code) then
      raise exception 'รหัสพนักงาน % มีแล้ว', v_code using errcode = '23505';
    end if;
    insert into acc.employees (company_id, code, name, position, salary, sso, active)
    values (p_company, v_code, btrim(p->>'name'), left(btrim(coalesce(p->>'position', '')), 120), v_sal, coalesce((p->>'sso')::boolean, true), coalesce((p->>'active')::boolean, true))
    returning id into v_id;
  else
    update acc.employees set code = v_code, name = btrim(p->>'name'), position = left(btrim(coalesce(p->>'position', '')), 120), salary = v_sal,
           sso = coalesce((p->>'sso')::boolean, sso), active = coalesce((p->>'active')::boolean, active), version = version + 1
     where company_id = p_company and id = p_id and version = p_version returning id into v_id;
    if v_id is null then raise exception 'ข้อมูลพนักงานถูกแก้จากที่อื่นแล้ว โหลดหน้าใหม่' using errcode = '40001'; end if;
  end if;
  return v_id;
end $$;

-- คำนวณรายคน · p_lines: [{employee: code, salary, other_income, wht}] คืน jsonb array เรียงตามรหัส
create function acc.payroll_compute(p_company uuid, p_month date, p_lines jsonb) returns jsonb
language plpgsql stable security definer set search_path = acc, pg_temp as $$
declare x jsonb; em acc.employees; v_sal numeric; v_oth numeric; v_wht numeric; v_wage numeric; v_ee numeric; v_er numeric; v_out jsonb := '[]'; v_n int := 0;
begin
  if not app.can_read_company(p_company) then raise exception 'ไม่มีสิทธิ์' using errcode = '42501'; end if;
  if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'ต้องมีพนักงานอย่างน้อย 1 คน' using errcode = '22023';
  end if;
  for x in select * from jsonb_array_elements(p_lines) loop
    v_n := v_n + 1;
    select * into em from acc.employees where company_id = p_company and code = upper(x->>'employee');
    if not found then raise exception 'ไม่พบพนักงานรหัส %', coalesce(x->>'employee', '(ว่าง)') using errcode = 'ACC04'; end if;
    if not em.active then raise exception 'พนักงาน % ลาออกแล้ว', em.code using errcode = '22023'; end if;
    begin
      v_sal := coalesce(nullif(x->>'salary', '')::numeric, em.salary); v_oth := coalesce(nullif(x->>'other_income', '')::numeric, 0);
      v_wht := coalesce(nullif(x->>'wht', '')::numeric, 0);
    exception when others then raise exception 'พนักงาน %: จำนวนเงินไม่ถูกต้อง', em.code using errcode = '22023'; end;
    if v_sal < 0 or v_oth < 0 or v_wht < 0 or v_sal <> round(v_sal, 2) or v_oth <> round(v_oth, 2) or v_wht <> round(v_wht, 2) then
      raise exception 'พนักงาน %: จำนวนเงินต้องไม่ติดลบ ทศนิยมไม่เกิน 2 ตำแหน่ง', em.code using errcode = 'ACC05';
    end if;
    v_wage := v_sal + v_oth;
    v_ee := case when em.sso then acc.sso_contribution(v_wage, p_month) else 0 end;
    v_er := v_ee;
    if v_wht > v_wage - v_ee then raise exception 'พนักงาน %: ภาษีหัก ณ ที่จ่ายเกินเงินได้หลังหักประกันสังคม', em.code using errcode = 'ACC05'; end if;
    if v_out @> jsonb_build_array(jsonb_build_object('employee', em.code)) then raise exception 'พนักงาน % ซ้ำ', em.code using errcode = '22023'; end if;
    v_out := v_out || jsonb_build_object('employee', em.code, 'employee_id', em.id, 'name', em.name, 'salary', v_sal::numeric(18,2), 'other_income', v_oth::numeric(18,2),
      'wage_base', case when em.sso and v_wage > 0 then least(greatest(v_wage, 1650), acc.sso_ceiling(p_month)) else 0 end::numeric(18,2),
      'sso_employee', v_ee, 'sso_employer', v_er, 'wht', v_wht::numeric(18,2), 'net', (v_wage - v_ee - v_wht)::numeric(18,2));
  end loop;
  return (select jsonb_agg(e order by e->>'employee') from jsonb_array_elements(v_out) e);
end $$;

-- ลงเงินเดือนของเดือน · p: {month, pay_date, cash_account, lines}
-- JV: Dr 5210 ค่าจ้าง · Dr 5280 ส่วนนายจ้าง / Cr 2260 ประกันสังคม (ลูกจ้าง + นายจ้าง) · Cr 2231 ภ.ง.ด.1 · Cr เงิน สุทธิ
create function acc.post_payroll(p_company uuid, p jsonb, p_idem text) returns uuid
language plpgsql security definer set search_path = acc, pg_temp as $$
declare v_id uuid; v_month date; v_pay date; ca acc.chart_of_accounts; v_rows jsonb; x jsonb; v_lines jsonb;
  v_wage numeric := 0; v_ee numeric := 0; v_er numeric := 0; v_wht numeric := 0; v_net numeric := 0; v_eid uuid;
begin
  if not app.can_write_company(p_company) then raise exception 'ไม่มีสิทธิ์บันทึกรายการในบริษัทนี้' using errcode = '42501'; end if;
  select id into v_id from acc.payroll_runs where company_id = p_company and idem_key = p_idem;
  if found then return v_id; end if;
  begin v_month := date_trunc('month', (p->>'month')::date)::date; v_pay := (p->>'pay_date')::date;
  exception when others then raise exception 'เดือนหรือวันที่จ่ายไม่ถูกต้อง' using errcode = '22023'; end;
  if v_month is null or v_pay is null then raise exception 'ต้องระบุเดือนและวันที่จ่าย' using errcode = '22023'; end if;
  if v_pay < v_month then raise exception 'วันที่จ่ายต้องไม่ก่อนเดือนของเงินเดือน' using errcode = '22023'; end if;
  if exists (select 1 from acc.payroll_runs where company_id = p_company and month = v_month and voided_at is null) then
    raise exception 'ลงเงินเดือนเดือน % แล้ว ยกเลิกของเดิมก่อนถ้าจะลงใหม่', to_char(v_month, 'MM/YYYY') using errcode = 'ACC16';
  end if;
  select * into ca from acc.chart_of_accounts where company_id = p_company and code = p->>'cash_account' and active and type = 'asset' and code like '11%';
  if not found then raise exception 'ต้องเลือกบัญชีเงินสด/เงินฝาก (11xx) ที่จ่าย' using errcode = 'ACC04'; end if;
  v_rows := acc.payroll_compute(p_company, v_month, p->'lines');
  for x in select * from jsonb_array_elements(v_rows) loop
    v_wage := v_wage + (x->>'salary')::numeric + (x->>'other_income')::numeric; v_ee := v_ee + (x->>'sso_employee')::numeric;
    v_er := v_er + (x->>'sso_employer')::numeric; v_wht := v_wht + (x->>'wht')::numeric; v_net := v_net + (x->>'net')::numeric;
  end loop;
  if v_wage <= 0 then raise exception 'ยอดเงินเดือนรวมต้องมากกว่า 0' using errcode = 'ACC05'; end if;
  perform acc.ensure_payroll_accounts(p_company);
  v_lines := jsonb_build_array(jsonb_build_object('account_code', '5210', 'debit', v_wage::text));
  if v_er > 0 then v_lines := v_lines || jsonb_build_object('account_code', '5280', 'debit', v_er::text)
                                       || jsonb_build_object('account_code', '2260', 'credit', (v_ee + v_er)::text); end if;
  if v_wht > 0 then v_lines := v_lines || jsonb_build_object('account_code', '2231', 'credit', v_wht::text); end if;
  if v_net > 0 then v_lines := v_lines || jsonb_build_object('account_code', ca.code, 'credit', v_net::text); end if;
  v_eid := acc.post_journal(p_company, v_pay, 'จ่ายเงินเดือนประจำเดือน ' || to_char(v_month, 'MM/') || (extract(year from v_month)::int + 543), v_lines, p_idem, 'JV', null);
  insert into acc.payroll_runs (company_id, month, pay_date, cash_account_id, wages, sso_employee, sso_employer, wht, net, entry_id, idem_key, created_by)
  values (p_company, v_month, v_pay, ca.id, v_wage, v_ee, v_er, v_wht, v_net, v_eid, p_idem, app.current_user_id()) returning id into v_id;
  insert into acc.payroll_lines (company_id, run_id, employee_id, salary, other_income, wage_base, sso_employee, sso_employer, wht, net)
  select p_company, v_id, (j->>'employee_id')::uuid, (j->>'salary')::numeric, (j->>'other_income')::numeric, (j->>'wage_base')::numeric,
         (j->>'sso_employee')::numeric, (j->>'sso_employer')::numeric, (j->>'wht')::numeric, (j->>'net')::numeric
    from jsonb_array_elements(v_rows) j;
  return v_id;
end $$;

-- นำส่ง · p: {month, kind: sso|pnd1, date, cash_account}
create function acc.remit_payroll(p_company uuid, p jsonb, p_idem text) returns uuid
language plpgsql security definer set search_path = acc, pg_temp as $$
declare v_id uuid; v_month date; v_date date; v_kind text := p->>'kind'; r acc.payroll_runs; v_amt numeric; ca acc.chart_of_accounts; v_eid uuid;
begin
  if not app.can_write_company(p_company) then raise exception 'ไม่มีสิทธิ์' using errcode = '42501'; end if;
  select id into v_id from acc.payroll_remittances where company_id = p_company and idem_key = p_idem;
  if found then return v_id; end if;
  if v_kind not in ('sso', 'pnd1') then raise exception 'ชนิดการนำส่งไม่ถูกต้อง' using errcode = '22023'; end if;
  begin v_month := date_trunc('month', (p->>'month')::date)::date; v_date := (p->>'date')::date;
  exception when others then raise exception 'เดือนหรือวันที่ไม่ถูกต้อง' using errcode = '22023'; end;
  select * into r from acc.payroll_runs where company_id = p_company and month = v_month and voided_at is null;
  if not found then raise exception 'ยังไม่ได้ลงเงินเดือนของเดือนนี้' using errcode = 'ACC04'; end if;
  v_amt := case v_kind when 'sso' then r.sso_employee + r.sso_employer else r.wht end;
  if v_amt <= 0 then raise exception 'เดือนนี้ไม่มียอดที่ต้องนำส่ง' using errcode = '22023'; end if;
  if exists (select 1 from acc.payroll_remittances where company_id = p_company and month = v_month and kind = v_kind and voided_at is null) then
    raise exception 'นำส่งของเดือนนี้แล้ว' using errcode = 'ACC16';
  end if;
  if v_date is null or v_date < r.pay_date then raise exception 'วันที่นำส่งต้องไม่ก่อนวันจ่ายเงินเดือน' using errcode = '22023'; end if;
  select * into ca from acc.chart_of_accounts where company_id = p_company and code = p->>'cash_account' and active and type = 'asset' and code like '11%';
  if not found then raise exception 'ต้องเลือกบัญชีเงินสด/เงินฝาก (11xx)' using errcode = 'ACC04'; end if;
  v_eid := acc.post_journal(p_company, v_date,
    case v_kind when 'sso' then 'นำส่งเงินสมทบประกันสังคม (สปส.1-10) เดือน ' else 'นำส่งภาษีหัก ณ ที่จ่าย ภ.ง.ด.1 เดือน ' end
      || to_char(v_month, 'MM/') || (extract(year from v_month)::int + 543),
    jsonb_build_array(jsonb_build_object('account_code', case v_kind when 'sso' then '2260' else '2231' end, 'debit', v_amt::text),
                      jsonb_build_object('account_code', ca.code, 'credit', v_amt::text)), p_idem, 'JV', null);
  insert into acc.payroll_remittances (company_id, month, kind, remit_date, amount, cash_account_id, entry_id, idem_key, created_by)
  values (p_company, v_month, v_kind, v_date, v_amt, ca.id, v_eid, p_idem, app.current_user_id()) returning id into v_id;
  return v_id;
end $$;

-- ยกเลิกเงินเดือน (ต้องยกเลิกการนำส่งของเดือนนั้นก่อน) หรือยกเลิกการนำส่ง · p_kind: run | remittance
create function acc.void_payroll(p_company uuid, p_kind text, p_id uuid, p_date date, p_reason text, p_idem text) returns uuid
language plpgsql security definer set search_path = acc, pg_temp as $$
declare v_rv uuid; v_entry uuid; v_base date; v_month date; v_void timestamptz; v_no text;
begin
  if not app.can_write_company(p_company) then raise exception 'ไม่มีสิทธิ์' using errcode = '42501'; end if;
  select entry_id into v_rv from acc.idempotency_keys where company_id = p_company and key = p_idem;
  if found then return v_rv; end if;
  if length(btrim(coalesce(p_reason, ''))) = 0 then raise exception 'ต้องระบุเหตุผลที่ยกเลิก' using errcode = '22023'; end if;
  if p_kind = 'run' then
    select entry_id, pay_date, month, voided_at into v_entry, v_base, v_month, v_void from acc.payroll_runs where company_id = p_company and id = p_id for update;
    if not found then raise exception 'ไม่พบรายการเงินเดือน' using errcode = 'ACC04'; end if;
    if exists (select 1 from acc.payroll_remittances where company_id = p_company and month = v_month and voided_at is null) then
      raise exception 'นำส่งประกันสังคม/ภ.ง.ด.1 ของเดือนนี้แล้ว ยกเลิกการนำส่งก่อน' using errcode = 'ACC16';
    end if;
  elsif p_kind = 'remittance' then
    select entry_id, remit_date, voided_at into v_entry, v_base, v_void from acc.payroll_remittances where company_id = p_company and id = p_id for update;
    if not found then raise exception 'ไม่พบรายการนำส่ง' using errcode = 'ACC04'; end if;
  else raise exception 'คำสั่งไม่ถูกต้อง' using errcode = '22023';
  end if;
  if v_void is not null then raise exception 'ยกเลิกไปแล้ว' using errcode = 'ACC16'; end if;
  if p_date < v_base then raise exception 'วันที่ยกเลิกต้องไม่ก่อนวันที่ของรายการ' using errcode = '22023'; end if;
  select doc_no into v_no from acc.journal_entries where company_id = p_company and id = v_entry;
  v_rv := acc.reverse_journal(p_company, v_entry, p_date, p_idem, 'ยกเลิก ' || v_no || ': ' || btrim(p_reason));
  if p_kind = 'run' then
    update acc.payroll_runs set voided_at = now(), void_entry_id = v_rv, void_reason = btrim(p_reason) where company_id = p_company and id = p_id;
  else
    update acc.payroll_remittances set voided_at = now(), void_entry_id = v_rv, void_reason = btrim(p_reason) where company_id = p_company and id = p_id;
  end if;
  return v_rv;
end $$;

create or replace function acc.entry_has_source(p_company uuid, p_entry uuid) returns boolean
language sql stable security definer set search_path = acc, pg_temp as $$
  select app.can_read_company(p_company) and (
       exists (select 1 from acc.depreciation_runs r where r.company_id = p_company and r.entry_id = p_entry)
    or exists (select 1 from acc.allowance_entries x where x.company_id = p_company and x.entry_id = p_entry)
    or exists (select 1 from acc.bad_debt_writeoffs x where x.company_id = p_company and x.entry_id = p_entry)
    or exists (select 1 from acc.bad_debt_recoveries x where x.company_id = p_company and x.entry_id = p_entry)
    or exists (select 1 from acc.adjustment_entries x where x.company_id = p_company and (x.entry_id = p_entry or x.reversal_entry_id = p_entry))
    or exists (select 1 from acc.dividends x where x.company_id = p_company and (x.entry_id = p_entry or x.pay_entry_id = p_entry))
    or exists (select 1 from acc.income_tax_filings x where x.company_id = p_company and (x.entry_id = p_entry or x.pay_entry_id = p_entry))
    or exists (select 1 from acc.payroll_runs x where x.company_id = p_company and x.entry_id = p_entry)
    or exists (select 1 from acc.payroll_remittances x where x.company_id = p_company and x.entry_id = p_entry))
$$;

revoke all on function acc.sso_ceiling(date), acc.sso_contribution(numeric, date), acc.ensure_payroll_accounts(uuid), acc.save_employee(uuid, uuid, jsonb, int),
  acc.payroll_compute(uuid, date, jsonb), acc.post_payroll(uuid, jsonb, text), acc.remit_payroll(uuid, jsonb, text),
  acc.void_payroll(uuid, text, uuid, date, text, text) from public;
grant execute on function acc.sso_ceiling(date), acc.sso_contribution(numeric, date), acc.payroll_compute(uuid, date, jsonb) to app_rw, app_ro;
grant execute on function acc.save_employee(uuid, uuid, jsonb, int), acc.post_payroll(uuid, jsonb, text), acc.remit_payroll(uuid, jsonb, text),
  acc.void_payroll(uuid, text, uuid, date, text, text) to app_rw;

-- migrate:down
drop function acc.void_payroll(uuid, text, uuid, date, text, text), acc.remit_payroll(uuid, jsonb, text), acc.post_payroll(uuid, jsonb, text),
  acc.payroll_compute(uuid, date, jsonb), acc.save_employee(uuid, uuid, jsonb, int), acc.ensure_payroll_accounts(uuid),
  acc.sso_contribution(numeric, date), acc.sso_ceiling(date);
drop table acc.payroll_remittances, acc.payroll_lines, acc.payroll_runs, acc.employees;
