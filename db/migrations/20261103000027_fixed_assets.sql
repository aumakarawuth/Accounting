-- migrate:up
-- เฟส 3.4 สินทรัพย์ถาวร (docs/phase3-spec.md ข้อ 4)
-- ทะเบียนสินทรัพย์ · ค่าเสื่อมราคาเส้นตรงรายเดือน (AJ สิ้นเดือน เข้ากระดาษทำการ) · จำหน่าย/ขาย พร้อมกำไรขาดทุน
-- ทุกเหตุการณ์ที่กระทบบัญชีลงผ่าน acc.post_journal; แก้ด้วยการกลับรายการ (acc.reverse_journal) เท่านั้น
--
-- ค่าเสื่อมต่อเดือน = ปัด((ราคาทุน − ราคาซาก) / อายุ(เดือน), 2) เดือนสุดท้ายรับส่วนต่างให้ครบพอดี
-- ยอดสะสมไม่เกินมูลค่าเสื่อมได้ทุกเดือน (สูตรเดียวกับ apps/web/lib/depreciation.ts)

insert into acc.coa_template (code, name, type) values
  ('4330', 'กำไรจากการจำหน่ายสินทรัพย์', 'revenue'),
  ('5320', 'ขาดทุนจากการจำหน่ายสินทรัพย์', 'expense')
on conflict (code) do update set name = excluded.name, type = excluded.type;
insert into acc.chart_of_accounts (company_id, code, name, type)
select c.id, t.code, t.name, t.type
  from acc.companies c cross join acc.coa_template t
 where t.code in ('4330', '5320') and not app.company_locked(c.id)
on conflict (company_id, code) do nothing;

create function acc.ensure_asset_accounts(p_company uuid) returns void
language sql security definer set search_path = acc, pg_temp as $$
  insert into acc.chart_of_accounts (company_id, code, name, type)
  select p_company, t.code, t.name, t.type from acc.coa_template t
   where t.code in ('1620', '1621', '1630', '1631', '4330', '5250', '5320')
  on conflict (company_id, code) do nothing
$$;

-- ค่าเสื่อมราคาสะสมหลังเดือนที่ n (n = 0..อายุ)
create function app.depreciation_cum(p_cost numeric, p_salvage numeric, p_life int, p_n int) returns numeric
language sql immutable as $$
  select case when p_n <= 0 then 0::numeric
              when p_n >= p_life then p_cost - p_salvage
              else least(round((p_cost - p_salvage) / p_life, 2) * p_n, p_cost - p_salvage) end
$$;
grant execute on function app.depreciation_cum(numeric, numeric, int, int) to app_rw, app_ro;

-- จำนวนเดือนจาก a ถึงก่อน b (เดือนแรกของทั้งคู่)
create function app.months_between(a date, b date) returns int
language sql immutable as $$
  select ((extract(year from b) - extract(year from a)) * 12 + extract(month from b) - extract(month from a))::int
$$;
grant execute on function app.months_between(date, date) to app_rw, app_ro;

create table acc.fixed_assets (
  id                 uuid not null default gen_random_uuid(),
  company_id         uuid not null references acc.companies(id),
  code               text not null check (code ~ '^[A-Z0-9][A-Z0-9-]{0,19}$'),
  name               text not null check (length(btrim(name)) between 1 and 160),
  acquired_date      date not null,
  dep_start          date not null,  -- เดือนแรกที่คิดค่าเสื่อม (วันที่ 1)
  cost               numeric(18,2) not null check (cost > 0),
  salvage            numeric(18,2) not null default 0 check (salvage >= 0),
  life_months        int not null check (life_months between 1 and 1200),
  asset_account_id   uuid not null,
  accum_account_id   uuid not null,
  expense_account_id uuid not null,
  entry_id           uuid,           -- รายการได้มา (FA) ถ้าบันทึกจากหน้านี้ · ซื้อจากเอกสารซื้อแล้ว = ว่าง
  description        text not null default '' check (length(description) <= 300),
  idem_key           text not null,
  created_by         uuid not null references acc.users(id),
  created_at         timestamptz not null default now(),
  voided_at          timestamptz,
  void_entry_id      uuid,
  void_reason        text check (length(void_reason) <= 300),
  primary key (company_id, id),
  unique (company_id, idem_key),
  foreign key (company_id, asset_account_id) references acc.chart_of_accounts (company_id, id),
  foreign key (company_id, accum_account_id) references acc.chart_of_accounts (company_id, id),
  foreign key (company_id, expense_account_id) references acc.chart_of_accounts (company_id, id),
  foreign key (company_id, entry_id) references acc.journal_entries (company_id, id),
  foreign key (company_id, void_entry_id) references acc.journal_entries (company_id, id),
  check (salvage < cost),
  check (dep_start = date_trunc('month', dep_start)::date and dep_start >= date_trunc('month', acquired_date)::date),
  check (asset_account_id <> accum_account_id),
  check (voided_at is not null or void_entry_id is null)
);
create unique index fixed_assets_code on acc.fixed_assets (company_id, code) where voided_at is null;

create table acc.depreciation_runs (
  id            uuid not null default gen_random_uuid(),
  company_id    uuid not null references acc.companies(id),
  month         date not null check (month = date_trunc('month', month)::date),
  entry_id      uuid,  -- AJ สิ้นเดือน (ว่างเมื่อทุกบรรทัดเป็น 0.00)
  idem_key      text not null,
  created_by    uuid not null references acc.users(id),
  created_at    timestamptz not null default now(),
  voided_at     timestamptz,
  void_entry_id uuid,
  primary key (company_id, id),
  unique (company_id, idem_key),
  foreign key (company_id, entry_id) references acc.journal_entries (company_id, id),
  foreign key (company_id, void_entry_id) references acc.journal_entries (company_id, id)
);
create index depreciation_runs_month on acc.depreciation_runs (company_id, month);

create table acc.depreciation_lines (
  company_id uuid not null,
  run_id     uuid not null,
  asset_id   uuid not null,
  dep_month  date not null,  -- เดือนของค่าเสื่อม (ลงย้อนเดือนที่ตกหล่นได้ในรอบเดียว)
  seq        int not null check (seq >= 1),  -- เดือนที่เท่าไรของอายุ
  amount     numeric(18,2) not null check (amount >= 0),
  primary key (company_id, run_id, asset_id, dep_month),
  foreign key (company_id, run_id) references acc.depreciation_runs (company_id, id),
  foreign key (company_id, asset_id) references acc.fixed_assets (company_id, id)
);
create index depreciation_lines_asset on acc.depreciation_lines (company_id, asset_id, dep_month);

create table acc.asset_disposals (
  id                  uuid not null default gen_random_uuid(),
  company_id          uuid not null references acc.companies(id),
  asset_id            uuid not null,
  disposal_date       date not null,
  proceeds            numeric(18,2) not null check (proceeds >= 0),
  proceeds_account_id uuid,
  accumulated         numeric(18,2) not null check (accumulated >= 0),
  book_value          numeric(18,2) not null check (book_value >= 0),
  gain_loss           numeric(18,2) not null,  -- + กำไร / − ขาดทุน
  entry_id            uuid not null,
  description         text not null default '' check (length(description) <= 300),
  idem_key            text not null,
  created_by          uuid not null references acc.users(id),
  created_at          timestamptz not null default now(),
  voided_at           timestamptz,
  void_entry_id       uuid,
  void_reason         text check (length(void_reason) <= 300),
  primary key (company_id, id),
  unique (company_id, idem_key),
  foreign key (company_id, asset_id) references acc.fixed_assets (company_id, id),
  foreign key (company_id, proceeds_account_id) references acc.chart_of_accounts (company_id, id),
  foreign key (company_id, entry_id) references acc.journal_entries (company_id, id),
  foreign key (company_id, void_entry_id) references acc.journal_entries (company_id, id),
  check ((proceeds > 0) = (proceeds_account_id is not null)),
  check (gain_loss = proceeds - book_value),
  check ((voided_at is null) = (void_entry_id is null))
);
create unique index asset_disposals_active on acc.asset_disposals (company_id, asset_id) where voided_at is null;

-- แก้ไม่ได้ เปลี่ยนได้อย่างเดียวคือบันทึกการยกเลิก/กลับรายการครั้งเดียว
create function acc.guard_void_only() returns trigger
language plpgsql as $$
begin
  if old.voided_at is not null
     or (to_jsonb(new) - '{voided_at,void_entry_id,void_reason}'::text[])
        <> (to_jsonb(old) - '{voided_at,void_entry_id,void_reason}'::text[]) then
    raise exception 'รายการที่บันทึกแล้วแก้ไม่ได้ ถ้าผิดให้กลับรายการแล้วบันทึกใหม่' using errcode = 'ACC06';
  end if;
  return new;
end $$;
create trigger fixed_assets_guard before update on acc.fixed_assets for each row execute function acc.guard_void_only();
create trigger depreciation_runs_guard before update on acc.depreciation_runs for each row execute function acc.guard_void_only();
create trigger asset_disposals_guard before update on acc.asset_disposals for each row execute function acc.guard_void_only();
create trigger fixed_assets_no_delete before delete on acc.fixed_assets for each row execute function acc.forbid_mutation();
create trigger depreciation_runs_no_delete before delete on acc.depreciation_runs for each row execute function acc.forbid_mutation();
create trigger asset_disposals_no_delete before delete on acc.asset_disposals for each row execute function acc.forbid_mutation();
create trigger depreciation_lines_immutable before update or delete on acc.depreciation_lines for each row execute function acc.forbid_mutation();
create trigger fixed_assets_locked before insert or update on acc.fixed_assets for each row execute function acc.guard_locked_company();
create trigger depreciation_runs_locked before insert or update on acc.depreciation_runs for each row execute function acc.guard_locked_company();
create trigger depreciation_lines_locked before insert on acc.depreciation_lines for each row execute function acc.guard_locked_company();
create trigger asset_disposals_locked before insert or update on acc.asset_disposals for each row execute function acc.guard_locked_company();
create trigger audit_fixed_assets after insert or update on acc.fixed_assets for each row execute function acc.audit_row();
create trigger audit_depreciation_runs after insert or update on acc.depreciation_runs for each row execute function acc.audit_row();
create trigger audit_asset_disposals after insert or update on acc.asset_disposals for each row execute function acc.audit_row();

alter table acc.fixed_assets enable row level security;
alter table acc.depreciation_runs enable row level security;
alter table acc.depreciation_lines enable row level security;
alter table acc.asset_disposals enable row level security;
grant select on acc.fixed_assets, acc.depreciation_runs, acc.depreciation_lines, acc.asset_disposals to app_rw, app_ro;
create policy fixed_assets_read on acc.fixed_assets for select to app_rw, app_ro using (app.can_read_company(company_id));
create policy depreciation_runs_read on acc.depreciation_runs for select to app_rw, app_ro using (app.can_read_company(company_id));
create policy depreciation_lines_read on acc.depreciation_lines for select to app_rw, app_ro using (app.can_read_company(company_id));
create policy asset_disposals_read on acc.asset_disposals for select to app_rw, app_ro using (app.can_read_company(company_id));
-- เขียนได้ผ่านฟังก์ชันข้างล่างเท่านั้น

-- จำนวนเดือนที่ลงค่าเสื่อมแล้ว (รอบที่ไม่ถูกกลับรายการ)
create function acc.asset_posted_months(p_company uuid, p_asset uuid, out months int, out accumulated numeric)
language sql stable as $$
  select count(*)::int, coalesce(sum(l.amount), 0)
    from acc.depreciation_lines l join acc.depreciation_runs r on r.company_id = l.company_id and r.id = l.run_id
   where l.company_id = p_company and l.asset_id = p_asset and r.voided_at is null
$$;

create function acc.thai_month(p date) returns text
language sql immutable as $$
  select (array['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'])[extract(month from p)::int]
         || ' ' || (extract(year from p)::int + 543)
$$;

-- ---- ลงทะเบียนสินทรัพย์ ----
-- p: {code, name, acquired_date, dep_start? (YYYY-MM-01, ค่าเริ่มต้น = เดือนที่ได้มา), cost, salvage?, life_months,
--     asset_account, accum_account, expense_account?, counter_account? (บันทึกการได้มา FA), description?}
create function acc.register_fixed_asset(p_company uuid, p jsonb, p_idem text) returns uuid
language plpgsql security definer set search_path = acc, pg_temp as $$
declare
  v_id    uuid;
  v_code  text := upper(btrim(coalesce(p->>'code', '')));
  v_name  text := btrim(coalesce(p->>'name', ''));
  v_date  date;
  v_start date;
  v_cost  numeric; v_salv numeric; v_life int;
  a_asset acc.chart_of_accounts; a_accum acc.chart_of_accounts; a_exp acc.chart_of_accounts; a_counter acc.chart_of_accounts;
  v_eid   uuid;
begin
  if not app.can_write_company(p_company) then
    raise exception 'ไม่มีสิทธิ์ทำรายการในบริษัทนี้' using errcode = '42501';
  end if;
  if p_idem is null or length(p_idem) < 8 then raise exception 'ต้องมี idempotency key' using errcode = 'ACC03'; end if;
  select id into v_id from acc.fixed_assets where company_id = p_company and idem_key = p_idem;
  if found then return v_id; end if;
  perform acc.ensure_asset_accounts(p_company);

  if v_code !~ '^[A-Z0-9][A-Z0-9-]{0,19}$' then
    raise exception 'รหัสสินทรัพย์เป็นตัวพิมพ์ใหญ่ ตัวเลข และขีด ไม่เกิน 20 ตัว' using errcode = '22023';
  end if;
  if length(v_name) not between 1 and 160 then raise exception 'ต้องมีชื่อสินทรัพย์' using errcode = '22023'; end if;
  if exists (select 1 from acc.fixed_assets where company_id = p_company and code = v_code and voided_at is null) then
    raise exception 'รหัสสินทรัพย์ % มีอยู่แล้ว', v_code using errcode = 'ACC18';
  end if;
  begin
    v_date := (p->>'acquired_date')::date;
    v_start := coalesce(nullif(p->>'dep_start', '')::date, v_date);
    v_cost := (p->>'cost')::numeric;
    v_salv := coalesce(nullif(p->>'salvage', '')::numeric, 0);
    v_life := (p->>'life_months')::int;
  exception when others then
    raise exception 'วันที่ ราคาทุน ราคาซาก หรืออายุใช้งานไม่ถูกต้อง' using errcode = '22023';
  end;
  if v_date is null then raise exception 'ต้องมีวันที่ได้มา' using errcode = '22023'; end if;
  v_start := date_trunc('month', v_start)::date;
  if v_start < date_trunc('month', v_date)::date then
    raise exception 'เดือนเริ่มคิดค่าเสื่อมต้องไม่ก่อนเดือนที่ได้มา' using errcode = '22023';
  end if;
  if v_cost is null or v_cost <= 0 or v_cost <> round(v_cost, 2) or v_salv < 0 or v_salv <> round(v_salv, 2) then
    raise exception 'ราคาทุนต้องมากกว่า 0 ราคาซากไม่ติดลบ ทศนิยมไม่เกิน 2 ตำแหน่ง' using errcode = 'ACC05';
  end if;
  if v_salv >= v_cost then raise exception 'ราคาซากต้องน้อยกว่าราคาทุน' using errcode = 'ACC05'; end if;
  if v_life is null or v_life not between 1 and 1200 then
    raise exception 'อายุใช้งานต้องเป็น 1–1,200 เดือน' using errcode = '22023';
  end if;

  select * into a_asset from acc.chart_of_accounts
   where company_id = p_company and code = p->>'asset_account' and active and type = 'asset' and code like '16%';
  if not found then raise exception 'บัญชีสินทรัพย์ต้องเป็นบัญชีที่ดิน อาคาร และอุปกรณ์ (16xx)' using errcode = 'ACC04'; end if;
  select * into a_accum from acc.chart_of_accounts
   where company_id = p_company and code = p->>'accum_account' and active and type = 'asset' and code like '16%' and code <> a_asset.code;
  if not found then raise exception 'บัญชีค่าเสื่อมราคาสะสมต้องเป็นบัญชี 16xx อีกบัญชีหนึ่ง' using errcode = 'ACC04'; end if;
  select * into a_exp from acc.chart_of_accounts
   where company_id = p_company and code = coalesce(nullif(p->>'expense_account', ''), '5250') and active and type = 'expense';
  if not found then raise exception 'บัญชีค่าเสื่อมราคาต้องเป็นบัญชีค่าใช้จ่าย' using errcode = 'ACC04'; end if;

  if nullif(p->>'counter_account', '') is not null then
    select * into a_counter from acc.chart_of_accounts
     where company_id = p_company and code = p->>'counter_account' and active and code not in (a_asset.code, a_accum.code);
    if not found then raise exception 'ไม่พบบัญชีคู่รหัส %', p->>'counter_account' using errcode = 'ACC04'; end if;
    v_eid := acc.post_journal(p_company, v_date, 'ซื้อสินทรัพย์ ' || v_code || ' ' || v_name,
      jsonb_build_array(
        jsonb_build_object('account_code', a_asset.code, 'debit', v_cost::text, 'memo', v_code || ' ' || v_name),
        jsonb_build_object('account_code', a_counter.code, 'credit', v_cost::text, 'memo', v_code || ' ' || v_name)),
      p_idem, 'FA', null);
  end if;

  insert into acc.fixed_assets (company_id, code, name, acquired_date, dep_start, cost, salvage, life_months,
      asset_account_id, accum_account_id, expense_account_id, entry_id, description, idem_key, created_by)
  values (p_company, v_code, v_name, v_date, v_start, v_cost, v_salv, v_life, a_asset.id, a_accum.id, a_exp.id, v_eid,
      btrim(coalesce(p->>'description', '')), p_idem, app.current_user_id())
  returning id into v_id;
  return v_id;
end $$;

-- ---- ยกเลิกทะเบียน (ยังไม่ลงค่าเสื่อมและไม่จำหน่าย) กลับรายการ FA ถ้ามี ----
create function acc.void_fixed_asset(p_company uuid, p_asset uuid, p_date date, p_reason text, p_idem text) returns void
language plpgsql security definer set search_path = acc, pg_temp as $$
declare
  a acc.fixed_assets;
  v_rv uuid;
begin
  if not app.can_write_company(p_company) then
    raise exception 'ไม่มีสิทธิ์ทำรายการในบริษัทนี้' using errcode = '42501';
  end if;
  select * into a from acc.fixed_assets where company_id = p_company and id = p_asset for update;
  if not found then raise exception 'ไม่พบสินทรัพย์' using errcode = 'ACC04'; end if;
  if a.voided_at is not null then
    if a.void_entry_id is null or exists (select 1 from acc.idempotency_keys where company_id = p_company and key = p_idem and entry_id = a.void_entry_id) then
      return; -- คำขอซ้ำ
    end if;
    raise exception 'สินทรัพย์ % ยกเลิกไปแล้ว', a.code using errcode = 'ACC18';
  end if;
  if length(btrim(coalesce(p_reason, ''))) = 0 then raise exception 'ต้องระบุเหตุผลที่ยกเลิก' using errcode = '22023'; end if;
  if (select months from acc.asset_posted_months(p_company, a.id)) > 0
     or exists (select 1 from acc.asset_disposals where company_id = p_company and asset_id = a.id and voided_at is null) then
    raise exception 'สินทรัพย์ % ลงค่าเสื่อมราคาหรือจำหน่ายแล้ว กลับรายการเหล่านั้นก่อน', a.code using errcode = 'ACC18';
  end if;
  if a.entry_id is not null then
    v_rv := acc.reverse_journal(p_company, a.entry_id, coalesce(p_date, a.acquired_date), p_idem, 'ยกเลิกทะเบียนสินทรัพย์ ' || a.code || ': ' || btrim(p_reason));
  end if;
  update acc.fixed_assets set voided_at = now(), void_entry_id = v_rv, void_reason = btrim(p_reason)
   where company_id = p_company and id = a.id;
end $$;

-- ---- ลงค่าเสื่อมราคาประจำเดือน (AJ วันสิ้นเดือน) ----
-- ทุกสินทรัพย์ที่ยังไม่จำหน่าย: ลงเดือนที่ถึงกำหนดและยังไม่ได้ลงจนถึงเดือนนี้ (รวมเดือนก่อนที่ตกหล่น เช่น ลงทะเบียนย้อนหลัง)
create function acc.post_depreciation(p_company uuid, p_month date, p_idem text) returns uuid
language plpgsql security definer set search_path = acc, pg_temp as $$
declare
  v_id    uuid;
  v_month date := date_trunc('month', p_month)::date;
  v_end   date := (date_trunc('month', p_month) + interval '1 month - 1 day')::date;
  a       record;
  v_done  int;
  v_n     int;
  v_amt   numeric;
  v_sum   numeric;
  v_lines jsonb := '[]';
  v_je    jsonb := '[]';
  v_eid   uuid;
  v_total numeric := 0;
begin
  if not app.can_write_company(p_company) then
    raise exception 'ไม่มีสิทธิ์ทำรายการในบริษัทนี้' using errcode = '42501';
  end if;
  if p_idem is null or length(p_idem) < 8 then raise exception 'ต้องมี idempotency key' using errcode = 'ACC03'; end if;
  if p_month is null then raise exception 'ต้องระบุเดือน' using errcode = '22023'; end if;
  select id into v_id from acc.depreciation_runs where company_id = p_company and idem_key = p_idem;
  if found then return v_id; end if;

  -- ล็อกสินทรัพย์ตามลำดับ id กันลงค่าเสื่อมเดือนเดียวกันซ้ำเมื่อกดพร้อมกัน
  for a in select f.*, ea.code as exp_code, aa.code as accum_code
             from acc.fixed_assets f
             join acc.chart_of_accounts ea on ea.company_id = f.company_id and ea.id = f.expense_account_id
             join acc.chart_of_accounts aa on aa.company_id = f.company_id and aa.id = f.accum_account_id
            where f.company_id = p_company and f.voided_at is null and f.dep_start <= v_month
              and not exists (select 1 from acc.asset_disposals d where d.company_id = f.company_id and d.asset_id = f.id and d.voided_at is null)
            order by f.id for update of f loop
    select months into v_done from acc.asset_posted_months(p_company, a.id);
    v_n := least(a.life_months, app.months_between(a.dep_start, v_month) + 1);
    v_sum := 0;
    for i in v_done + 1 .. v_n loop
      v_amt := app.depreciation_cum(a.cost, a.salvage, a.life_months, i) - app.depreciation_cum(a.cost, a.salvage, a.life_months, i - 1);
      v_lines := v_lines || jsonb_build_object('asset', a.id, 'month', (a.dep_start + make_interval(months => i - 1))::date, 'seq', i, 'amount', v_amt);
      v_sum := v_sum + v_amt;
    end loop;
    if v_sum > 0 then
      v_je := v_je || jsonb_build_array(
        jsonb_build_object('account_code', a.exp_code, 'debit', v_sum::text, 'memo', a.code || ' ' || a.name),
        jsonb_build_object('account_code', a.accum_code, 'credit', v_sum::text, 'memo', a.code || ' ' || a.name));
      v_total := v_total + v_sum;
    end if;
  end loop;
  if jsonb_array_length(v_lines) = 0 then
    raise exception 'ไม่มีค่าเสื่อมราคาที่ต้องลงถึงเดือน %', acc.thai_month(v_month) using errcode = 'ACC18';
  end if;
  if v_total > 0 then
    v_eid := acc.post_journal(p_company, v_end, 'ค่าเสื่อมราคาประจำเดือน ' || acc.thai_month(v_month), v_je, p_idem, 'AJ', null);
  end if;
  insert into acc.depreciation_runs (company_id, month, entry_id, idem_key, created_by)
  values (p_company, v_month, v_eid, p_idem, app.current_user_id()) returning id into v_id;
  insert into acc.depreciation_lines (company_id, run_id, asset_id, dep_month, seq, amount)
  select p_company, v_id, (l->>'asset')::uuid, (l->>'month')::date, (l->>'seq')::int, (l->>'amount')::numeric
    from jsonb_array_elements(v_lines) l;
  return v_id;
end $$;

-- ---- กลับรายการค่าเสื่อม: เฉพาะรอบล่าสุดของสินทรัพย์ทุกตัวในรอบนั้น และสินทรัพย์ยังไม่จำหน่าย ----
create function acc.void_depreciation_run(p_company uuid, p_run uuid, p_date date, p_idem text) returns uuid
language plpgsql security definer set search_path = acc, pg_temp as $$
declare
  r    acc.depreciation_runs;
  v_rv uuid;
  v_code text;
begin
  if not app.can_write_company(p_company) then
    raise exception 'ไม่มีสิทธิ์ทำรายการในบริษัทนี้' using errcode = '42501';
  end if;
  perform 1 from acc.fixed_assets f where f.company_id = p_company
     and exists (select 1 from acc.depreciation_lines l where l.company_id = f.company_id and l.run_id = p_run and l.asset_id = f.id)
   order by f.id for update;
  select * into r from acc.depreciation_runs where company_id = p_company and id = p_run for update;
  if not found then raise exception 'ไม่พบรายการค่าเสื่อมราคา' using errcode = 'ACC04'; end if;
  if r.voided_at is not null then
    if r.void_entry_id is null or exists (select 1 from acc.idempotency_keys where company_id = p_company and key = p_idem and entry_id = r.void_entry_id) then
      return r.void_entry_id; -- คำขอซ้ำ
    end if;
    raise exception 'รายการค่าเสื่อมนี้กลับรายการไปแล้ว' using errcode = 'ACC18';
  end if;
  select f.code into v_code
    from acc.depreciation_lines l join acc.fixed_assets f on f.company_id = l.company_id and f.id = l.asset_id
   where l.company_id = p_company and l.run_id = r.id
     and (exists (select 1 from acc.depreciation_lines l2 join acc.depreciation_runs r2 on r2.company_id = l2.company_id and r2.id = l2.run_id
                   where l2.company_id = p_company and l2.asset_id = l.asset_id and r2.voided_at is null and l2.dep_month > l.dep_month
                     and r2.id <> r.id)
          or exists (select 1 from acc.asset_disposals d where d.company_id = p_company and d.asset_id = l.asset_id and d.voided_at is null))
   limit 1;
  if found then
    raise exception 'สินทรัพย์ % มีค่าเสื่อมเดือนถัดไปหรือจำหน่ายแล้ว กลับรายการที่ใหม่กว่าก่อน', v_code using errcode = 'ACC18';
  end if;
  if r.entry_id is not null then
    v_rv := acc.reverse_journal(p_company, r.entry_id, coalesce(p_date, (r.month + interval '1 month - 1 day')::date), p_idem,
                                'กลับรายการค่าเสื่อมราคาประจำเดือน ' || acc.thai_month(r.month));
  end if;
  update acc.depreciation_runs set voided_at = now(), void_entry_id = v_rv where company_id = p_company and id = r.id;
  return v_rv;
end $$;

-- ---- จำหน่าย / ขายสินทรัพย์ ----
-- ต้องลงค่าเสื่อมถึงเดือนก่อนเดือนที่จำหน่าย (ไม่คิดค่าเสื่อมเดือนที่จำหน่าย) และยังไม่ลงเดือนที่จำหน่ายหรือหลังจากนั้น
-- p: {date, proceeds?, proceeds_account?, description?}
-- เดบิต ค่าเสื่อมราคาสะสม + บัญชีรับเงิน (+ ขาดทุน 5320) / เครดิต ราคาทุน (+ กำไร 4330)
create function acc.dispose_fixed_asset(p_company uuid, p_asset uuid, p jsonb, p_idem text) returns uuid
language plpgsql security definer set search_path = acc, pg_temp as $$
declare
  a       acc.fixed_assets;
  v_id    uuid;
  v_date  date;
  v_proc  numeric;
  v_pacc  acc.chart_of_accounts;
  v_done  int;
  v_accum numeric;
  v_need  int;
  v_book  numeric;
  v_gain  numeric;
  v_asset text; v_acc text;
  v_je    jsonb;
  v_eid   uuid;
  v_label text;
begin
  if not app.can_write_company(p_company) then
    raise exception 'ไม่มีสิทธิ์ทำรายการในบริษัทนี้' using errcode = '42501';
  end if;
  if p_idem is null or length(p_idem) < 8 then raise exception 'ต้องมี idempotency key' using errcode = 'ACC03'; end if;
  select id into v_id from acc.asset_disposals where company_id = p_company and idem_key = p_idem;
  if found then return v_id; end if;
  perform acc.ensure_asset_accounts(p_company);
  select * into a from acc.fixed_assets where company_id = p_company and id = p_asset for update;
  if not found or a.voided_at is not null then raise exception 'ไม่พบสินทรัพย์' using errcode = 'ACC04'; end if;
  v_label := a.code || ' ' || a.name;
  if exists (select 1 from acc.asset_disposals where company_id = p_company and asset_id = a.id and voided_at is null) then
    raise exception 'สินทรัพย์ % จำหน่ายไปแล้ว', a.code using errcode = 'ACC18';
  end if;
  begin
    v_date := (p->>'date')::date;
    v_proc := coalesce(nullif(p->>'proceeds', '')::numeric, 0);
  exception when others then raise exception 'วันที่หรือราคาขายไม่ถูกต้อง' using errcode = '22023';
  end;
  if v_date is null then raise exception 'ต้องมีวันที่จำหน่าย' using errcode = '22023'; end if;
  if v_date < a.acquired_date then raise exception 'วันที่จำหน่ายต้องไม่ก่อนวันที่ได้มา' using errcode = '22023'; end if;
  if v_proc < 0 or v_proc <> round(v_proc, 2) then
    raise exception 'ราคาขายต้องไม่ติดลบ ทศนิยมไม่เกิน 2 ตำแหน่ง' using errcode = 'ACC05';
  end if;
  if v_proc > 0 then
    select * into v_pacc from acc.chart_of_accounts where company_id = p_company and code = p->>'proceeds_account' and active
       and id not in (a.asset_account_id, a.accum_account_id);
    if not found then raise exception 'ต้องเลือกบัญชีที่รับเงินค่าขาย' using errcode = 'ACC04'; end if;
  end if;

  select months, accumulated into v_done, v_accum from acc.asset_posted_months(p_company, a.id);
  v_need := greatest(0, least(a.life_months, app.months_between(a.dep_start, date_trunc('month', v_date)::date)));
  if v_done < v_need then
    raise exception 'ลงค่าเสื่อมราคาของ % ถึงเดือน % ก่อนจำหน่าย', a.code,
      acc.thai_month((a.dep_start + make_interval(months => v_need - 1))::date) using errcode = 'ACC18';
  end if;
  if v_done > v_need then
    raise exception '% ลงค่าเสื่อมเดือน % แล้ว จำหน่ายก่อนเดือนนั้นไม่ได้ (กลับรายการค่าเสื่อมเดือนนั้นก่อน หรือเลือกวันที่หลังจากนั้น)',
      a.code, acc.thai_month((a.dep_start + make_interval(months => v_done - 1))::date) using errcode = 'ACC18';
  end if;
  v_book := a.cost - v_accum;
  v_gain := v_proc - v_book;
  select code into v_asset from acc.chart_of_accounts where company_id = p_company and id = a.asset_account_id;
  select code into v_acc from acc.chart_of_accounts where company_id = p_company and id = a.accum_account_id;

  v_je := '[]';
  if v_accum > 0 then v_je := v_je || jsonb_build_object('account_code', v_acc, 'debit', v_accum::text, 'memo', v_label); end if;
  if v_proc > 0 then v_je := v_je || jsonb_build_object('account_code', v_pacc.code, 'debit', v_proc::text, 'memo', v_label); end if;
  if v_gain < 0 then v_je := v_je || jsonb_build_object('account_code', '5320', 'debit', (-v_gain)::text, 'memo', v_label); end if;
  v_je := v_je || jsonb_build_object('account_code', v_asset, 'credit', a.cost::text, 'memo', v_label);
  if v_gain > 0 then v_je := v_je || jsonb_build_object('account_code', '4330', 'credit', v_gain::text, 'memo', v_label); end if;
  v_eid := acc.post_journal(p_company, v_date,
    coalesce(nullif(btrim(p->>'description'), ''), case when v_proc > 0 then 'ขายสินทรัพย์ ' else 'ตัดจำหน่ายสินทรัพย์ ' end || v_label),
    v_je, p_idem, 'FD', null);
  insert into acc.asset_disposals (company_id, asset_id, disposal_date, proceeds, proceeds_account_id, accumulated, book_value, gain_loss,
      entry_id, description, idem_key, created_by)
  values (p_company, a.id, v_date, v_proc, v_pacc.id, v_accum, v_book, v_gain, v_eid, btrim(coalesce(p->>'description', '')), p_idem,
      app.current_user_id())
  returning id into v_id;
  return v_id;
end $$;

create function acc.void_asset_disposal(p_company uuid, p_disposal uuid, p_date date, p_reason text, p_idem text) returns uuid
language plpgsql security definer set search_path = acc, pg_temp as $$
declare
  d acc.asset_disposals;
  v_rv uuid;
begin
  if not app.can_write_company(p_company) then
    raise exception 'ไม่มีสิทธิ์ทำรายการในบริษัทนี้' using errcode = '42501';
  end if;
  select * into d from acc.asset_disposals where company_id = p_company and id = p_disposal for update;
  if not found then raise exception 'ไม่พบรายการจำหน่าย' using errcode = 'ACC04'; end if;
  if d.voided_at is not null then
    if exists (select 1 from acc.idempotency_keys where company_id = p_company and key = p_idem and entry_id = d.void_entry_id) then
      return d.void_entry_id;
    end if;
    raise exception 'รายการจำหน่ายนี้กลับรายการไปแล้ว' using errcode = 'ACC18';
  end if;
  if length(btrim(coalesce(p_reason, ''))) = 0 then raise exception 'ต้องระบุเหตุผล' using errcode = '22023'; end if;
  v_rv := acc.reverse_journal(p_company, d.entry_id, coalesce(p_date, d.disposal_date), p_idem,
                              'กลับรายการจำหน่ายสินทรัพย์: ' || btrim(p_reason));
  update acc.asset_disposals set voided_at = now(), void_entry_id = v_rv, void_reason = btrim(p_reason)
   where company_id = p_company and id = d.id;
  return v_rv;
end $$;

-- ---- รายงานทะเบียนสินทรัพย์ ณ สิ้นเดือน (invoker: RLS ใช้กับผู้เรียก) ----
-- ค่าเสื่อมสะสม = ค่าเสื่อมที่ลงแล้วของเดือนไม่เกินเดือนที่เลือก · จำหน่ายก่อน/ในเดือนนั้น = มูลค่าตามบัญชี 0
create function acc.fixed_asset_register(p_company uuid, p_month date)
returns table (id uuid, code text, name text, acquired_date date, dep_start date, cost numeric, salvage numeric, life_months int,
               monthly numeric, asset_code text, accum_code text, expense_code text, months_posted int, accumulated numeric,
               dep_this_month numeric, book_value numeric, status text, disposal_id uuid, disposal_date date, proceeds numeric,
               gain_loss numeric, entry_id uuid, disposal_entry_id uuid, next_month date, voided boolean)
language sql stable as $$
  with m as (select date_trunc('month', p_month)::date as s, (date_trunc('month', p_month) + interval '1 month - 1 day')::date as e)
  select f.id, f.code, f.name, f.acquired_date, f.dep_start, f.cost, f.salvage, f.life_months,
         round((f.cost - f.salvage) / f.life_months, 2), aa.code, ac.code, ae.code,
         coalesce(x.months, 0), coalesce(x.accumulated, 0)::numeric(18,2), coalesce(x.this_month, 0)::numeric(18,2),
         (case when d.id is not null and d.disposal_date <= m.e then 0 else f.cost - coalesce(x.accumulated, 0) end)::numeric(18,2),
         case when f.voided_at is not null then 'voided'
              when d.id is not null and d.disposal_date <= m.e then 'disposed'
              when coalesce(t.months, 0) >= f.life_months then 'fully_depreciated'
              else 'active' end,
         d.id, d.disposal_date, d.proceeds, d.gain_loss, f.entry_id, d.entry_id,
         case when f.voided_at is null and d.id is null and coalesce(t.months, 0) < f.life_months
              then (f.dep_start + make_interval(months => coalesce(t.months, 0)))::date end,
         f.voided_at is not null
    from acc.fixed_assets f cross join m
    join acc.chart_of_accounts aa on aa.company_id = f.company_id and aa.id = f.asset_account_id
    join acc.chart_of_accounts ac on ac.company_id = f.company_id and ac.id = f.accum_account_id
    join acc.chart_of_accounts ae on ae.company_id = f.company_id and ae.id = f.expense_account_id
    left join acc.asset_disposals d on d.company_id = f.company_id and d.asset_id = f.id and d.voided_at is null
    left join lateral (
      select count(*)::int months, sum(l.amount) accumulated, sum(l.amount) filter (where l.dep_month = m.s) this_month
        from acc.depreciation_lines l join acc.depreciation_runs r on r.company_id = l.company_id and r.id = l.run_id
       where l.company_id = f.company_id and l.asset_id = f.id and r.voided_at is null and l.dep_month <= m.s) x on true
    left join lateral (select months from acc.asset_posted_months(f.company_id, f.id)) t on true
   where f.company_id = p_company and f.acquired_date <= m.e
   order by f.code, f.created_at
$$;

revoke all on function acc.ensure_asset_accounts(uuid), acc.register_fixed_asset(uuid, jsonb, text),
  acc.void_fixed_asset(uuid, uuid, date, text, text), acc.post_depreciation(uuid, date, text),
  acc.void_depreciation_run(uuid, uuid, date, text), acc.dispose_fixed_asset(uuid, uuid, jsonb, text),
  acc.void_asset_disposal(uuid, uuid, date, text, text) from public;
grant execute on function acc.register_fixed_asset(uuid, jsonb, text), acc.void_fixed_asset(uuid, uuid, date, text, text),
  acc.post_depreciation(uuid, date, text), acc.void_depreciation_run(uuid, uuid, date, text),
  acc.dispose_fixed_asset(uuid, uuid, jsonb, text), acc.void_asset_disposal(uuid, uuid, date, text, text) to app_rw;
grant execute on function acc.asset_posted_months(uuid, uuid), acc.fixed_asset_register(uuid, date), acc.thai_month(date) to app_rw, app_ro;

-- migrate:down
drop function acc.fixed_asset_register(uuid, date), acc.void_asset_disposal(uuid, uuid, date, text, text),
  acc.dispose_fixed_asset(uuid, uuid, jsonb, text), acc.void_depreciation_run(uuid, uuid, date, text),
  acc.post_depreciation(uuid, date, text), acc.void_fixed_asset(uuid, uuid, date, text, text),
  acc.register_fixed_asset(uuid, jsonb, text), acc.thai_month(date), acc.asset_posted_months(uuid, uuid);
drop table acc.asset_disposals, acc.depreciation_lines, acc.depreciation_runs, acc.fixed_assets;
drop function acc.guard_void_only(), app.months_between(date, date), app.depreciation_cum(numeric, numeric, int, int),
  acc.ensure_asset_accounts(uuid);
delete from acc.chart_of_accounts a where a.code in ('4330', '5320')
  and not exists (select 1 from acc.journal_lines l where l.company_id = a.company_id and l.account_id = a.id);
delete from acc.coa_template where code in ('4330', '5320');
