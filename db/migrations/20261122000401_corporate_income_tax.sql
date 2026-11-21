-- migrate:up
-- ภาษีเงินได้นิติบุคคล ภ.ง.ด.51 (ครึ่งปี) และ ภ.ง.ด.50 (สิ้นปี) ของบริษัทจำกัด (docs/phase7-spec.md ข้อ 2, docs/assumptions.md ข้อ 59)
-- กำไรทางภาษี = กำไรทางบัญชีก่อนภาษีเงินได้ (ไม่ปรับปรุงรายการทางภาษี) · ลงผ่าน acc.post_journal · ยกเลิกด้วยกลับรายการ

create table acc.income_tax_filings (
  id              uuid not null default gen_random_uuid(),
  company_id      uuid not null references acc.companies(id),
  form            text not null check (form in ('51', '50')),
  year_start      date not null,
  year_end        date not null,
  period_end      date not null,               -- 51 = สิ้นเดือนที่ 6 · 50 = สิ้นปี
  filed_on        date not null,               -- วันที่ของรายการ (51 = วันชำระ · 50 = วันสิ้นปี)
  actual_profit   numeric(18,2) not null,      -- กำไรก่อนภาษีของงวด (51 = 6 เดือน)
  actual_revenue  numeric(18,2) not null,
  profit          numeric(18,2) not null,      -- 51 = ประมาณการทั้งปี · 50 = กำไรจริงทั้งปี
  revenue         numeric(18,2) not null,
  paid_up         numeric(18,2) not null,
  sme             boolean not null,
  tax_full        numeric(18,2) not null check (tax_full >= 0),
  tax             numeric(18,2) not null check (tax >= 0),
  credit_prepaid  numeric(18,2) not null default 0 check (credit_prepaid >= 0),
  credit_wht      numeric(18,2) not null default 0 check (credit_wht >= 0),
  payable         numeric(18,2) not null check (payable >= 0),
  cash_account_id uuid,
  entry_id        uuid,
  idem_key        text not null,
  paid_on         date,
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
  check (tax = credit_prepaid + credit_wht + payable),
  check ((paid_on is null) = (pay_entry_id is null)),
  check (voided_at is null or paid_on is null)
);
create unique index income_tax_filings_active on acc.income_tax_filings (company_id, form, year_start) where voided_at is null;
create trigger income_tax_filings_no_delete before delete on acc.income_tax_filings for each row execute function acc.forbid_mutation();
create trigger income_tax_filings_locked before insert or update on acc.income_tax_filings for each row execute function acc.guard_locked_company();
create trigger audit_income_tax_filings after insert or update on acc.income_tax_filings for each row execute function acc.audit_row();
alter table acc.income_tax_filings enable row level security;
grant select on acc.income_tax_filings to app_rw, app_ro;
create policy income_tax_filings_read on acc.income_tax_filings for select to app_rw, app_ro using (company_id in (select app.readable_company_ids()));

-- ภาษีทั้งปีจากกำไรสุทธิ: SME ยกเว้น 300,000 แรก · 300,001–3,000,000 ร้อยละ 15 · ส่วนเกิน ร้อยละ 20 · ทั่วไป ร้อยละ 20 · ขาดทุน = 0
create function acc.cit_tax(p_profit numeric, p_sme boolean) returns numeric
language sql immutable set search_path = acc, pg_temp as $$
  select case
    when p_profit <= 0 then 0::numeric(18,2)
    when p_sme then round(least(greatest(p_profit - 300000, 0), 2700000) * 0.15 + greatest(p_profit - 3000000, 0) * 0.20, 2)
    else round(p_profit * 0.20, 2) end
$$;

-- ยอดของงวด [p_from, p_to] ไม่รวม CL: กำไรก่อนภาษีเงินได้ (ไม่นับบัญชี 54–59) และรายได้ขาย/บริการ (41–42)
create function acc.cit_period(p_company uuid, p_from date, p_to date, out profit numeric, out revenue numeric)
language sql stable security definer set search_path = acc, pg_temp as $$
  select coalesce(sum(l.credit - l.debit) filter (where a.type in ('revenue', 'expense') and a.code !~ '^5[4-9]'), 0)::numeric(18,2),
         coalesce(sum(l.credit - l.debit) filter (where a.type = 'revenue' and a.code ~ '^4[12]'), 0)::numeric(18,2)
    from acc.journal_lines l
    join acc.journal_entries e on e.company_id = l.company_id and e.id = l.entry_id
    join acc.chart_of_accounts a on a.company_id = l.company_id and a.id = l.account_id
   where l.company_id = p_company and app.can_read_company(p_company) and e.entry_date between p_from and p_to and e.doc_prefix <> 'CL'
$$;

-- คำนวณก่อนยืนยัน · p: {estimated_profit?, estimated_revenue?, use_wht?, date?}
create function acc.cit_preview(p_company uuid, p_form text, p_year_end date, p jsonb) returns jsonb
language plpgsql stable security definer set search_path = acc, pg_temp as $$
declare v_ys date; v_ye date; v_pe date; a record; v_profit numeric; v_rev numeric; v_paid numeric; v_sme boolean; v_full numeric; v_tax numeric;
  v_pre numeric := 0; v_wht numeric := 0; v_whtbal numeric; v_date date; v_type text;
begin
  if not app.can_read_company(p_company) then raise exception 'ไม่มีสิทธิ์' using errcode = '42501'; end if;
  select entity_type into v_type from acc.companies where id = p_company;
  if v_type <> 'company' then raise exception 'ภาษีเงินได้นิติบุคคลใช้กับบริษัทจำกัดเท่านั้น' using errcode = '22023'; end if;
  if p_form not in ('51', '50') then raise exception 'แบบภาษีไม่ถูกต้อง' using errcode = '22023'; end if;
  v_ys := acc.fiscal_year_start(p_company, p_year_end);
  v_ye := (v_ys + interval '1 year - 1 day')::date;
  if p_year_end is distinct from v_ye then raise exception 'วันที่ % ไม่ใช่วันสิ้นปีบัญชี', acc.thai_date(p_year_end) using errcode = '22023'; end if;
  v_pe := case p_form when '51' then (v_ys + interval '6 months - 1 day')::date else v_ye end;
  select * into a from acc.cit_period(p_company, v_ys, v_pe);
  begin
    v_profit := coalesce(nullif(p->>'estimated_profit', '')::numeric, case p_form when '51' then a.profit * 2 else a.profit end);
    v_rev := coalesce(nullif(p->>'estimated_revenue', '')::numeric, case p_form when '51' then a.revenue * 2 else a.revenue end);
    v_date := coalesce(nullif(p->>'date', '')::date, case p_form when '51' then v_pe + 1 else v_ye end);
  exception when others then raise exception 'ประมาณการหรือวันที่ไม่ถูกต้อง' using errcode = '22023'; end;
  if p_form = '50' then v_profit := a.profit; v_rev := a.revenue; v_date := v_ye; end if;
  if v_profit <> round(v_profit, 2) or v_rev <> round(v_rev, 2) or v_rev < 0 then raise exception 'ประมาณการต้องเป็นจำนวนเงินทศนิยมไม่เกิน 2 ตำแหน่ง' using errcode = 'ACC05'; end if;
  -- ทุนชำระแล้ว = ทุนเรือนหุ้น (31xx ไม่รวมส่วนเกินมูลค่าหุ้น 3120) ณ วันสิ้นรอบ
  select coalesce(sum(l.credit - l.debit), 0) into v_paid
    from acc.journal_lines l
    join acc.journal_entries e on e.company_id = l.company_id and e.id = l.entry_id
    join acc.chart_of_accounts c on c.company_id = l.company_id and c.id = l.account_id
   where l.company_id = p_company and c.code like '31%' and c.code <> '3120' and e.entry_date <= v_pe;
  v_sme := v_paid <= 5000000 and v_rev <= 30000000;
  v_full := acc.cit_tax(v_profit, v_sme);
  v_tax := case p_form when '51' then round(v_full / 2, 2) else v_full end;
  if p_form = '50' then
    select coalesce(sum(f.tax), 0) into v_pre from acc.income_tax_filings f
     where f.company_id = p_company and f.form = '51' and f.year_start = v_ys and f.voided_at is null;
    v_pre := least(v_pre, v_tax);
  end if;
  v_whtbal := greatest(acc.account_net_as_of(p_company, '1420', v_date), 0);
  if coalesce((p->>'use_wht')::boolean, false) then v_wht := least(v_whtbal, v_tax - v_pre); end if;
  return jsonb_build_object('form', p_form, 'yearStart', v_ys, 'yearEnd', v_ye, 'periodEnd', v_pe, 'date', v_date,
    'actualProfit', a.profit::text, 'actualRevenue', a.revenue::text, 'profit', v_profit::numeric(18,2)::text, 'revenue', v_rev::numeric(18,2)::text,
    'paidUp', v_paid::numeric(18,2)::text, 'sme', v_sme, 'taxFull', v_full::numeric(18,2)::text, 'tax', v_tax::numeric(18,2)::text,
    'creditPrepaid', v_pre::numeric(18,2)::text, 'whtBalance', v_whtbal::numeric(18,2)::text, 'creditWht', v_wht::numeric(18,2)::text,
    'payable', (v_tax - v_pre - v_wht)::numeric(18,2)::text);
end $$;

create function acc.ensure_cit_accounts(p_company uuid) returns void
language sql security definer set search_path = acc, pg_temp as $$
  insert into acc.chart_of_accounts (company_id, code, name, type) values
    (p_company, '1440', 'ภาษีเงินได้นิติบุคคลจ่ายล่วงหน้า', 'asset'),
    (p_company, '2250', 'ภาษีเงินได้นิติบุคคลค้างจ่าย', 'liability'),
    (p_company, '5910', 'ภาษีเงินได้นิติบุคคล', 'expense')
  on conflict (company_id, code) do update set active = true, version = acc.chart_of_accounts.version + 1 where not acc.chart_of_accounts.active
$$;

-- ยื่นแบบ · p: {form, year_end, date?, estimated_profit?, estimated_revenue?, use_wht?, cash_account?}
--   51: JV วันชำระ Dr 1440 ภาษี / Cr 1420 เครดิตภาษีถูกหัก / Cr เงิน
--   50: AJ วันสิ้นปี Dr 5910 ภาษี / Cr 1440 ภาษีจ่ายล่วงหน้า / Cr 1420 / Cr 2250 ส่วนที่ต้องชำระ
create function acc.file_income_tax(p_company uuid, p jsonb, p_idem text) returns uuid
language plpgsql security definer set search_path = acc, pg_temp as $$
declare v_id uuid; v_form text := p->>'form'; v_ye date; x jsonb; ca acc.chart_of_accounts; v_lines jsonb; v_eid uuid; v_desc text; v_tax numeric; v_pay numeric;
begin
  if not app.can_write_company(p_company) then raise exception 'ไม่มีสิทธิ์บันทึกรายการในบริษัทนี้' using errcode = '42501'; end if;
  select id into v_id from acc.income_tax_filings where company_id = p_company and idem_key = p_idem;
  if found then return v_id; end if;
  begin v_ye := (p->>'year_end')::date; exception when others then raise exception 'วันสิ้นปีบัญชีไม่ถูกต้อง' using errcode = '22023'; end;
  x := acc.cit_preview(p_company, v_form, v_ye, p);
  if exists (select 1 from acc.income_tax_filings where company_id = p_company and form = v_form and year_start = (x->>'yearStart')::date and voided_at is null) then
    raise exception 'ยื่น ภ.ง.ด.% ของปีบัญชีนี้แล้ว ยกเลิกแบบเดิมก่อนถ้าจะยื่นใหม่', v_form using errcode = 'ACC16';
  end if;
  if v_form = '51' then
    if exists (select 1 from acc.income_tax_filings where company_id = p_company and form = '50' and year_start = (x->>'yearStart')::date and voided_at is null) then
      raise exception 'ยื่น ภ.ง.ด.50 ของปีนี้แล้ว ยื่น ภ.ง.ด.51 ไม่ได้' using errcode = 'ACC16';
    end if;
    if (x->>'date')::date <= (x->>'periodEnd')::date then
      raise exception 'ภ.ง.ด.51 ชำระได้หลังสิ้นเดือนที่ 6 ของปีบัญชี (หลัง %)', acc.thai_date((x->>'periodEnd')::date) using errcode = '22023';
    end if;
  end if;
  v_tax := (x->>'tax')::numeric; v_pay := (x->>'payable')::numeric;
  if v_form = '51' and v_pay > 0 then
    select * into ca from acc.chart_of_accounts where company_id = p_company and code = p->>'cash_account' and active and type = 'asset' and code like '11%';
    if not found then raise exception 'ต้องเลือกบัญชีเงินสด/เงินฝาก (11xx) ที่จ่ายภาษี' using errcode = 'ACC04'; end if;
  end if;
  if v_tax > 0 then
    perform acc.ensure_cit_accounts(p_company);
    if v_form = '51' then
      v_desc := 'ภ.ง.ด.51 ภาษีเงินได้นิติบุคคลครึ่งปี ปีบัญชี ' || acc.thai_date((x->>'yearStart')::date) || ' – ' || acc.thai_date(v_ye);
      v_lines := jsonb_build_array(jsonb_build_object('account_code', '1440', 'debit', v_tax::text));
      if (x->>'creditWht')::numeric > 0 then v_lines := v_lines || jsonb_build_object('account_code', '1420', 'credit', x->>'creditWht'); end if;
      if v_pay > 0 then v_lines := v_lines || jsonb_build_object('account_code', ca.code, 'credit', v_pay::text); end if;
      v_eid := acc.post_journal(p_company, (x->>'date')::date, v_desc, v_lines, p_idem, 'JV', null);
    else
      v_desc := 'ภ.ง.ด.50 ภาษีเงินได้นิติบุคคล ปีบัญชี ' || acc.thai_date((x->>'yearStart')::date) || ' – ' || acc.thai_date(v_ye);
      v_lines := jsonb_build_array(jsonb_build_object('account_code', '5910', 'debit', v_tax::text));
      if (x->>'creditPrepaid')::numeric > 0 then v_lines := v_lines || jsonb_build_object('account_code', '1440', 'credit', x->>'creditPrepaid'); end if;
      if (x->>'creditWht')::numeric > 0 then v_lines := v_lines || jsonb_build_object('account_code', '1420', 'credit', x->>'creditWht'); end if;
      if v_pay > 0 then v_lines := v_lines || jsonb_build_object('account_code', '2250', 'credit', v_pay::text); end if;
      v_eid := acc.post_journal(p_company, v_ye, v_desc, v_lines, p_idem, 'AJ', null);
    end if;
  end if;
  insert into acc.income_tax_filings (company_id, form, year_start, year_end, period_end, filed_on, actual_profit, actual_revenue, profit, revenue,
      paid_up, sme, tax_full, tax, credit_prepaid, credit_wht, payable, cash_account_id, entry_id, idem_key, created_by)
  values (p_company, v_form, (x->>'yearStart')::date, v_ye, (x->>'periodEnd')::date, (x->>'date')::date, (x->>'actualProfit')::numeric,
      (x->>'actualRevenue')::numeric, (x->>'profit')::numeric, (x->>'revenue')::numeric, (x->>'paidUp')::numeric, (x->>'sme')::boolean,
      (x->>'taxFull')::numeric, v_tax, (x->>'creditPrepaid')::numeric, (x->>'creditWht')::numeric, v_pay,
      case when v_form = '51' and v_pay > 0 then ca.id end, v_eid, p_idem, app.current_user_id())
  returning id into v_id;
  return v_id;
end $$;

-- ชำระ ภ.ง.ด.50: Dr 2250 / Cr เงิน · p: {date, cash_account}
create function acc.pay_income_tax(p_company uuid, p_id uuid, p jsonb, p_idem text) returns uuid
language plpgsql security definer set search_path = acc, pg_temp as $$
declare f acc.income_tax_filings; v_date date; ca acc.chart_of_accounts; v_eid uuid;
begin
  if not app.can_write_company(p_company) then raise exception 'ไม่มีสิทธิ์' using errcode = '42501'; end if;
  select * into f from acc.income_tax_filings where company_id = p_company and id = p_id for update;
  if not found then raise exception 'ไม่พบแบบภาษี' using errcode = 'ACC04'; end if;
  if f.pay_idem = p_idem then return f.pay_entry_id; end if;
  if f.form <> '50' or f.payable <= 0 then raise exception 'แบบนี้ไม่มียอดภาษีค้างจ่ายให้ชำระ' using errcode = '22023'; end if;
  if f.voided_at is not null then raise exception 'แบบนี้ยกเลิกแล้ว' using errcode = 'ACC16'; end if;
  if f.paid_on is not null then raise exception 'ชำระภาษีของแบบนี้แล้ว' using errcode = 'ACC16'; end if;
  begin v_date := (p->>'date')::date; exception when others then raise exception 'วันที่ไม่ถูกต้อง' using errcode = '22023'; end;
  if v_date is null or v_date <= f.year_end then raise exception 'วันที่ชำระต้องหลังวันสิ้นปีบัญชี' using errcode = '22023'; end if;
  select * into ca from acc.chart_of_accounts where company_id = p_company and code = p->>'cash_account' and active and type = 'asset' and code like '11%';
  if not found then raise exception 'ต้องเลือกบัญชีเงินสด/เงินฝาก (11xx)' using errcode = 'ACC04'; end if;
  v_eid := acc.post_journal(p_company, v_date, 'ชำระภาษีเงินได้นิติบุคคล ภ.ง.ด.50 ปีบัญชี ' || acc.thai_date(f.year_start) || ' – ' || acc.thai_date(f.year_end),
    jsonb_build_array(jsonb_build_object('account_code', '2250', 'debit', f.payable::text), jsonb_build_object('account_code', ca.code, 'credit', f.payable::text)),
    p_idem, 'JV', null);
  update acc.income_tax_filings set paid_on = v_date, cash_account_id = ca.id, pay_entry_id = v_eid, pay_idem = p_idem where company_id = p_company and id = p_id;
  return v_eid;
end $$;

-- ยกเลิก: p_what = 'payment' (ชำระ ภ.ง.ด.50) | 'filing' (ต้องยกเลิกการชำระก่อน · ภ.ง.ด.51 ยกเลิกไม่ได้เมื่อ ภ.ง.ด.50 ปีเดียวกันยังอยู่)
create function acc.void_income_tax(p_company uuid, p_id uuid, p_what text, p_date date, p_reason text, p_idem text) returns uuid
language plpgsql security definer set search_path = acc, pg_temp as $$
declare f acc.income_tax_filings; v_rv uuid; v_src uuid; v_no text;
begin
  if not app.can_write_company(p_company) then raise exception 'ไม่มีสิทธิ์' using errcode = '42501'; end if;
  select entry_id into v_rv from acc.idempotency_keys where company_id = p_company and key = p_idem;
  if found then return v_rv; end if;
  select * into f from acc.income_tax_filings where company_id = p_company and id = p_id for update;
  if not found then raise exception 'ไม่พบแบบภาษี' using errcode = 'ACC04'; end if;
  if length(btrim(coalesce(p_reason, ''))) = 0 then raise exception 'ต้องระบุเหตุผลที่ยกเลิก' using errcode = '22023'; end if;
  if p_what = 'payment' then
    if f.paid_on is null then raise exception 'ยังไม่ได้ชำระภาษีของแบบนี้' using errcode = 'ACC16'; end if;
    if p_date < f.paid_on then raise exception 'วันที่ยกเลิกต้องไม่ก่อนวันชำระ' using errcode = '22023'; end if;
    v_src := f.pay_entry_id;
  elsif p_what = 'filing' then
    if f.voided_at is not null then raise exception 'ยกเลิกไปแล้ว' using errcode = 'ACC16'; end if;
    if f.paid_on is not null then raise exception 'ชำระภาษีแล้ว ต้องยกเลิกการชำระก่อน' using errcode = 'ACC16'; end if;
    if f.form = '51' and exists (select 1 from acc.income_tax_filings x where x.company_id = p_company and x.form = '50'
                                   and x.year_start = f.year_start and x.voided_at is null) then
      raise exception 'ภ.ง.ด.50 ของปีนี้ใช้ภาษีที่จ่ายตาม ภ.ง.ด.51 แล้ว ยกเลิก ภ.ง.ด.50 ก่อน' using errcode = 'ACC16';
    end if;
    if p_date < f.filed_on then raise exception 'วันที่ยกเลิกต้องไม่ก่อนวันที่ของแบบ' using errcode = '22023'; end if;
    v_src := f.entry_id;
  else raise exception 'คำสั่งไม่ถูกต้อง' using errcode = '22023';
  end if;
  if v_src is not null then
    select doc_no into v_no from acc.journal_entries where company_id = p_company and id = v_src;
    v_rv := acc.reverse_journal(p_company, v_src, p_date, p_idem, 'ยกเลิก ' || v_no || ': ' || btrim(p_reason));
  end if;
  if p_what = 'payment' then
    update acc.income_tax_filings set paid_on = null, pay_entry_id = null, pay_idem = null where company_id = p_company and id = p_id;
  else
    update acc.income_tax_filings set voided_at = now(), void_entry_id = v_rv, void_reason = btrim(p_reason) where company_id = p_company and id = p_id;
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
    or exists (select 1 from acc.income_tax_filings x where x.company_id = p_company and (x.entry_id = p_entry or x.pay_entry_id = p_entry)))
$$;

revoke all on function acc.cit_tax(numeric, boolean), acc.cit_period(uuid, date, date), acc.cit_preview(uuid, text, date, jsonb),
  acc.ensure_cit_accounts(uuid), acc.file_income_tax(uuid, jsonb, text), acc.pay_income_tax(uuid, uuid, jsonb, text),
  acc.void_income_tax(uuid, uuid, text, date, text, text) from public;
grant execute on function acc.cit_tax(numeric, boolean), acc.cit_period(uuid, date, date), acc.cit_preview(uuid, text, date, jsonb) to app_rw, app_ro;
grant execute on function acc.file_income_tax(uuid, jsonb, text), acc.pay_income_tax(uuid, uuid, jsonb, text),
  acc.void_income_tax(uuid, uuid, text, date, text, text) to app_rw;

-- migrate:down
drop function acc.void_income_tax(uuid, uuid, text, date, text, text), acc.pay_income_tax(uuid, uuid, jsonb, text), acc.file_income_tax(uuid, jsonb, text),
  acc.ensure_cit_accounts(uuid), acc.cit_preview(uuid, text, date, jsonb), acc.cit_period(uuid, date, date), acc.cit_tax(numeric, boolean);
drop table acc.income_tax_filings;
