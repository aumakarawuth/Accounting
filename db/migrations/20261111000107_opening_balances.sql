-- migrate:up
-- ยอดยกมาพร้อมรายตัว (docs/phase5-spec.md ข้อ 3, docs/assumptions.md ข้อ 42)
-- ชุดเดียวต่อบริษัท ลงเป็นรายการ OB ผ่าน acc.post_journal: ยอดบัญชีทั่วไป + ลูกหนี้/เจ้าหนี้รายใบ + สินทรัพย์พร้อมค่าเสื่อมสะสม + สินค้า
-- บัญชีคุมสร้างจากรายตัวเท่านั้น ทะเบียนย่อยจึงเท่ายอดคุมเสมอ · ยกเลิกได้ทั้งชุดเมื่อยังไม่มีรายการอ้าง

create table acc.opening_balances (
  id            uuid not null default gen_random_uuid(),
  company_id    uuid not null references acc.companies(id),
  as_of         date not null,
  entry_id      uuid not null,
  idem_key      text not null,
  created_by    uuid not null references acc.users(id),
  created_at    timestamptz not null default now(),
  voided_at     timestamptz,
  void_entry_id uuid,
  void_reason   text check (length(void_reason) <= 300),
  primary key (company_id, id),
  unique (company_id, idem_key),
  foreign key (company_id, entry_id) references acc.journal_entries(company_id, id),
  foreign key (company_id, void_entry_id) references acc.journal_entries(company_id, id),
  check ((voided_at is null) = (void_entry_id is null))
);
create unique index opening_balances_active on acc.opening_balances (company_id) where voided_at is null;
create trigger opening_balances_guard before update or delete on acc.opening_balances
  for each row execute function acc.guard_void_only();
create trigger opening_balances_locked before insert or update on acc.opening_balances
  for each row execute function acc.guard_locked_company();
create trigger audit_opening_balances after insert or update on acc.opening_balances
  for each row execute function acc.audit_row();
alter table acc.opening_balances enable row level security;
grant select on acc.opening_balances to app_rw, app_ro;
create policy opening_balances_read on acc.opening_balances for select to app_rw, app_ro
  using (company_id in (select app.readable_company_ids()));

-- รายตัวที่มาจากยอดยกมา
alter table acc.documents add column opening_id uuid;
alter table acc.documents add constraint documents_opening_fk foreign key (company_id, opening_id) references acc.opening_balances(company_id, id);
alter table acc.purchase_documents add column opening_id uuid;
alter table acc.purchase_documents add constraint purchase_documents_opening_fk foreign key (company_id, opening_id) references acc.opening_balances(company_id, id);
alter table acc.fixed_assets add column opening_id uuid,
  add column opening_months int not null default 0 check (opening_months >= 0),
  add column opening_accumulated numeric(18,2) not null default 0 check (opening_accumulated >= 0),
  add constraint fixed_assets_opening_fk foreign key (company_id, opening_id) references acc.opening_balances(company_id, id),
  add constraint fixed_assets_opening_check check (opening_id is not null or (opening_months = 0 and opening_accumulated = 0)),
  add constraint fixed_assets_opening_life check (opening_months <= life_months and opening_accumulated <= cost - salvage);

-- รายตัวยกมายกเลิกทีละรายการไม่ได้ (ยกเลิกทั้งชุดผ่าน acc.void_opening_balances)
create function acc.guard_opening_item_void() returns trigger
language plpgsql set search_path = acc, pg_temp as $$
begin
  if old.opening_id is not null and old.voided_at is null and new.voided_at is not null
     and coalesce(current_setting('acc.opening', true), '') <> 'on' then
    raise exception 'รายการนี้มาจากยอดยกมา ยกเลิกทีละรายการไม่ได้ ให้ยกเลิกยอดยกมาทั้งชุดที่หน้ายอดยกมา' using errcode = 'ACC16';
  end if;
  return new;
end $$;
create trigger documents_opening_void before update on acc.documents
  for each row execute function acc.guard_opening_item_void();
create trigger purchase_documents_opening_void before update on acc.purchase_documents
  for each row execute function acc.guard_opening_item_void();
create trigger fixed_assets_opening_void before update on acc.fixed_assets
  for each row execute function acc.guard_opening_item_void();

-- รายการ OB ลง/กลับได้จากฟังก์ชันยอดยกมาเท่านั้น
create function acc.guard_opening_entry() returns trigger
language plpgsql set search_path = acc, pg_temp as $$
begin
  if coalesce(current_setting('acc.opening', true), '') = 'on' then return new; end if;
  if new.doc_prefix = 'OB' then
    raise exception 'รายการยอดยกมา (OB) ลงได้จากหน้ายอดยกมาเท่านั้น' using errcode = 'ACC16';
  end if;
  if new.reverses_entry_id is not null and exists (
       select 1 from acc.journal_entries o where o.company_id = new.company_id and o.id = new.reverses_entry_id and o.doc_prefix = 'OB') then
    raise exception 'กลับรายการยอดยกมาจากสมุดรายวันไม่ได้ ให้ยกเลิกยอดยกมาทั้งชุดที่หน้ายอดยกมา' using errcode = 'ACC16';
  end if;
  return new;
end $$;
create trigger journal_entries_opening before insert on acc.journal_entries
  for each row execute function acc.guard_opening_entry();

-- เดือนที่ลงค่าเสื่อมแล้ว = ยกมา + รอบที่ไม่ถูกกลับรายการ
create or replace function acc.asset_posted_months(p_company uuid, p_asset uuid, out months int, out accumulated numeric)
language sql stable set search_path = acc, pg_temp as $$
  select f.opening_months + coalesce(x.n, 0), f.opening_accumulated + coalesce(x.amt, 0)
    from acc.fixed_assets f
    left join lateral (
      select count(*)::int n, sum(l.amount) amt
        from acc.depreciation_lines l join acc.depreciation_runs r on r.company_id = l.company_id and r.id = l.run_id
       where l.company_id = f.company_id and l.asset_id = f.id and r.voided_at is null) x on true
   where f.company_id = p_company and f.id = p_asset
$$;

-- ทะเบียนสินทรัพย์ ณ สิ้นเดือน: รวมค่าเสื่อมสะสมยกมา
create or replace function acc.fixed_asset_register(p_company uuid, p_month date)
returns table (id uuid, code text, name text, acquired_date date, dep_start date, cost numeric, salvage numeric, life_months int,
               monthly numeric, asset_code text, accum_code text, expense_code text, months_posted int, accumulated numeric,
               dep_this_month numeric, book_value numeric, status text, disposal_id uuid, disposal_date date, proceeds numeric,
               gain_loss numeric, entry_id uuid, disposal_entry_id uuid, next_month date, voided boolean)
language sql stable set search_path = acc, pg_temp as $$
  with m as (select date_trunc('month', p_month)::date as s, (date_trunc('month', p_month) + interval '1 month - 1 day')::date as e)
  select f.id, f.code, f.name, f.acquired_date, f.dep_start, f.cost, f.salvage, f.life_months,
         round((f.cost - f.salvage) / f.life_months, 2), aa.code, ac.code, ae.code,
         f.opening_months + coalesce(x.months, 0), (f.opening_accumulated + coalesce(x.accumulated, 0))::numeric(18,2),
         coalesce(x.this_month, 0)::numeric(18,2),
         (case when d.id is not null and d.disposal_date <= m.e then 0 else f.cost - f.opening_accumulated - coalesce(x.accumulated, 0) end)::numeric(18,2),
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

-- ---- ลงยอดยกมา ----
-- p: {date, accounts: [{code, debit?, credit?}],
--     receivables: [{party_code, ref, date, due_date?, amount, undue_vat?}],
--     payables:    [{party_code, ref, date, due_date?, amount, undue_vat?}],
--     assets:      [{code, name, acquired_date, dep_start?, cost, salvage?, life_months, asset_account, accum_account, expense_account?, accumulated}],
--     inventory:   [{item_code, qty, unit_cost}]}
create function acc.post_opening_balances(p_company uuid, p jsonb, p_key text) returns uuid
language plpgsql security definer set search_path = acc, pg_temp as $$
declare
  co      acc.companies;
  pa      acc.parties;
  it      acc.items;
  v_id    uuid;
  v_date  date;
  v_first date;
  v_eid   uuid;
  v_lines jsonb := '[]';
  v_ctl   text[] := array['1210', '2110', '2211', '1411'];
  v_tracked boolean;
  r       record;
  v_n     int := 0;
  v_ref   text; v_d date; v_due date; v_amt numeric; v_vat numeric;
  v_code  text; v_cost numeric; v_salv numeric; v_life int; v_start date; v_acc numeric; v_months int; v_expect numeric;
  a_asset acc.chart_of_accounts; a_accum acc.chart_of_accounts; a_exp acc.chart_of_accounts;
  v_qty   numeric; v_unit numeric; v_val numeric;
  ar_total numeric := 0; ar_vat numeric := 0; ap_total numeric := 0; ap_vat numeric := 0; inv_total numeric := 0;
  v_assets jsonb := '{}';  -- รหัสบัญชี → ยอด (เดบิตบวก เครดิตลบ)
  v_ob    text;            -- เลขที่ OB ใช้นำหน้าเลขที่ใบยกมา (OB-0001/INV-901) ลงใหม่หลังยกเลิกจึงไม่ชนเลขเดิม
begin
  if not app.can_write_company(p_company) then
    raise exception 'ไม่มีสิทธิ์ลงบัญชีในบริษัทนี้' using errcode = '42501';
  end if;
  if p_key is null or length(p_key) < 8 then raise exception 'ต้องมี idempotency key' using errcode = 'ACC03'; end if;
  perform pg_advisory_xact_lock(hashtextextended('opening:' || p_company::text, 0));
  select id into v_id from acc.opening_balances where company_id = p_company and idem_key = p_key;
  if found then return v_id; end if;
  if exists (select 1 from acc.opening_balances where company_id = p_company and voided_at is null) then
    raise exception 'บริษัทนี้ลงยอดยกมาแล้ว ถ้าต้องแก้ให้ยกเลิกยอดยกมาชุดเดิมก่อน' using errcode = 'ACC21';
  end if;
  select * into co from acc.companies where id = p_company;
  begin
    v_date := (p->>'date')::date;
  exception when others then raise exception 'วันที่ยกมาไม่ถูกต้อง' using errcode = '22023';
  end;
  if v_date is null then raise exception 'ต้องมีวันที่ยกมา' using errcode = '22023'; end if;
  -- ไม่นับยอดยกมาชุดที่ยกเลิกแล้ว (OB และรายการกลับของมัน)
  select min(e.entry_date) into v_first from acc.journal_entries e
   where e.company_id = p_company and e.entry_date <= v_date and e.doc_prefix <> 'OB'
     and not exists (select 1 from acc.journal_entries o where o.company_id = e.company_id and o.id = e.reverses_entry_id and o.doc_prefix = 'OB');
  if v_first is not null then
    raise exception 'มีรายการวันที่ % อยู่แล้ว วันยกมาต้องก่อนรายการอื่นทุกรายการ', acc.thai_date(v_first) using errcode = 'ACC21';
  end if;
  perform acc.ensure_tax_accounts(p_company);
  perform acc.ensure_asset_accounts(p_company);
  v_tracked := exists (select 1 from acc.items where company_id = p_company and track_inventory);
  if v_tracked or jsonb_array_length(coalesce(p->'inventory', '[]')) > 0 then v_ctl := v_ctl || '1310'::text; end if;

  -- สินทรัพย์ (ตรวจก่อน เพื่อรู้บัญชีคุมของสินทรัพย์)
  for r in select x.value as j, x.ord from jsonb_array_elements(coalesce(p->'assets', '[]')) with ordinality x(value, ord) loop
    v_code := upper(btrim(coalesce(r.j->>'code', '')));
    if v_code !~ '^[A-Z0-9][A-Z0-9-]{0,19}$' then
      raise exception 'สินทรัพย์บรรทัดที่ %: รหัสเป็นตัวพิมพ์ใหญ่ ตัวเลข และขีด ไม่เกิน 20 ตัว', r.ord using errcode = '22023';
    end if;
    if length(btrim(coalesce(r.j->>'name', ''))) not between 1 and 160 then
      raise exception 'สินทรัพย์ %: ต้องมีชื่อ', v_code using errcode = '22023';
    end if;
    begin
      v_d := (r.j->>'acquired_date')::date;
      v_start := date_trunc('month', coalesce(nullif(r.j->>'dep_start', '')::date, v_d))::date;
      v_cost := (r.j->>'cost')::numeric; v_salv := coalesce(nullif(r.j->>'salvage', '')::numeric, 0);
      v_life := (r.j->>'life_months')::int; v_acc := coalesce(nullif(r.j->>'accumulated', '')::numeric, 0);
    exception when others then
      raise exception 'สินทรัพย์ %: วันที่ ราคาทุน ราคาซาก อายุ หรือค่าเสื่อมสะสมไม่ถูกต้อง', v_code using errcode = '22023';
    end;
    if v_d is null or v_d > v_date then
      raise exception 'สินทรัพย์ %: วันที่ได้มาต้องไม่หลังวันยกมา', v_code using errcode = '22023';
    end if;
    if v_start < date_trunc('month', v_d)::date then
      raise exception 'สินทรัพย์ %: เดือนเริ่มคิดค่าเสื่อมต้องไม่ก่อนเดือนที่ได้มา', v_code using errcode = '22023';
    end if;
    if v_cost is null or v_cost <= 0 or v_cost <> round(v_cost, 2) or v_salv < 0 or v_salv <> round(v_salv, 2) or v_salv >= v_cost
       or v_acc < 0 or v_acc <> round(v_acc, 2) then
      raise exception 'สินทรัพย์ %: ราคาทุนต้องมากกว่าราคาซาก ค่าเสื่อมสะสมไม่ติดลบ ทศนิยมไม่เกิน 2 ตำแหน่ง', v_code using errcode = 'ACC05';
    end if;
    if v_life is null or v_life not between 1 and 1200 then
      raise exception 'สินทรัพย์ %: อายุใช้งานต้องเป็น 1–1,200 เดือน', v_code using errcode = '22023';
    end if;
    -- เดือนที่ครบแล้ว ณ วันยกมา (เดือนของวันยกมานับเมื่อวันยกมาเป็นวันสิ้นเดือน)
    v_months := greatest(0, least(v_life, app.months_between(v_start, date_trunc('month', v_date + 1)::date)));
    v_expect := app.depreciation_cum(v_cost, v_salv, v_life, v_months);
    if v_acc <> v_expect then
      raise exception 'สินทรัพย์ %: ค่าเสื่อมราคาสะสม ณ % ต้องเป็น % (เส้นตรง % เดือน เดือนละ %)', v_code, acc.thai_date(v_date),
        to_char(v_expect, 'FM999,999,999,990.00'), v_months, to_char(round((v_cost - v_salv) / v_life, 2), 'FM999,999,999,990.00')
        using errcode = 'ACC05';
    end if;
    select * into a_asset from acc.chart_of_accounts
     where company_id = p_company and code = r.j->>'asset_account' and active and type = 'asset' and code like '16%';
    if not found then raise exception 'สินทรัพย์ %: บัญชีสินทรัพย์ต้องเป็นบัญชี 16xx', v_code using errcode = 'ACC04'; end if;
    select * into a_accum from acc.chart_of_accounts
     where company_id = p_company and code = r.j->>'accum_account' and active and type = 'asset' and code like '16%' and code <> a_asset.code;
    if not found then raise exception 'สินทรัพย์ %: บัญชีค่าเสื่อมราคาสะสมต้องเป็นบัญชี 16xx อีกบัญชีหนึ่ง', v_code using errcode = 'ACC04'; end if;
    v_assets := jsonb_set(v_assets, array[a_asset.code], to_jsonb(coalesce((v_assets->>a_asset.code)::numeric, 0) + v_cost));
    if v_acc > 0 then
      v_assets := jsonb_set(v_assets, array[a_accum.code], to_jsonb(coalesce((v_assets->>a_accum.code)::numeric, 0) - v_acc));
    end if;
    v_ctl := v_ctl || a_asset.code || a_accum.code;
  end loop;

  -- ยอดบัญชีทั่วไปที่พิมพ์เอง: ห้ามบัญชีคุม
  for r in select x.value as j, x.ord from jsonb_array_elements(coalesce(p->'accounts', '[]')) with ordinality x(value, ord) loop
    if (r.j->>'code') = any (v_ctl) then
      raise exception 'บัญชี % เป็นบัญชีคุม ยอดมาจากรายตัว (ลูกหนี้ เจ้าหนี้ สินทรัพย์ สินค้า) ใส่ในส่วนนั้นแทน', r.j->>'code' using errcode = 'ACC21';
    end if;
    v_lines := v_lines || jsonb_build_object('account_code', r.j->>'code', 'debit', coalesce(r.j->>'debit', '0'),
                                             'credit', coalesce(r.j->>'credit', '0'), 'memo', 'ยอดยกมา');
  end loop;

  -- ลูกหนี้ / เจ้าหนี้รายใบ (ตรวจ + รวมยอด)
  for r in select x.value as j, x.ord, 'ar' as side from jsonb_array_elements(coalesce(p->'receivables', '[]')) with ordinality x(value, ord)
           union all
           select x.value, x.ord, 'ap' from jsonb_array_elements(coalesce(p->'payables', '[]')) with ordinality x(value, ord) loop
    v_ref := btrim(coalesce(r.j->>'ref', ''));
    if v_ref !~ '^[A-Za-z0-9][A-Za-z0-9/-]{0,19}$' then
      raise exception '%บรรทัดที่ %: เลขที่ใบเดิมเป็นตัวอักษรอังกฤษ ตัวเลข / และ - ไม่เกิน 20 ตัว',
        case r.side when 'ar' then 'ลูกหนี้' else 'เจ้าหนี้' end, r.ord using errcode = '22023';
    end if;
    select * into pa from acc.parties where company_id = p_company and code = r.j->>'party_code' and active
       and (case r.side when 'ar' then is_customer else is_vendor end);
    if not found then
      raise exception '%: ไม่พบ% %', v_ref, case r.side when 'ar' then 'ลูกค้า' else 'ผู้ขาย' end, coalesce(r.j->>'party_code', '(ว่าง)')
        using errcode = 'ACC04';
    end if;
    begin
      v_d := (r.j->>'date')::date; v_due := nullif(r.j->>'due_date', '')::date;
      v_amt := (r.j->>'amount')::numeric; v_vat := coalesce(nullif(r.j->>'undue_vat', '')::numeric, 0);
    exception when others then raise exception '%: วันที่หรือจำนวนเงินไม่ถูกต้อง', v_ref using errcode = '22023';
    end;
    if v_d is null or v_d > v_date then raise exception '%: วันที่ใบต้องไม่หลังวันยกมา', v_ref using errcode = '22023'; end if;
    if v_due is not null and v_due < v_d then raise exception '%: วันครบกำหนดต้องไม่ก่อนวันที่ใบ', v_ref using errcode = '22023'; end if;
    if v_amt is null or v_amt <= 0 or v_amt <> round(v_amt, 2) or v_vat < 0 or v_vat <> round(v_vat, 2) or v_vat >= v_amt then
      raise exception '%: ยอดค้างต้องมากกว่า 0 ภาษียังไม่ถึงกำหนดน้อยกว่ายอดค้าง ทศนิยมไม่เกิน 2 ตำแหน่ง', v_ref using errcode = 'ACC05';
    end if;
    if v_vat > 0 and not co.vat_registered then
      raise exception '%: บริษัทไม่จด VAT ไม่มีภาษียังไม่ถึงกำหนด', v_ref using errcode = '22023';
    end if;
    if r.side = 'ar' then ar_total := ar_total + v_amt; ar_vat := ar_vat + v_vat;
    else ap_total := ap_total + v_amt; ap_vat := ap_vat + v_vat; end if;
  end loop;

  -- สินค้า
  for r in select x.value as j, x.ord from jsonb_array_elements(coalesce(p->'inventory', '[]')) with ordinality x(value, ord) loop
    select * into it from acc.items where company_id = p_company and code = r.j->>'item_code' and active and track_inventory;
    if not found then
      raise exception 'สินค้าบรรทัดที่ %: ไม่พบสินค้าที่ติดตามสต็อกรหัส %', r.ord, coalesce(r.j->>'item_code', '(ว่าง)') using errcode = 'ACC04';
    end if;
    begin
      v_qty := (r.j->>'qty')::numeric; v_unit := (r.j->>'unit_cost')::numeric;
    exception when others then raise exception 'สินค้า %: จำนวนหรือต้นทุนไม่ถูกต้อง', it.code using errcode = '22023';
    end;
    if v_qty is null or v_qty <= 0 or v_qty <> round(v_qty, 3) or v_unit is null or v_unit < 0 or v_unit <> round(v_unit, 6)
       or round(v_qty * v_unit, 2) <= 0 then
      raise exception 'สินค้า %: จำนวนและมูลค่าต้องมากกว่า 0 (จำนวนทศนิยม 3 ต้นทุนทศนิยม 6 ตำแหน่ง)', it.code using errcode = 'ACC05';
    end if;
    if (select count(*) from jsonb_array_elements(p->'inventory') y where y->>'item_code' = it.code) > 1 then
      raise exception 'สินค้า % ใส่ซ้ำ รวมเป็นบรรทัดเดียว', it.code using errcode = '22023';
    end if;
    inv_total := inv_total + round(v_qty * v_unit, 2);
  end loop;

  -- บรรทัดบัญชีคุมจากรายตัว
  if ar_total > 0 then v_lines := v_lines || jsonb_build_object('account_code', '1210', 'debit', ar_total::text, 'memo', 'ลูกหนี้ยกมา'); end if;
  if ar_vat > 0 then v_lines := v_lines || jsonb_build_object('account_code', '2211', 'credit', ar_vat::text, 'memo', 'ลูกหนี้ยกมา'); end if;
  if ap_vat > 0 then v_lines := v_lines || jsonb_build_object('account_code', '1411', 'debit', ap_vat::text, 'memo', 'เจ้าหนี้ยกมา'); end if;
  if ap_total > 0 then v_lines := v_lines || jsonb_build_object('account_code', '2110', 'credit', ap_total::text, 'memo', 'เจ้าหนี้ยกมา'); end if;
  if inv_total > 0 then v_lines := v_lines || jsonb_build_object('account_code', '1310', 'debit', inv_total::text, 'memo', 'สินค้ายกมา'); end if;
  for r in select key, value::numeric as amt from jsonb_each_text(v_assets) order by key loop
    v_lines := v_lines || case when r.amt > 0
      then jsonb_build_object('account_code', r.key, 'debit', r.amt::text, 'memo', 'สินทรัพย์ยกมา')
      else jsonb_build_object('account_code', r.key, 'credit', (-r.amt)::text, 'memo', 'ค่าเสื่อมราคาสะสมยกมา') end;
  end loop;

  perform set_config('acc.opening', 'on', true);
  v_eid := acc.post_journal(p_company, v_date, 'ยอดยกมา ณ ' || acc.thai_date(v_date), v_lines, p_key, 'OB');
  select doc_no into v_ob from acc.journal_entries where company_id = p_company and id = v_eid;
  insert into acc.opening_balances (company_id, as_of, entry_id, idem_key, created_by)
  values (p_company, v_date, v_eid, p_key, app.current_user_id()) returning id into v_id;

  -- ลูกหนี้: ใบแจ้งหนี้ยกมา (ไม่ใช่ใบกำกับภาษี) รับชำระได้เหมือนใบขายเชื่อ
  for r in select x.value as j, x.ord from jsonb_array_elements(coalesce(p->'receivables', '[]')) with ordinality x(value, ord) loop
    select * into pa from acc.parties where company_id = p_company and code = r.j->>'party_code';
    v_amt := (r.j->>'amount')::numeric; v_vat := coalesce(nullif(r.j->>'undue_vat', '')::numeric, 0);
    v_d := (r.j->>'date')::date;
    insert into acc.documents (company_id, kind, doc_no, doc_date, party_id, party_code, party_name, party_tax_id, party_branch_no,
        party_address, seller_name, seller_tax_id, seller_branch_no, seller_address, is_service, is_tax_invoice, price_mode, vat_rate,
        gross, discount, base, vat, total, credit_days, due_date, description, entry_id, idem_key, created_by, opening_id)
    values (p_company, 'sales_invoice', v_ob || '/' || upper(btrim(r.j->>'ref')), v_d, pa.id, pa.code, pa.name, pa.tax_id, pa.branch_no,
        pa.address, co.name, co.tax_id, co.branch_no, co.address, v_vat > 0, false, case when v_vat > 0 then 'exclusive' else 'none' end,
        co.vat_rate, v_amt, 0, v_amt - v_vat, v_vat, v_amt, null,
        coalesce(nullif(r.j->>'due_date', '')::date, v_d + pa.credit_days), 'ลูกหนี้ยกมา ' || btrim(r.j->>'ref'),
        v_eid, p_key || ':ar:' || r.ord, app.current_user_id(), v_id);
  end loop;
  -- เจ้าหนี้: ใบของผู้ขายยกมา จ่ายชำระได้เหมือนใบซื้อเชื่อ
  for r in select x.value as j, x.ord from jsonb_array_elements(coalesce(p->'payables', '[]')) with ordinality x(value, ord) loop
    select * into pa from acc.parties where company_id = p_company and code = r.j->>'party_code';
    v_amt := (r.j->>'amount')::numeric; v_vat := coalesce(nullif(r.j->>'undue_vat', '')::numeric, 0);
    v_d := (r.j->>'date')::date;
    insert into acc.purchase_documents (company_id, kind, doc_no, doc_date, vendor_doc_no, party_id, party_code, party_name, party_tax_id,
        party_branch_no, party_address, is_service, vat_claimable, price_mode, vat_rate, gross, discount, base, vat, total,
        credit_days, due_date, description, entry_id, idem_key, created_by, opening_id)
    values (p_company, 'purchase_invoice', v_ob || '/' || upper(btrim(r.j->>'ref')), v_d, btrim(r.j->>'ref'), pa.id, pa.code, pa.name,
        pa.tax_id, pa.branch_no, pa.address, v_vat > 0, v_vat > 0, case when v_vat > 0 then 'exclusive' else 'none' end, co.vat_rate,
        v_amt, 0, v_amt - v_vat, v_vat, v_amt, null, coalesce(nullif(r.j->>'due_date', '')::date, v_d + pa.credit_days),
        'เจ้าหนี้ยกมา ' || btrim(r.j->>'ref'), v_eid, p_key || ':ap:' || r.ord, app.current_user_id(), v_id);
  end loop;
  -- สินทรัพย์: ทะเบียนพร้อมเดือน/ค่าเสื่อมสะสมยกมา
  for r in select x.value as j, x.ord from jsonb_array_elements(coalesce(p->'assets', '[]')) with ordinality x(value, ord) loop
    v_d := (r.j->>'acquired_date')::date;
    v_start := date_trunc('month', coalesce(nullif(r.j->>'dep_start', '')::date, v_d))::date;
    v_life := (r.j->>'life_months')::int;
    v_code := upper(btrim(r.j->>'code'));
    if exists (select 1 from acc.fixed_assets where company_id = p_company and code = v_code and voided_at is null) then
      raise exception 'รหัสสินทรัพย์ % มีอยู่แล้ว', v_code using errcode = 'ACC18';
    end if;
    select * into a_asset from acc.chart_of_accounts where company_id = p_company and code = r.j->>'asset_account';
    select * into a_accum from acc.chart_of_accounts where company_id = p_company and code = r.j->>'accum_account';
    select * into a_exp from acc.chart_of_accounts
     where company_id = p_company and code = coalesce(nullif(r.j->>'expense_account', ''), '5250') and active and type = 'expense';
    if not found then raise exception 'สินทรัพย์ %: บัญชีค่าเสื่อมราคาต้องเป็นบัญชีค่าใช้จ่าย', v_code using errcode = 'ACC04'; end if;
    insert into acc.fixed_assets (company_id, code, name, acquired_date, dep_start, cost, salvage, life_months,
        asset_account_id, accum_account_id, expense_account_id, entry_id, description, idem_key, created_by,
        opening_id, opening_months, opening_accumulated)
    values (p_company, v_code, btrim(r.j->>'name'), v_d, v_start, (r.j->>'cost')::numeric, coalesce(nullif(r.j->>'salvage', '')::numeric, 0),
        v_life, a_asset.id, a_accum.id, a_exp.id, v_eid, 'ยกมา', p_key || ':fa:' || r.ord, app.current_user_id(), v_id,
        greatest(0, least(v_life, app.months_between(v_start, date_trunc('month', v_date + 1)::date))),
        coalesce(nullif(r.j->>'accumulated', '')::numeric, 0));
  end loop;
  -- สินค้า: บรรทัดบัตรสต็อก "ยกมา"
  for r in select x.value as j, x.ord from jsonb_array_elements(coalesce(p->'inventory', '[]')) with ordinality x(value, ord) loop
    select * into it from acc.items where company_id = p_company and code = r.j->>'item_code';
    v_qty := (r.j->>'qty')::numeric; v_unit := (r.j->>'unit_cost')::numeric;
    insert into acc.inventory_movements (company_id, item_id, movement_date, kind, quantity, unit_cost, value, entry_id, idem_key, reference, created_by)
    values (p_company, it.id, v_date, 'opening', v_qty, v_unit, round(v_qty * v_unit, 2), v_eid, p_key || ':inv:' || r.ord,
            'ยอดยกมา', app.current_user_id());
  end loop;
  perform set_config('acc.opening', '', true);
  return v_id;
end $$;

-- ---- ยกเลิกยอดยกมาทั้งชุด ----
create function acc.void_opening_balances(p_company uuid, p_reason text, p_key text) returns uuid
language plpgsql security definer set search_path = acc, pg_temp as $$
declare
  ob   acc.opening_balances;
  v_rv uuid;
  v_no text;
  m    record;
begin
  if not app.can_write_company(p_company) then
    raise exception 'ไม่มีสิทธิ์ลงบัญชีในบริษัทนี้' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('opening:' || p_company::text, 0));
  select * into ob from acc.opening_balances where company_id = p_company and voided_at is null for update;
  if not found then
    select * into ob from acc.opening_balances o where o.company_id = p_company and exists (
      select 1 from acc.idempotency_keys k where k.company_id = p_company and k.key = p_key and k.entry_id = o.void_entry_id);
    if found then return ob.void_entry_id; end if; -- กดซ้ำ
    raise exception 'ยังไม่มียอดยกมา' using errcode = 'ACC04';
  end if;
  if length(btrim(coalesce(p_reason, ''))) = 0 then raise exception 'ต้องระบุเหตุผลที่ยกเลิก' using errcode = '22023'; end if;
  select t.doc_no into v_no from acc.documents t
   where t.company_id = p_company and t.opening_id = ob.id and exists (
     select 1 from acc.allocations a join acc.documents s on s.company_id = a.company_id and s.id = a.source_id
      where a.company_id = p_company and a.target_id = t.id and s.voided_at is null) limit 1;
  if v_no is null then
    select t.doc_no into v_no from acc.purchase_documents t
     where t.company_id = p_company and t.opening_id = ob.id and exists (
       select 1 from acc.purchase_allocations a join acc.purchase_documents s on s.company_id = a.company_id and s.id = a.source_id
        where a.company_id = p_company and a.target_id = t.id and s.voided_at is null) limit 1;
  end if;
  if v_no is not null then
    raise exception 'ยอดยกมา % มีรับ/จ่ายชำระหรือลด/เพิ่มหนี้อ้างอยู่ ยกเลิกเอกสารเหล่านั้นก่อน', v_no using errcode = 'ACC16';
  end if;
  select f.code into v_no from acc.fixed_assets f
   where f.company_id = p_company and f.opening_id = ob.id and (
     exists (select 1 from acc.depreciation_lines l join acc.depreciation_runs r on r.company_id = l.company_id and r.id = l.run_id
              where l.company_id = p_company and l.asset_id = f.id and r.voided_at is null)
     or exists (select 1 from acc.asset_disposals d where d.company_id = p_company and d.asset_id = f.id and d.voided_at is null)) limit 1;
  if v_no is not null then
    raise exception 'สินทรัพย์ยกมา % ลงค่าเสื่อมราคาหรือจำหน่ายแล้ว กลับรายการเหล่านั้นก่อน', v_no using errcode = 'ACC16';
  end if;

  perform set_config('acc.opening', 'on', true);
  v_rv := acc.reverse_journal(p_company, ob.entry_id, ob.as_of, p_key, 'ยกเลิกยอดยกมา: ' || btrim(p_reason));
  update acc.documents set voided_at = now(), void_entry_id = v_rv, void_reason = 'ยกเลิกยอดยกมา'
   where company_id = p_company and opening_id = ob.id and voided_at is null;
  update acc.purchase_documents set voided_at = now(), void_entry_id = v_rv, void_reason = 'ยกเลิกยอดยกมา'
   where company_id = p_company and opening_id = ob.id and voided_at is null;
  update acc.fixed_assets set voided_at = now(), void_entry_id = v_rv, void_reason = 'ยกเลิกยอดยกมา'
   where company_id = p_company and opening_id = ob.id and voided_at is null;
  -- บัตรสต็อก: บรรทัดยกเลิกคู่กับบรรทัดยกมา (คำนวณต้นทุนรายการหลังจากนั้นใหม่ สต็อกติดลบ = ยกเลิกไม่ได้)
  for m in select * from acc.inventory_movements
            where company_id = p_company and entry_id = ob.entry_id order by created_at, id loop
    insert into acc.inventory_movements (company_id, item_id, movement_date, kind, quantity, unit_cost, value, entry_id, idem_key, reference, created_by)
    values (p_company, m.item_id, m.movement_date, 'opening', -m.quantity, m.unit_cost, -m.value, v_rv, m.idem_key || ':void',
            'ยกเลิกยอดยกมา', app.current_user_id());
  end loop;
  update acc.opening_balances set voided_at = now(), void_entry_id = v_rv, void_reason = btrim(p_reason)
   where company_id = p_company and id = ob.id;
  perform set_config('acc.opening', '', true);
  return v_rv;
end $$;

revoke all on function acc.post_opening_balances(uuid, jsonb, text), acc.void_opening_balances(uuid, text, text) from public;
grant execute on function acc.post_opening_balances(uuid, jsonb, text), acc.void_opening_balances(uuid, text, text) to app_rw;
grant execute on function acc.asset_posted_months(uuid, uuid), acc.fixed_asset_register(uuid, date) to app_rw, app_ro;

-- migrate:down
drop function acc.void_opening_balances(uuid, text, text), acc.post_opening_balances(uuid, jsonb, text);
drop trigger journal_entries_opening on acc.journal_entries;
drop function acc.guard_opening_entry();
drop trigger documents_opening_void on acc.documents;
drop trigger purchase_documents_opening_void on acc.purchase_documents;
drop trigger fixed_assets_opening_void on acc.fixed_assets;
drop function acc.guard_opening_item_void();
alter table acc.fixed_assets drop constraint fixed_assets_opening_life, drop constraint fixed_assets_opening_check,
  drop constraint fixed_assets_opening_fk, drop column opening_accumulated, drop column opening_months, drop column opening_id;
alter table acc.purchase_documents drop constraint purchase_documents_opening_fk, drop column opening_id;
alter table acc.documents drop constraint documents_opening_fk, drop column opening_id;
drop table acc.opening_balances;
