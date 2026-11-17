-- migrate:up
-- ค่าเสื่อมราคาตามจำนวนวัน (เลือกได้รายสินทรัพย์) + ภาษีขายเมื่อบริษัทจด VAT ขายสินทรัพย์ (docs/phase5-spec.md ข้อ 10, docs/assumptions.md ข้อ 49)
-- รายวัน: ค่าเสื่อมสะสม ณ สิ้นวัน = ปัด((ทุน − ซาก) × วันที่ถือ / วันทั้งอายุ, 2) นับวันที่ได้มาเป็นวันแรก งวดสุดท้ายรับส่วนต่างให้ครบพอดี
--   ลงเป็น AJ สิ้นเดือนเหมือนเดิม · จำหน่ายระหว่างเดือน: รายการ FD รวมค่าเสื่อมตั้งแต่ต้นเดือนถึงวันก่อนวันจำหน่าย
-- ขายสินทรัพย์ (บริษัทจด VAT ราคาขาย > 0): ราคาขายไม่รวม VAT ภาษีขาย 7% ลง 2210 เลขที่ FD เป็นเลขที่ใบกำกับภาษี แสดงในรายงานภาษีขาย

alter table acc.fixed_assets add column dep_method text not null default 'monthly' check (dep_method in ('monthly', 'daily'));
alter table acc.fixed_assets add constraint fixed_assets_daily_start
  check (dep_method = 'monthly' or dep_start = date_trunc('month', acquired_date)::date);
alter table acc.fixed_assets add constraint fixed_assets_daily_opening check (dep_method = 'monthly' or opening_id is null);

alter table acc.asset_disposals
  add column final_depreciation numeric(18,2) not null default 0 check (final_depreciation >= 0),
  add column vat numeric(18,2) not null default 0 check (vat >= 0),
  add column vat_rate numeric(5,2),
  add column buyer_name text check (length(buyer_name) <= 160),
  add column buyer_tax_id text check (buyer_tax_id ~ '^[0-9]{13}$'),
  add column buyer_branch_no text check (buyer_branch_no ~ '^[0-9]{5}$'),
  add column buyer_address text check (length(buyer_address) <= 300),
  add constraint asset_disposals_vat check (vat = 0 or (proceeds > 0 and vat_rate is not null and buyer_name is not null));

-- ค่าเสื่อมสะสมตามจำนวนวัน ณ สิ้นวัน p_through (วันที่ได้มา = วันแรก)
create function app.daily_depreciation_cum(p_cost numeric, p_salvage numeric, p_acquired date, p_life int, p_through date) returns numeric
language sql immutable as $$
  select case when x.days >= x.total then p_cost - p_salvage else round((p_cost - p_salvage) * x.days / x.total, 2) end
    from (select (p_acquired + make_interval(months => p_life))::date - p_acquired as total,
                 greatest(0, p_through - p_acquired + 1) as days) x
$$;
-- จำนวนงวด (เดือน) ที่ลงค่าเสื่อมทั้งอายุ: รายวันเริ่มกลางเดือนจึงมีเดือนสุดท้ายเพิ่ม
create function app.dep_total_months(p_method text, p_acquired date, p_dep_start date, p_life int) returns int
language sql immutable as $$
  select case when p_method = 'daily'
              then app.months_between(p_dep_start, ((p_acquired + make_interval(months => p_life))::date - 1)) + 1
              else p_life end
$$;
-- ค่าเสื่อมสะสมหลังงวดที่ n (ทั้งสองวิธี)
create function app.dep_cum(p_method text, p_cost numeric, p_salvage numeric, p_acquired date, p_dep_start date, p_life int, p_n int)
returns numeric language sql immutable as $$
  select case when p_method <> 'daily' then app.depreciation_cum(p_cost, p_salvage, p_life, p_n)
              when p_n <= 0 then 0::numeric
              else app.daily_depreciation_cum(p_cost, p_salvage, p_acquired, p_life,
                     ((p_dep_start + make_interval(months => p_n))::date - 1)) end
$$;
grant execute on function app.daily_depreciation_cum(numeric, numeric, date, int, date), app.dep_total_months(text, date, date, int),
  app.dep_cum(text, numeric, numeric, date, date, int, int) to app_rw, app_ro;

-- แทนข้อความในนิยามฟังก์ชันปัจจุบัน: ทุกจุดต้องพบครั้งเดียวพอดี (กันแก้ผิดที่ถ้ามีคนแก้ฟังก์ชันไว้ก่อน)
create function pg_temp.patch_function(p_fn regprocedure, p_pairs text[]) returns void language plpgsql as $$
declare v_src text := pg_get_functiondef(p_fn); i int;
begin
  for i in 1 .. array_length(p_pairs, 1) / 2 loop
    if (length(v_src) - length(replace(v_src, p_pairs[2 * i - 1], ''))) / length(p_pairs[2 * i - 1]) <> 1 then
      raise exception 'patch %: ไม่พบข้อความที่ % ครั้งเดียว', p_fn, i;
    end if;
    v_src := replace(v_src, p_pairs[2 * i - 1], p_pairs[2 * i]);
  end loop;
  execute v_src;
end $$;

-- ลงทะเบียน: รับ dep_method (รายวัน = เริ่มคิดเดือนที่ได้มาเสมอ)
select pg_temp.patch_function('acc.register_fixed_asset(uuid, jsonb, text)', array[
  E'  v_eid   uuid;\nbegin',
  E'  v_eid   uuid;\n  v_method text := coalesce(nullif(p->>''dep_method'', ''''), ''monthly'');\nbegin',
  E'  v_start := date_trunc(''month'', v_start)::date;\n',
  E'  v_start := date_trunc(''month'', v_start)::date;\n'
  || E'  if v_method not in (''monthly'', ''daily'') then raise exception ''วิธีคิดค่าเสื่อมต้องเป็นรายเดือนหรือรายวัน'' using errcode = ''22023''; end if;\n'
  || E'  if v_method = ''daily'' then v_start := date_trunc(''month'', v_date)::date; end if;\n',
  'asset_account_id, accum_account_id, expense_account_id, entry_id, description, idem_key, created_by)',
  'asset_account_id, accum_account_id, expense_account_id, entry_id, description, idem_key, created_by, dep_method)',
  E'p_idem, app.current_user_id())\n  returning id into v_id;',
  E'p_idem, app.current_user_id(), v_method)\n  returning id into v_id;']);

-- ลงค่าเสื่อม: จำนวนงวดและยอดสะสมตามวิธีของสินทรัพย์
select pg_temp.patch_function('acc.post_depreciation(uuid, date, text)', array[
  'v_n := least(a.life_months, app.months_between(a.dep_start, v_month) + 1);',
  'v_n := least(app.dep_total_months(a.dep_method, a.acquired_date, a.dep_start, a.life_months), app.months_between(a.dep_start, v_month) + 1);',
  'v_amt := app.depreciation_cum(a.cost, a.salvage, a.life_months, i) - app.depreciation_cum(a.cost, a.salvage, a.life_months, i - 1);',
  'v_amt := app.dep_cum(a.dep_method, a.cost, a.salvage, a.acquired_date, a.dep_start, a.life_months, i) - app.dep_cum(a.dep_method, a.cost, a.salvage, a.acquired_date, a.dep_start, a.life_months, i - 1);']);

-- ---- จำหน่าย / ขายสินทรัพย์ ----
-- p: {date, proceeds? (ไม่รวม VAT), proceeds_account?, party_code? | buyer_name?, buyer_tax_id?, buyer_branch_no?, buyer_address?, description?}
-- เดบิต ค่าเสื่อมสะสม + ค่าเสื่อมถึงวันจำหน่าย (รายวัน) + บัญชีรับเงิน (ราคา + VAT) (+ ขาดทุน 5320)
-- เครดิต ราคาทุน + ภาษีขาย 2210 (บริษัทจด VAT) (+ กำไร 4330)
create or replace function acc.dispose_fixed_asset(p_company uuid, p_asset uuid, p jsonb, p_idem text) returns uuid
language plpgsql security definer set search_path = acc, pg_temp as $$
declare
  a       acc.fixed_assets;
  co      acc.companies;
  pa      acc.parties;
  v_id    uuid;
  v_date  date;
  v_proc  numeric;
  v_pacc  acc.chart_of_accounts;
  v_done  int;
  v_accum numeric;
  v_need  int;
  v_total int;
  v_final numeric := 0;
  v_book  numeric;
  v_gain  numeric;
  v_vat   numeric := 0;
  v_rate  numeric;
  v_asset text; v_acc text; v_exp text;
  v_je    jsonb;
  v_eid   uuid;
  v_label text;
  v_bname text; v_btax text; v_bbranch text; v_baddr text;
begin
  if not app.can_write_company(p_company) then
    raise exception 'ไม่มีสิทธิ์ทำรายการในบริษัทนี้' using errcode = '42501';
  end if;
  if p_idem is null or length(p_idem) < 8 then raise exception 'ต้องมี idempotency key' using errcode = 'ACC03'; end if;
  select id into v_id from acc.asset_disposals where company_id = p_company and idem_key = p_idem;
  if found then return v_id; end if;
  perform acc.ensure_asset_accounts(p_company);
  select * into co from acc.companies where id = p_company;
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
       and id not in (a.asset_account_id, a.accum_account_id) and code <> '2210';
    if not found then raise exception 'ต้องเลือกบัญชีที่รับเงินค่าขาย' using errcode = 'ACC04'; end if;
  end if;

  select months, accumulated into v_done, v_accum from acc.asset_posted_months(p_company, a.id);
  v_total := app.dep_total_months(a.dep_method, a.acquired_date, a.dep_start, a.life_months);
  v_need := greatest(0, least(v_total, app.months_between(a.dep_start, date_trunc('month', v_date)::date)));
  if v_done < v_need then
    raise exception 'ลงค่าเสื่อมราคาของ % ถึงเดือน % ก่อนจำหน่าย', a.code,
      acc.thai_month((a.dep_start + make_interval(months => v_need - 1))::date) using errcode = 'ACC18';
  end if;
  if v_done > v_need then
    raise exception '% ลงค่าเสื่อมเดือน % แล้ว จำหน่ายก่อนเดือนนั้นไม่ได้ (กลับรายการค่าเสื่อมเดือนนั้นก่อน หรือเลือกวันที่หลังจากนั้น)',
      a.code, acc.thai_month((a.dep_start + make_interval(months => v_done - 1))::date) using errcode = 'ACC18';
  end if;
  -- ขายโดยบริษัทจด VAT: ออกใบกำกับภาษี (เลขที่ FD) ต้องมีผู้ซื้อ
  if v_proc > 0 and co.vat_registered then
    if co.tax_id is null then
      raise exception 'กรอกเลขประจำตัวผู้เสียภาษีของบริษัทก่อนออกใบกำกับภาษี (ข้อมูลบริษัทและภาษี)' using errcode = 'ACC14';
    end if;
    if nullif(p->>'party_code', '') is not null then
      select * into pa from acc.parties where company_id = p_company and code = upper(p->>'party_code') and active;
      if not found then raise exception 'ไม่พบผู้ซื้อรหัส %', p->>'party_code' using errcode = 'ACC04'; end if;
      v_bname := pa.name; v_btax := pa.tax_id; v_bbranch := pa.branch_no; v_baddr := nullif(pa.address, '');
    else
      v_bname := nullif(btrim(coalesce(p->>'buyer_name', '')), '');
      v_btax := nullif(btrim(coalesce(p->>'buyer_tax_id', '')), '');
      v_bbranch := coalesce(nullif(btrim(coalesce(p->>'buyer_branch_no', '')), ''), case when v_btax is not null then '00000' end);
      v_baddr := nullif(btrim(coalesce(p->>'buyer_address', '')), '');
    end if;
    if v_bname is null then raise exception 'ขายสินทรัพย์ต้องออกใบกำกับภาษี ระบุผู้ซื้อ' using errcode = '22023'; end if;
    v_rate := co.vat_rate;
    v_vat := round(v_proc * v_rate / 100, 2);
  end if;

  -- รายวัน: ค่าเสื่อมตั้งแต่ต้นเดือนที่จำหน่ายถึงวันก่อนวันจำหน่าย
  if a.dep_method = 'daily' then
    v_final := greatest(0, app.daily_depreciation_cum(a.cost, a.salvage, a.acquired_date, a.life_months, v_date - 1) - v_accum);
  end if;
  v_book := a.cost - v_accum - v_final;
  v_gain := v_proc - v_book;
  select code into v_asset from acc.chart_of_accounts where company_id = p_company and id = a.asset_account_id;
  select code into v_acc from acc.chart_of_accounts where company_id = p_company and id = a.accum_account_id;
  select code into v_exp from acc.chart_of_accounts where company_id = p_company and id = a.expense_account_id;

  v_je := '[]';
  if v_accum > 0 then v_je := v_je || jsonb_build_object('account_code', v_acc, 'debit', v_accum::text, 'memo', v_label); end if;
  if v_final > 0 then
    v_je := v_je || jsonb_build_object('account_code', v_exp, 'debit', v_final::text, 'memo', 'ค่าเสื่อมราคาถึงวันจำหน่าย ' || v_label);
  end if;
  if v_proc > 0 then v_je := v_je || jsonb_build_object('account_code', v_pacc.code, 'debit', (v_proc + v_vat)::text, 'memo', v_label); end if;
  if v_gain < 0 then v_je := v_je || jsonb_build_object('account_code', '5320', 'debit', (-v_gain)::text, 'memo', v_label); end if;
  v_je := v_je || jsonb_build_object('account_code', v_asset, 'credit', a.cost::text, 'memo', v_label);
  if v_vat > 0 then v_je := v_je || jsonb_build_object('account_code', '2210', 'credit', v_vat::text, 'memo', 'ภาษีขาย ' || v_bname); end if;
  if v_gain > 0 then v_je := v_je || jsonb_build_object('account_code', '4330', 'credit', v_gain::text, 'memo', v_label); end if;
  v_eid := acc.post_journal(p_company, v_date,
    coalesce(nullif(btrim(p->>'description'), ''), case when v_proc > 0 then 'ขายสินทรัพย์ ' else 'ตัดจำหน่ายสินทรัพย์ ' end || v_label
      || case when v_bname is not null then ' ให้ ' || v_bname else '' end),
    v_je, p_idem, 'FD', null);
  insert into acc.asset_disposals (company_id, asset_id, disposal_date, proceeds, proceeds_account_id, accumulated, book_value, gain_loss,
      entry_id, description, idem_key, created_by, final_depreciation, vat, vat_rate, buyer_name, buyer_tax_id, buyer_branch_no, buyer_address)
  values (p_company, a.id, v_date, v_proc, v_pacc.id, v_accum + v_final, v_book, v_gain, v_eid, btrim(coalesce(p->>'description', '')), p_idem,
      app.current_user_id(), v_final, v_vat, case when v_vat > 0 then v_rate end, case when v_vat > 0 then v_bname end,
      case when v_vat > 0 then v_btax end, case when v_vat > 0 then v_bbranch end, case when v_vat > 0 then v_baddr end)
  returning id into v_id;
  return v_id;
end $$;

-- ทะเบียนสินทรัพย์: วิธีคิดค่าเสื่อม จำนวนงวดทั้งอายุ ค่าเสื่อมถึงวันจำหน่าย (รายวัน)
drop function acc.fixed_asset_register(uuid, date);
create function acc.fixed_asset_register(p_company uuid, p_month date)
returns table (id uuid, code text, name text, acquired_date date, dep_start date, cost numeric, salvage numeric, life_months int,
               monthly numeric, asset_code text, accum_code text, expense_code text, months_posted int, accumulated numeric,
               dep_this_month numeric, book_value numeric, status text, disposal_id uuid, disposal_date date, proceeds numeric,
               gain_loss numeric, entry_id uuid, disposal_entry_id uuid, next_month date, voided boolean,
               dep_method text, total_months int, disposal_vat numeric)
language sql stable set search_path = acc, pg_temp as $$
  with m as (select date_trunc('month', p_month)::date as s, (date_trunc('month', p_month) + interval '1 month - 1 day')::date as e)
  select f.id, f.code, f.name, f.acquired_date, f.dep_start, f.cost, f.salvage, f.life_months,
         case when f.dep_method = 'monthly' then round((f.cost - f.salvage) / f.life_months, 2) end, aa.code, ac.code, ae.code,
         f.opening_months + coalesce(x.months, 0),
         (f.opening_accumulated + coalesce(x.accumulated, 0) + coalesce(fin.amount, 0))::numeric(18,2),
         (coalesce(x.this_month, 0) + case when d.disposal_date between m.s and m.e then d.final_depreciation else 0 end)::numeric(18,2),
         (case when d.id is not null and d.disposal_date <= m.e then 0 else f.cost - f.opening_accumulated - coalesce(x.accumulated, 0) end)::numeric(18,2),
         case when f.voided_at is not null then 'voided'
              when d.id is not null and d.disposal_date <= m.e then 'disposed'
              when coalesce(t.months, 0) >= tm.n then 'fully_depreciated'
              else 'active' end,
         d.id, d.disposal_date, d.proceeds, d.gain_loss, f.entry_id, d.entry_id,
         case when f.voided_at is null and d.id is null and coalesce(t.months, 0) < tm.n
              then (f.dep_start + make_interval(months => coalesce(t.months, 0)))::date end,
         f.voided_at is not null, f.dep_method, tm.n, d.vat
    from acc.fixed_assets f cross join m
    cross join lateral (select app.dep_total_months(f.dep_method, f.acquired_date, f.dep_start, f.life_months) as n) tm
    join acc.chart_of_accounts aa on aa.company_id = f.company_id and aa.id = f.asset_account_id
    join acc.chart_of_accounts ac on ac.company_id = f.company_id and ac.id = f.accum_account_id
    join acc.chart_of_accounts ae on ae.company_id = f.company_id and ae.id = f.expense_account_id
    left join acc.asset_disposals d on d.company_id = f.company_id and d.asset_id = f.id and d.voided_at is null
    left join lateral (select d.final_depreciation as amount where d.disposal_date <= m.e) fin on true
    left join lateral (
      select count(*)::int months, sum(l.amount) accumulated, sum(l.amount) filter (where l.dep_month = m.s) this_month
        from acc.depreciation_lines l join acc.depreciation_runs r on r.company_id = l.company_id and r.id = l.run_id
       where l.company_id = f.company_id and l.asset_id = f.id and r.voided_at is null and l.dep_month <= m.s) x on true
    left join lateral (select months from acc.asset_posted_months(f.company_id, f.id)) t on true
   where f.company_id = p_company and f.acquired_date <= m.e
   order by f.code, f.created_at
$$;
grant execute on function acc.fixed_asset_register(uuid, date) to app_rw, app_ro;

-- รายงานภาษีขาย: รวมใบกำกับภาษีขายสินทรัพย์ (เลขที่ FD · document_id = รายการ FD)
select pg_temp.patch_function('acc.vat_report(uuid, date, text)', array[
  E'  ), x as (',
  E'    union all\n'
  || E'    select e.id, d.disposal_date, e.doc_no, null, ''asset_sale'', d.buyer_name, d.buyer_tax_id, d.buyer_branch_no, 1, d.proceeds, d.vat,\n'
  || E'           d.void_entry_id\n'
  || E'      from acc.asset_disposals d join acc.journal_entries e on e.company_id = d.company_id and e.id = d.entry_id\n'
  || E'     where p_side = ''sales'' and d.company_id = p_company and d.vat > 0\n'
  || E'  ), x as (']);

-- migrate:down
-- แทนข้อความในนิยามฟังก์ชันปัจจุบัน: ทุกจุดต้องพบครั้งเดียวพอดี (กันแก้ผิดที่ถ้ามีคนแก้ฟังก์ชันไว้ก่อน)
create function pg_temp.patch_function(p_fn regprocedure, p_pairs text[]) returns void language plpgsql as $$
declare v_src text := pg_get_functiondef(p_fn); i int;
begin
  for i in 1 .. array_length(p_pairs, 1) / 2 loop
    if (length(v_src) - length(replace(v_src, p_pairs[2 * i - 1], ''))) / length(p_pairs[2 * i - 1]) <> 1 then
      raise exception 'patch %: ไม่พบข้อความที่ % ครั้งเดียว', p_fn, i;
    end if;
    v_src := replace(v_src, p_pairs[2 * i - 1], p_pairs[2 * i]);
  end loop;
  execute v_src;
end $$;

select pg_temp.patch_function('acc.vat_report(uuid, date, text)', array[
  E'    union all\n'
  || E'    select e.id, d.disposal_date, e.doc_no, null, ''asset_sale'', d.buyer_name, d.buyer_tax_id, d.buyer_branch_no, 1, d.proceeds, d.vat,\n'
  || E'           d.void_entry_id\n'
  || E'      from acc.asset_disposals d join acc.journal_entries e on e.company_id = d.company_id and e.id = d.entry_id\n'
  || E'     where p_side = ''sales'' and d.company_id = p_company and d.vat > 0\n'
  || E'  ), x as (', E'  ), x as (']);
select pg_temp.patch_function('acc.post_depreciation(uuid, date, text)', array[
  'v_n := least(app.dep_total_months(a.dep_method, a.acquired_date, a.dep_start, a.life_months), app.months_between(a.dep_start, v_month) + 1);',
  'v_n := least(a.life_months, app.months_between(a.dep_start, v_month) + 1);',
  'v_amt := app.dep_cum(a.dep_method, a.cost, a.salvage, a.acquired_date, a.dep_start, a.life_months, i) - app.dep_cum(a.dep_method, a.cost, a.salvage, a.acquired_date, a.dep_start, a.life_months, i - 1);',
  'v_amt := app.depreciation_cum(a.cost, a.salvage, a.life_months, i) - app.depreciation_cum(a.cost, a.salvage, a.life_months, i - 1);']);
select pg_temp.patch_function('acc.register_fixed_asset(uuid, jsonb, text)', array[
  E'  v_eid   uuid;\n  v_method text := coalesce(nullif(p->>''dep_method'', ''''), ''monthly'');\nbegin', E'  v_eid   uuid;\nbegin',
  E'  if v_method not in (''monthly'', ''daily'') then raise exception ''วิธีคิดค่าเสื่อมต้องเป็นรายเดือนหรือรายวัน'' using errcode = ''22023''; end if;\n'
  || E'  if v_method = ''daily'' then v_start := date_trunc(''month'', v_date)::date; end if;\n', '',
  'expense_account_id, entry_id, description, idem_key, created_by, dep_method)', 'expense_account_id, entry_id, description, idem_key, created_by)',
  E'p_idem, app.current_user_id(), v_method)\n  returning id into v_id;', E'p_idem, app.current_user_id())\n  returning id into v_id;']);
create or replace function acc.dispose_fixed_asset(p_company uuid, p_asset uuid, p jsonb, p_idem text) returns uuid
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

drop function acc.fixed_asset_register(uuid, date);
create function acc.fixed_asset_register(p_company uuid, p_month date)
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

grant execute on function acc.fixed_asset_register(uuid, date) to app_rw, app_ro;
drop function app.dep_cum(text, numeric, numeric, date, date, int, int), app.dep_total_months(text, date, date, int),
  app.daily_depreciation_cum(numeric, numeric, date, int, date);
alter table acc.asset_disposals drop constraint asset_disposals_vat, drop column buyer_address, drop column buyer_branch_no,
  drop column buyer_tax_id, drop column buyer_name, drop column vat_rate, drop column vat, drop column final_depreciation;
alter table acc.fixed_assets drop constraint fixed_assets_daily_opening, drop constraint fixed_assets_daily_start, drop column dep_method;
