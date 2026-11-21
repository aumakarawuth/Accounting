-- migrate:up
-- รายการปรับปรุง ค้างรับ/ค้างจ่าย/รับล่วงหน้า/จ่ายล่วงหน้า + กลับรายการอัตโนมัติวันแรกของงวดถัดไป
-- (docs/phase6-spec.md ข้อ 5, docs/assumptions.md ข้อ 56) ลงผ่าน acc.post_journal · ยกเลิกด้วยการกลับรายการเท่านั้น
-- รายการปรับปรุง = AJ วันสิ้นเดือน · กลับรายการอัตโนมัติ = JV วันที่ 1 เดือนถัดไป (อยู่ช่องงบทดลองของเดือนถัดไป ไม่ใช่รายการปรับปรุง)

insert into acc.coa_template (code, name, type) values ('1230', 'รายได้ค้างรับ', 'asset') on conflict (code) do nothing;

create table acc.adjustment_entries (
  id                uuid not null default gen_random_uuid(),
  company_id        uuid not null references acc.companies(id),
  month             date not null check (month = date_trunc('month', month)::date),
  kind              text not null check (kind in ('accrued_expense', 'accrued_revenue', 'prepaid_expense', 'unearned_revenue')),
  method            text check (method in ('asset', 'expense', 'liability', 'revenue')),
  pl_account_id     uuid not null,
  bs_account_id     uuid not null,
  amount            numeric(18,2) not null check (amount > 0),
  description       text not null check (length(description) <= 300),
  auto_reverse      boolean not null,
  entry_id          uuid not null,
  reversal_entry_id uuid,
  idem_key          text not null,
  voided_at         timestamptz,
  void_entry_id     uuid,
  void_reason       text check (length(void_reason) <= 300),
  created_by        uuid not null references acc.users(id),
  created_at        timestamptz not null default now(),
  primary key (company_id, id),
  unique (company_id, idem_key),
  foreign key (company_id, pl_account_id) references acc.chart_of_accounts (company_id, id),
  foreign key (company_id, bs_account_id) references acc.chart_of_accounts (company_id, id),
  foreign key (company_id, entry_id) references acc.journal_entries (company_id, id),
  foreign key (company_id, reversal_entry_id) references acc.journal_entries (company_id, id),
  foreign key (company_id, void_entry_id) references acc.journal_entries (company_id, id),
  check ((kind in ('accrued_expense', 'accrued_revenue')) = (method is null)),
  check (kind <> 'prepaid_expense' or method in ('asset', 'expense')),
  check (kind <> 'unearned_revenue' or method in ('liability', 'revenue')),
  check (auto_reverse = (reversal_entry_id is not null)),
  check ((voided_at is null) = (void_entry_id is null))
);
create trigger adjustment_entries_guard before update on acc.adjustment_entries for each row execute function acc.guard_void_only();
create trigger adjustment_entries_no_delete before delete on acc.adjustment_entries for each row execute function acc.forbid_mutation();
create trigger adjustment_entries_locked before insert or update on acc.adjustment_entries for each row execute function acc.guard_locked_company();
create trigger audit_adjustment_entries after insert or update on acc.adjustment_entries for each row execute function acc.audit_row();
alter table acc.adjustment_entries enable row level security;
grant select on acc.adjustment_entries to app_rw, app_ro;
create policy adjustment_entries_read on acc.adjustment_entries for select to app_rw, app_ro using (company_id in (select app.readable_company_ids()));

-- รายการที่ลงจากหน้าจอเฉพาะ (ค่าเสื่อม ค่าเผื่อหนี้สงสัยจะสูญ หนี้สูญ รายการปรับปรุง) แก้/กลับรายการจากสมุดรายวันไม่ได้ ต้องยกเลิกที่หน้านั้น
create function acc.entry_has_source(p_company uuid, p_entry uuid) returns boolean
language sql stable security definer set search_path = acc, pg_temp as $$
  select app.can_read_company(p_company) and (
       exists (select 1 from acc.depreciation_runs r where r.company_id = p_company and r.entry_id = p_entry)
    or exists (select 1 from acc.allowance_entries x where x.company_id = p_company and x.entry_id = p_entry)
    or exists (select 1 from acc.bad_debt_writeoffs x where x.company_id = p_company and x.entry_id = p_entry)
    or exists (select 1 from acc.bad_debt_recoveries x where x.company_id = p_company and x.entry_id = p_entry)
    or exists (select 1 from acc.adjustment_entries x where x.company_id = p_company and (x.entry_id = p_entry or x.reversal_entry_id = p_entry)))
$$;

-- ชนิด → ด้านของบัญชี: dr_pl = เดบิตบัญชีกำไรขาดทุน / เครดิตบัญชีงบดุล
--   ค้างจ่าย: Dr ค่าใช้จ่าย / Cr 2310 · ค้างรับ: Dr 1230 / Cr รายได้
--   จ่ายล่วงหน้า บันทึกเป็นสินทรัพย์: Dr ค่าใช้จ่าย (ส่วนที่ใช้ไป) / Cr 1510 · บันทึกเป็นค่าใช้จ่าย: Dr 1510 (ส่วนที่ยังไม่ใช้) / Cr ค่าใช้จ่าย
--   รับล่วงหน้า บันทึกเป็นหนี้สิน: Dr 2410 / Cr รายได้ (ส่วนที่ได้รับแล้ว) · บันทึกเป็นรายได้: Dr รายได้ / Cr 2410 (ส่วนที่ยังไม่ได้รับ)
-- p: {month: 'YYYY-MM-01', kind, method?, pl_account, bs_account?, amount, description?, auto_reverse}
create function acc.post_adjustment(p_company uuid, p jsonb, p_idem text) returns uuid
language plpgsql security definer set search_path = acc, pg_temp as $$
declare
  v_id uuid; v_month date; v_end date; v_kind text := p->>'kind'; v_method text := nullif(p->>'method', ''); v_amt numeric;
  v_auto boolean := coalesce((p->>'auto_reverse')::boolean, false);
  pl acc.chart_of_accounts; bs acc.chart_of_accounts; v_pl_type text; v_bs_type text; v_bs_default text; v_dr_pl boolean; v_reversible boolean;
  v_desc text; v_je jsonb; v_eid uuid; v_rv uuid; v_no text;
begin
  if not app.can_write_company(p_company) then raise exception 'ไม่มีสิทธิ์บันทึกรายการในบริษัทนี้' using errcode = '42501'; end if;
  select id into v_id from acc.adjustment_entries where company_id = p_company and idem_key = p_idem;
  if found then return v_id; end if;
  begin v_month := date_trunc('month', (p->>'month')::date)::date; v_amt := (p->>'amount')::numeric;
  exception when others then raise exception 'เดือนหรือจำนวนเงินไม่ถูกต้อง' using errcode = '22023'; end;
  if v_month is null then raise exception 'ต้องระบุเดือน' using errcode = '22023'; end if;
  if v_amt is null or v_amt <= 0 or v_amt <> round(v_amt, 2) then raise exception 'จำนวนเงินต้องมากกว่า 0 ทศนิยมไม่เกิน 2 ตำแหน่ง' using errcode = 'ACC05'; end if;
  v_end := (v_month + interval '1 month - 1 day')::date;
  case v_kind
    when 'accrued_expense' then v_pl_type := 'expense'; v_bs_type := 'liability'; v_bs_default := '2310'; v_dr_pl := true; v_reversible := true;
    when 'accrued_revenue' then v_pl_type := 'revenue'; v_bs_type := 'asset'; v_bs_default := '1230'; v_dr_pl := false; v_reversible := true;
    when 'prepaid_expense' then v_pl_type := 'expense'; v_bs_type := 'asset'; v_bs_default := '1510';
      v_dr_pl := v_method = 'asset'; v_reversible := v_method = 'expense';
    when 'unearned_revenue' then v_pl_type := 'revenue'; v_bs_type := 'liability'; v_bs_default := '2410';
      v_dr_pl := v_method = 'revenue'; v_reversible := v_method = 'revenue';
    else raise exception 'ชนิดรายการปรับปรุงไม่ถูกต้อง' using errcode = '22023';
  end case;
  if v_kind in ('accrued_expense', 'accrued_revenue') then v_method := null;
  elsif (v_kind = 'prepaid_expense' and v_method not in ('asset', 'expense')) or (v_kind = 'unearned_revenue' and v_method not in ('liability', 'revenue'))
     or v_method is null then
    raise exception 'ต้องเลือกวิธีที่บันทึกไว้เมื่อรับ/จ่ายเงิน' using errcode = '22023';
  end if;
  if v_auto and not v_reversible then
    raise exception 'ชนิดนี้ไม่กลับรายการ: บันทึกเป็นสินทรัพย์/หนี้สินไว้แล้ว รายการปรับปรุงโอนส่วนที่เกิดขึ้นจริง ถ้ากลับรายการยอดจะผิด' using errcode = '22023';
  end if;
  select * into pl from acc.chart_of_accounts where company_id = p_company and code = p->>'pl_account' and active and type = v_pl_type;
  if not found then
    raise exception 'บัญชี % ต้องเป็นบัญชี%ที่เปิดใช้', coalesce(p->>'pl_account', '(ว่าง)'), case v_pl_type when 'expense' then 'ค่าใช้จ่าย' else 'รายได้' end
      using errcode = 'ACC04';
  end if;
  if v_bs_default = '1230' and nullif(p->>'bs_account', '') is null then
    insert into acc.chart_of_accounts (company_id, code, name, type) values (p_company, '1230', 'รายได้ค้างรับ', 'asset')
    on conflict (company_id, code) do update set active = true where not acc.chart_of_accounts.active;
  end if;
  select * into bs from acc.chart_of_accounts where company_id = p_company and code = coalesce(nullif(p->>'bs_account', ''), v_bs_default) and active and type = v_bs_type;
  if not found then
    raise exception 'บัญชี % ต้องเป็นบัญชี%ที่เปิดใช้', coalesce(nullif(p->>'bs_account', ''), v_bs_default), case v_bs_type when 'asset' then 'สินทรัพย์' else 'หนี้สิน' end
      using errcode = 'ACC04';
  end if;
  v_desc := coalesce(nullif(btrim(p->>'description'), ''), case v_kind
    when 'accrued_expense' then pl.name || 'ค้างจ่าย'
    when 'accrued_revenue' then pl.name || 'ค้างรับ'
    when 'prepaid_expense' then case v_method when 'asset' then pl.name || 'ส่วนที่ใช้ไป' else pl.name || 'จ่ายล่วงหน้า' end
    else case v_method when 'liability' then pl.name || 'ส่วนที่ได้รับแล้ว' else pl.name || 'รับล่วงหน้า' end end);
  v_je := case when v_dr_pl
    then jsonb_build_array(jsonb_build_object('account_code', pl.code, 'debit', v_amt::text), jsonb_build_object('account_code', bs.code, 'credit', v_amt::text))
    else jsonb_build_array(jsonb_build_object('account_code', bs.code, 'debit', v_amt::text), jsonb_build_object('account_code', pl.code, 'credit', v_amt::text)) end;
  v_eid := acc.post_journal(p_company, v_end, left(v_desc, 300), v_je, p_idem, 'AJ', null);
  if v_auto then
    -- กลับรายการวันแรกของงวดถัดไป: บรรทัดเดิมสลับด้าน (งวด/ปีถัดไปปิดแล้ว = post_journal ปฏิเสธทั้งชุด)
    select doc_no into v_no from acc.journal_entries where company_id = p_company and id = v_eid;
    select jsonb_agg(jsonb_build_object('account_code', x->>'account_code', 'debit', x->>'credit', 'credit', x->>'debit')) into v_je
      from jsonb_array_elements(v_je) x;
    v_rv := acc.post_journal(p_company, v_end + 1, left('กลับรายการปรับปรุง ' || v_no || ' ' || v_desc, 300), v_je, p_idem || ':reverse', 'JV', null);
  end if;
  insert into acc.adjustment_entries (company_id, month, kind, method, pl_account_id, bs_account_id, amount, description, auto_reverse,
      entry_id, reversal_entry_id, idem_key, created_by)
  values (p_company, v_month, v_kind, v_method, pl.id, bs.id, v_amt, left(v_desc, 300), v_auto, v_eid, v_rv, p_idem, app.current_user_id())
  returning id into v_id;
  return v_id;
end $$;

-- ยกเลิก: กลับรายการ AJ ตามวันที่ที่ระบุ และกลับรายการของการกลับรายการอัตโนมัติ (ไม่ก่อนวันที่ 1 เดือนถัดไป) ในทรานแซกชันเดียว
create function acc.void_adjustment(p_company uuid, p_id uuid, p_date date, p_reason text, p_idem text) returns uuid
language plpgsql security definer set search_path = acc, pg_temp as $$
declare x acc.adjustment_entries; v_rv uuid; v_no text; v_rd date;
begin
  if not app.can_write_company(p_company) then raise exception 'ไม่มีสิทธิ์' using errcode = '42501'; end if;
  select * into x from acc.adjustment_entries where company_id = p_company and id = p_id for update;
  if not found then raise exception 'ไม่พบรายการ' using errcode = 'ACC04'; end if;
  select doc_no into v_no from acc.journal_entries where company_id = p_company and id = x.entry_id;
  if x.voided_at is not null then
    if exists (select 1 from acc.idempotency_keys where company_id = p_company and key = p_idem and entry_id = x.void_entry_id) then return x.void_entry_id; end if;
    raise exception '% ยกเลิกไปแล้ว', v_no using errcode = 'ACC16';
  end if;
  if length(btrim(coalesce(p_reason, ''))) = 0 then raise exception 'ต้องระบุเหตุผลที่ยกเลิก' using errcode = '22023'; end if;
  if p_date < (x.month + interval '1 month - 1 day')::date then raise exception 'วันที่ยกเลิกต้องไม่ก่อนวันที่ของ %', v_no using errcode = '22023'; end if;
  v_rv := acc.reverse_journal(p_company, x.entry_id, p_date, p_idem, 'ยกเลิก ' || v_no || ': ' || btrim(p_reason));
  if x.reversal_entry_id is not null then
    select entry_date into v_rd from acc.journal_entries where company_id = p_company and id = x.reversal_entry_id;
    perform acc.reverse_journal(p_company, x.reversal_entry_id, greatest(p_date, v_rd), p_idem || ':reverse',
      'ยกเลิกการกลับรายการอัตโนมัติของ ' || v_no || ': ' || btrim(p_reason));
  end if;
  update acc.adjustment_entries set voided_at = now(), void_entry_id = v_rv, void_reason = btrim(p_reason) where company_id = p_company and id = x.id;
  return v_rv;
end $$;

revoke all on function acc.post_adjustment(uuid, jsonb, text), acc.void_adjustment(uuid, uuid, date, text, text), acc.entry_has_source(uuid, uuid) from public;
grant execute on function acc.post_adjustment(uuid, jsonb, text), acc.void_adjustment(uuid, uuid, date, text, text) to app_rw;
grant execute on function acc.entry_has_source(uuid, uuid) to app_rw, app_ro;

-- migrate:down
drop function acc.void_adjustment(uuid, uuid, date, text, text), acc.post_adjustment(uuid, jsonb, text), acc.entry_has_source(uuid, uuid);
drop table acc.adjustment_entries;
