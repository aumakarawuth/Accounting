-- migrate:up
-- ค่าเผื่อหนี้สงสัยจะสูญ · ตัดหนี้สูญรายใบ · หนี้สูญได้รับคืน (docs/phase6-spec.md ข้อ 4, docs/assumptions.md ข้อ 55)
-- ทุกรายการลงผ่าน acc.post_journal · ยกเลิกด้วยการกลับรายการ (acc.reverse_journal) เท่านั้น
-- ตั้งค่าเผื่อ = AJ สิ้นเดือน Dr 5270 / Cr 1211 · ตัดหนี้สูญ = JV Dr 1211 (+ Dr 2211 ภาษียังไม่ถึงกำหนดของบริการ) / Cr 1210
-- ได้รับคืน = JV Dr 1210 / Cr 1211 หรือ 4340 (+ Cr 2211) · ยอดค้างของใบ (acc.document_settled) หักยอดตัด บวกยอดรับคืน

create function acc.ensure_bad_debt_accounts(p_company uuid) returns void
language sql security definer set search_path = acc, pg_temp as $$
  insert into acc.chart_of_accounts (company_id, code, name, type)
  values (p_company, '1211', 'ค่าเผื่อหนี้สงสัยจะสูญ', 'asset'),
         (p_company, '5270', 'หนี้สงสัยจะสูญ', 'expense'),
         (p_company, '4340', 'หนี้สูญได้รับคืน', 'revenue')
  on conflict (company_id, code) do update set active = true where not acc.chart_of_accounts.active;
$$;
insert into acc.coa_template (code, name, type) values
  ('1211', 'ค่าเผื่อหนี้สงสัยจะสูญ', 'asset'), ('5270', 'หนี้สงสัยจะสูญ', 'expense'), ('4340', 'หนี้สูญได้รับคืน', 'revenue')
on conflict (code) do nothing;

-- ---- ตัดหนี้สูญรายใบ ----
create table acc.bad_debt_writeoffs (
  id            uuid not null default gen_random_uuid(),
  company_id    uuid not null references acc.companies(id),
  document_id   uuid not null,
  doc_date      date not null,
  amount        numeric(18,2) not null check (amount > 0),
  vat           numeric(18,2) not null default 0 check (vat >= 0 and vat < amount),  -- ภาษีขายยังไม่ถึงกำหนด (บริการ) ที่ล้างพร้อมการตัด
  reason        text not null check (length(btrim(reason)) between 1 and 300),
  entry_id      uuid not null,
  idem_key      text not null,
  voided_at     timestamptz,
  void_entry_id uuid,
  void_reason   text check (length(void_reason) <= 300),
  created_by    uuid not null references acc.users(id),
  created_at    timestamptz not null default now(),
  primary key (company_id, id),
  unique (company_id, idem_key),
  foreign key (company_id, document_id) references acc.documents (company_id, id),
  foreign key (company_id, entry_id) references acc.journal_entries (company_id, id),
  foreign key (company_id, void_entry_id) references acc.journal_entries (company_id, id),
  check ((voided_at is null) = (void_entry_id is null))
);
create index bad_debt_writeoffs_document on acc.bad_debt_writeoffs (company_id, document_id);

-- ---- หนี้สูญได้รับคืน ----
create table acc.bad_debt_recoveries (
  id            uuid not null default gen_random_uuid(),
  company_id    uuid not null references acc.companies(id),
  writeoff_id   uuid not null,
  doc_date      date not null,
  amount        numeric(18,2) not null check (amount > 0),
  vat           numeric(18,2) not null default 0 check (vat >= 0 and vat < amount),
  credit_account_id uuid not null,
  entry_id      uuid not null,
  idem_key      text not null,
  voided_at     timestamptz,
  void_entry_id uuid,
  void_reason   text check (length(void_reason) <= 300),
  created_by    uuid not null references acc.users(id),
  created_at    timestamptz not null default now(),
  primary key (company_id, id),
  unique (company_id, idem_key),
  foreign key (company_id, writeoff_id) references acc.bad_debt_writeoffs (company_id, id),
  foreign key (company_id, credit_account_id) references acc.chart_of_accounts (company_id, id),
  foreign key (company_id, entry_id) references acc.journal_entries (company_id, id),
  foreign key (company_id, void_entry_id) references acc.journal_entries (company_id, id),
  check ((voided_at is null) = (void_entry_id is null))
);
create index bad_debt_recoveries_writeoff on acc.bad_debt_recoveries (company_id, writeoff_id);

-- ---- ตั้งค่าเผื่อหนี้สงสัยจะสูญ ----
create table acc.allowance_entries (
  id            uuid not null default gen_random_uuid(),
  company_id    uuid not null references acc.companies(id),
  month         date not null check (month = date_trunc('month', month)::date),
  method        text not null check (method in ('sales', 'receivables', 'aging')),
  rates         jsonb not null,
  base          numeric(18,2) not null,      -- ขายเชื่อสุทธิ / ยอดลูกหนี้ / ยอดค้างตามอายุ
  required      numeric(18,2) not null,      -- ค่าเผื่อที่ต้องมี (วิธียอดขาย = หนี้สงสัยจะสูญของงวด)
  previous      numeric(18,2) not null,      -- ยอด 1211 ก่อนรายการนี้ (ด้านเครดิต)
  amount        numeric(18,2) not null check (amount <> 0),  -- บวก = ตั้งเพิ่ม · ลบ = ลดค่าเผื่อ
  entry_id      uuid not null,
  idem_key      text not null,
  voided_at     timestamptz,
  void_entry_id uuid,
  void_reason   text check (length(void_reason) <= 300),
  created_by    uuid not null references acc.users(id),
  created_at    timestamptz not null default now(),
  primary key (company_id, id),
  unique (company_id, idem_key),
  foreign key (company_id, entry_id) references acc.journal_entries (company_id, id),
  foreign key (company_id, void_entry_id) references acc.journal_entries (company_id, id),
  check ((voided_at is null) = (void_entry_id is null))
);

do $$ declare t text; begin
  foreach t in array array['bad_debt_writeoffs', 'bad_debt_recoveries', 'allowance_entries'] loop
    execute format('create trigger %1$s_guard before update on acc.%1$s for each row execute function acc.guard_void_only()', t);
    execute format('create trigger %1$s_no_delete before delete on acc.%1$s for each row execute function acc.forbid_mutation()', t);
    execute format('create trigger %1$s_locked before insert or update on acc.%1$s for each row execute function acc.guard_locked_company()', t);
    execute format('create trigger audit_%1$s after insert or update on acc.%1$s for each row execute function acc.audit_row()', t);
    execute format('alter table acc.%1$s enable row level security', t);
    execute format('grant select on acc.%1$s to app_rw, app_ro', t);
    execute format('create policy %1$s_read on acc.%1$s for select to app_rw, app_ro using (company_id in (select app.readable_company_ids()))', t);
  end loop;
end $$;

-- ยอดค้างของใบขายเชื่อ/ใบเพิ่มหนี้: รับชำระ/ลดหนี้ + ตัดหนี้สูญ − ได้รับคืน (ที่ยังไม่ยกเลิก)
create or replace function acc.document_settled(p_company uuid, p_target uuid, out amount numeric, out vat numeric)
language sql stable set search_path = acc, pg_temp as $$
  select coalesce((select sum(a.amount) from acc.allocations a join acc.documents s on s.company_id = a.company_id and s.id = a.source_id
                    where a.company_id = p_company and a.target_id = p_target and s.voided_at is null), 0)
         + coalesce((select sum(w.amount) from acc.bad_debt_writeoffs w
                      where w.company_id = p_company and w.document_id = p_target and w.voided_at is null), 0)
         - coalesce((select sum(r.amount) from acc.bad_debt_recoveries r join acc.bad_debt_writeoffs w on w.company_id = r.company_id and w.id = r.writeoff_id
                      where r.company_id = p_company and w.document_id = p_target and r.voided_at is null), 0),
         coalesce((select sum(a.vat_transfer) from acc.allocations a join acc.documents s on s.company_id = a.company_id and s.id = a.source_id
                    where a.company_id = p_company and a.target_id = p_target and s.voided_at is null), 0)
         + coalesce((select sum(w.vat) from acc.bad_debt_writeoffs w
                      where w.company_id = p_company and w.document_id = p_target and w.voided_at is null), 0)
         - coalesce((select sum(r.vat) from acc.bad_debt_recoveries r join acc.bad_debt_writeoffs w on w.company_id = r.company_id and w.id = r.writeoff_id
                      where r.company_id = p_company and w.document_id = p_target and r.voided_at is null), 0)
$$;

-- ยอดค้างรายใบ ณ สิ้นวัน p_as_of (นับเฉพาะรับชำระ/ลดหนี้/ตัด/รับคืนที่ลงวันที่ไม่เกินวันนั้น) ใช้กับค่าเผื่อตามอายุลูกหนี้
create function acc.ar_open_items_as_of(p_company uuid, p_as_of date)
returns table (document_id uuid, doc_no text, doc_date date, due_date date, party_name text, open numeric)
language sql stable security definer set search_path = acc, pg_temp as $$
  select d.id, d.doc_no, d.doc_date, d.due_date, d.party_name,
         d.total
         - coalesce((select sum(a.amount) from acc.allocations a join acc.documents s on s.company_id = a.company_id and s.id = a.source_id
                      where a.company_id = d.company_id and a.target_id = d.id and s.voided_at is null and s.doc_date <= p_as_of), 0)
         - coalesce((select sum(w.amount) from acc.bad_debt_writeoffs w
                      where w.company_id = d.company_id and w.document_id = d.id and w.voided_at is null and w.doc_date <= p_as_of), 0)
         + coalesce((select sum(r.amount) from acc.bad_debt_recoveries r join acc.bad_debt_writeoffs w on w.company_id = r.company_id and w.id = r.writeoff_id
                      where r.company_id = d.company_id and w.document_id = d.id and r.voided_at is null and r.doc_date <= p_as_of), 0)
    from acc.documents d
   where d.company_id = p_company and app.can_read_company(p_company)
     and d.kind in ('sales_invoice', 'debit_note') and d.voided_at is null and d.doc_date <= p_as_of
$$;

-- ยอดบัญชีสุทธิ (เดบิต − เครดิต) ณ สิ้นวัน
create function acc.account_net_as_of(p_company uuid, p_code text, p_as_of date) returns numeric
language sql stable security definer set search_path = acc, pg_temp as $$
  select coalesce(sum(l.debit - l.credit), 0)
    from acc.journal_lines l
    join acc.chart_of_accounts a on a.company_id = l.company_id and a.id = l.account_id and a.code = p_code
    join acc.journal_entries e on e.company_id = l.company_id and e.id = l.entry_id
   where l.company_id = p_company and app.can_read_company(p_company) and e.entry_date <= p_as_of
$$;

-- ดูค่าเผื่อก่อนลง: p_rates = {rate} (sales/receivables, ร้อยละ) หรือ {current,d30,d60,d90,over90} (aging) · sales รับ {scope: month|ytd}
create function acc.allowance_preview(p_company uuid, p_month date, p_method text, p_rates jsonb) returns jsonb
language plpgsql stable security definer set search_path = acc, pg_temp as $$
declare
  v_m date := date_trunc('month', p_month)::date;
  v_end date := (date_trunc('month', p_month) + interval '1 month - 1 day')::date;
  v_from date; v_base numeric := 0; v_req numeric := 0; v_prev numeric; v_rate numeric; v_buckets jsonb := '[]';
  b record; k text;
begin
  if not app.can_read_company(p_company) then raise exception 'ไม่มีสิทธิ์' using errcode = '42501'; end if;
  if p_method not in ('sales', 'receivables', 'aging') then raise exception 'วิธีตั้งค่าเผื่อไม่ถูกต้อง' using errcode = '22023'; end if;
  v_prev := -acc.account_net_as_of(p_company, '1211', v_end);
  if p_method in ('sales', 'receivables') then
    begin v_rate := (p_rates->>'rate')::numeric; exception when others then v_rate := null; end;
    if v_rate is null or v_rate <= 0 or v_rate > 100 then raise exception 'อัตราร้อยละต้องมากกว่า 0 และไม่เกิน 100' using errcode = '22023'; end if;
  end if;
  if p_method = 'sales' then
    v_from := case when p_rates->>'scope' = 'ytd' then acc.fiscal_year_start(p_company, v_m) else v_m end;
    select coalesce(sum(case when d.kind = 'credit_note' then -d.base else d.base end), 0) into v_base
      from acc.documents d
     where d.company_id = p_company and d.voided_at is null and d.doc_date between v_from and v_end
       and (d.kind in ('sales_invoice', 'debit_note')
            or (d.kind = 'credit_note' and exists (select 1 from acc.documents t where t.company_id = d.company_id and t.id = d.ref_document_id
                                                     and t.kind in ('sales_invoice', 'debit_note'))));
    v_req := round(v_base * v_rate / 100, 2);
    return jsonb_build_object('method', p_method, 'from', v_from, 'asOf', v_end, 'base', v_base::numeric(18,2)::text, 'required', v_req::numeric(18,2)::text,
      'previous', v_prev::numeric(18,2)::text, 'amount', v_req::numeric(18,2)::text, 'buckets', '[]'::jsonb);
  elsif p_method = 'receivables' then
    v_base := acc.account_net_as_of(p_company, '1210', v_end);
    v_req := round(greatest(v_base, 0) * v_rate / 100, 2);
  else
    for k in select unnest(array['current', 'd30', 'd60', 'd90', 'over90']) loop
      begin v_rate := coalesce((p_rates->>k)::numeric, 0); exception when others then v_rate := null; end;
      if v_rate is null or v_rate < 0 or v_rate > 100 then raise exception 'อัตราร้อยละของแต่ละช่วงต้องอยู่ระหว่าง 0 ถึง 100' using errcode = '22023'; end if;
      select coalesce(sum(o.open), 0) as open, count(*) as n into b
        from acc.ar_open_items_as_of(p_company, v_end) o
       where o.open > 0 and case k when 'current' then v_end <= coalesce(o.due_date, o.doc_date)
                                    when 'd30' then v_end - o.due_date between 1 and 30
                                    when 'd60' then v_end - o.due_date between 31 and 60
                                    when 'd90' then v_end - o.due_date between 61 and 90
                                    else v_end - o.due_date > 90 end;
      v_base := v_base + b.open;
      v_req := v_req + round(b.open * v_rate / 100, 2);
      v_buckets := v_buckets || jsonb_build_object('bucket', k, 'open', b.open::numeric(18,2)::text, 'count', b.n, 'rate', v_rate::text,
        'required', round(b.open * v_rate / 100, 2)::numeric(18,2)::text);
    end loop;
  end if;
  return jsonb_build_object('method', p_method, 'asOf', v_end, 'base', v_base::numeric(18,2)::text, 'required', v_req::numeric(18,2)::text,
    'previous', v_prev::numeric(18,2)::text, 'amount', (v_req - v_prev)::numeric(18,2)::text, 'buckets', v_buckets);
end $$;

create function acc.post_allowance(p_company uuid, p_month date, p_method text, p_rates jsonb, p_idem text) returns uuid
language plpgsql security definer set search_path = acc, pg_temp as $$
declare v_id uuid; v jsonb; v_amt numeric; v_eid uuid; v_end date := (date_trunc('month', p_month) + interval '1 month - 1 day')::date; v_je jsonb;
begin
  if not app.can_write_company(p_company) then raise exception 'ไม่มีสิทธิ์บันทึกรายการในบริษัทนี้' using errcode = '42501'; end if;
  select id into v_id from acc.allowance_entries where company_id = p_company and idem_key = p_idem;
  if found then return v_id; end if;
  perform acc.ensure_bad_debt_accounts(p_company);
  v := acc.allowance_preview(p_company, p_month, p_method, p_rates);
  v_amt := (v->>'amount')::numeric;
  if v_amt = 0 then raise exception 'ค่าเผื่อหนี้สงสัยจะสูญเท่ายอดที่ต้องมีแล้ว ไม่มีรายการต้องปรับ' using errcode = 'ACC17'; end if;
  v_je := case when v_amt > 0
    then jsonb_build_array(jsonb_build_object('account_code', '5270', 'debit', v_amt::text), jsonb_build_object('account_code', '1211', 'credit', v_amt::text))
    else jsonb_build_array(jsonb_build_object('account_code', '1211', 'debit', (-v_amt)::text), jsonb_build_object('account_code', '5270', 'credit', (-v_amt)::text)) end;
  v_eid := acc.post_journal(p_company, v_end,
    case when v_amt > 0 then 'ตั้งค่าเผื่อหนี้สงสัยจะสูญ ' else 'ลดค่าเผื่อหนี้สงสัยจะสูญ ' end || acc.thai_month(date_trunc('month', p_month)::date),
    v_je, p_idem, 'AJ', null);
  insert into acc.allowance_entries (company_id, month, method, rates, base, required, previous, amount, entry_id, idem_key, created_by)
  values (p_company, date_trunc('month', p_month)::date, p_method, p_rates, (v->>'base')::numeric, (v->>'required')::numeric,
          (v->>'previous')::numeric, v_amt, v_eid, p_idem, app.current_user_id())
  returning id into v_id;
  return v_id;
end $$;

-- p: {document_id, date, amount, reason}
create function acc.write_off_receivable(p_company uuid, p jsonb, p_idem text) returns uuid
language plpgsql security definer set search_path = acc, pg_temp as $$
declare d acc.documents; v_id uuid; v_date date; v_amt numeric; v_open numeric; v_undue numeric; v_vat numeric := 0; v_eid uuid; v_je jsonb;
begin
  if not app.can_write_company(p_company) then raise exception 'ไม่มีสิทธิ์บันทึกรายการในบริษัทนี้' using errcode = '42501'; end if;
  select id into v_id from acc.bad_debt_writeoffs where company_id = p_company and idem_key = p_idem;
  if found then return v_id; end if;
  begin v_date := (p->>'date')::date; v_amt := (p->>'amount')::numeric;
  exception when others then raise exception 'วันที่หรือจำนวนเงินไม่ถูกต้อง' using errcode = '22023'; end;
  if v_date is null then raise exception 'ต้องมีวันที่' using errcode = '22023'; end if;
  if v_amt is null or v_amt <= 0 or v_amt <> round(v_amt, 2) then raise exception 'จำนวนเงินต้องมากกว่า 0 ทศนิยมไม่เกิน 2 ตำแหน่ง' using errcode = 'ACC05'; end if;
  if length(btrim(coalesce(p->>'reason', ''))) = 0 then raise exception 'ต้องระบุเหตุผลที่ตัดเป็นหนี้สูญ' using errcode = '22023'; end if;
  select * into d from acc.documents where company_id = p_company and id = nullif(p->>'document_id', '')::uuid for update;
  if not found or d.kind not in ('sales_invoice', 'debit_note') or d.voided_at is not null then
    raise exception 'ตัดหนี้สูญได้เฉพาะใบขายเชื่อ/ใบเพิ่มหนี้ที่ยังไม่ยกเลิก' using errcode = 'ACC04';
  end if;
  if v_date < d.doc_date then raise exception 'วันที่ตัดหนี้สูญต้องไม่ก่อนวันที่ของ %', d.doc_no using errcode = '22023'; end if;
  select d.total - s.amount, case when d.is_service then d.vat - s.vat else 0 end into v_open, v_undue from acc.document_settled(p_company, d.id) s;
  if v_amt > v_open then
    raise exception 'ยอดตัด % เกินยอดค้างของ % (%)', to_char(v_amt, 'FM999,999,999,990.00'), d.doc_no, to_char(v_open, 'FM999,999,999,990.00') using errcode = 'ACC15';
  end if;
  -- บริการ: ภาษีขายยังไม่ถึงกำหนดของส่วนที่ตัดไม่มีวันถึงกำหนด ล้างออกตามสัดส่วน (ตัดหมดใบ = ภาษีที่เหลือทั้งหมด)
  if v_undue > 0 then v_vat := case when v_amt = v_open then v_undue else round(v_undue * v_amt / v_open, 2) end; end if;
  perform acc.ensure_bad_debt_accounts(p_company);
  v_je := jsonb_build_array(jsonb_build_object('account_code', '1211', 'debit', (v_amt - v_vat)::text, 'memo', d.doc_no || ' ' || d.party_name));
  if v_vat > 0 then v_je := v_je || jsonb_build_object('account_code', '2211', 'debit', v_vat::text); end if;
  v_je := v_je || jsonb_build_object('account_code', '1210', 'credit', v_amt::text, 'memo', d.doc_no || ' ' || d.party_name);
  v_eid := acc.post_journal(p_company, v_date, left('ตัดหนี้สูญ ' || d.doc_no || ' ' || d.party_name || ': ' || btrim(p->>'reason'), 300), v_je, p_idem, 'JV', null);
  insert into acc.bad_debt_writeoffs (company_id, document_id, doc_date, amount, vat, reason, entry_id, idem_key, created_by)
  values (p_company, d.id, v_date, v_amt, v_vat, btrim(p->>'reason'), v_eid, p_idem, app.current_user_id())
  returning id into v_id;
  return v_id;
end $$;

-- p: {writeoff_id, date, amount, credit: '1211' (ตั้งต้น) | '4340'}
create function acc.recover_bad_debt(p_company uuid, p jsonb, p_idem text) returns uuid
language plpgsql security definer set search_path = acc, pg_temp as $$
declare w acc.bad_debt_writeoffs; d acc.documents; v_id uuid; v_date date; v_amt numeric; v_left numeric; v_vat_left numeric; v_vat numeric := 0;
        v_cr acc.chart_of_accounts; v_eid uuid; v_je jsonb;
begin
  if not app.can_write_company(p_company) then raise exception 'ไม่มีสิทธิ์บันทึกรายการในบริษัทนี้' using errcode = '42501'; end if;
  select id into v_id from acc.bad_debt_recoveries where company_id = p_company and idem_key = p_idem;
  if found then return v_id; end if;
  begin v_date := (p->>'date')::date; v_amt := (p->>'amount')::numeric;
  exception when others then raise exception 'วันที่หรือจำนวนเงินไม่ถูกต้อง' using errcode = '22023'; end;
  if v_date is null then raise exception 'ต้องมีวันที่' using errcode = '22023'; end if;
  if v_amt is null or v_amt <= 0 or v_amt <> round(v_amt, 2) then raise exception 'จำนวนเงินต้องมากกว่า 0 ทศนิยมไม่เกิน 2 ตำแหน่ง' using errcode = 'ACC05'; end if;
  select * into w from acc.bad_debt_writeoffs where company_id = p_company and id = nullif(p->>'writeoff_id', '')::uuid for update;
  if not found or w.voided_at is not null then raise exception 'ไม่พบรายการตัดหนี้สูญ หรือถูกยกเลิกแล้ว' using errcode = 'ACC04'; end if;
  if v_date < w.doc_date then raise exception 'วันที่ได้รับคืนต้องไม่ก่อนวันที่ตัดหนี้สูญ' using errcode = '22023'; end if;
  select * into d from acc.documents where company_id = p_company and id = w.document_id;
  select w.amount - coalesce(sum(r.amount), 0), w.vat - coalesce(sum(r.vat), 0) into v_left, v_vat_left
    from acc.bad_debt_recoveries r where r.company_id = p_company and r.writeoff_id = w.id and r.voided_at is null;
  if v_amt > v_left then
    raise exception 'ยอดรับคืน % เกินยอดที่ตัดเป็นหนี้สูญซึ่งยังไม่ได้รับคืน (%)', to_char(v_amt, 'FM999,999,999,990.00'), to_char(v_left, 'FM999,999,999,990.00')
      using errcode = 'ACC15';
  end if;
  if v_vat_left > 0 then v_vat := case when v_amt = v_left then v_vat_left else round(v_vat_left * v_amt / v_left, 2) end; end if;
  perform acc.ensure_bad_debt_accounts(p_company);
  select * into v_cr from acc.chart_of_accounts where company_id = p_company and code = coalesce(nullif(p->>'credit', ''), '1211') and code in ('1211', '4340');
  if not found then raise exception 'บัญชีด้านเครดิตต้องเป็น 1211 ค่าเผื่อหนี้สงสัยจะสูญ หรือ 4340 หนี้สูญได้รับคืน' using errcode = 'ACC04'; end if;
  v_je := jsonb_build_array(jsonb_build_object('account_code', '1210', 'debit', v_amt::text, 'memo', d.doc_no || ' ' || d.party_name),
                            jsonb_build_object('account_code', v_cr.code, 'credit', (v_amt - v_vat)::text));
  if v_vat > 0 then v_je := v_je || jsonb_build_object('account_code', '2211', 'credit', v_vat::text); end if;
  v_eid := acc.post_journal(p_company, v_date, left('หนี้สูญได้รับคืน ' || d.doc_no || ' ' || d.party_name, 300), v_je, p_idem, 'JV', null);
  insert into acc.bad_debt_recoveries (company_id, writeoff_id, doc_date, amount, vat, credit_account_id, entry_id, idem_key, created_by)
  values (p_company, w.id, v_date, v_amt, v_vat, v_cr.id, v_eid, p_idem, app.current_user_id())
  returning id into v_id;
  return v_id;
end $$;

-- ยกเลิก (กลับรายการ): p_kind = allowance | writeoff | recovery
create function acc.void_bad_debt(p_company uuid, p_kind text, p_id uuid, p_date date, p_reason text, p_idem text) returns uuid
language plpgsql security definer set search_path = acc, pg_temp as $$
declare v_entry uuid; v_void uuid; v_rv uuid; v_no text; v_doc uuid; v_open numeric;
begin
  if not app.can_write_company(p_company) then raise exception 'ไม่มีสิทธิ์' using errcode = '42501'; end if;
  if p_kind = 'allowance' then
    select entry_id, void_entry_id into v_entry, v_void from acc.allowance_entries where company_id = p_company and id = p_id for update;
  elsif p_kind = 'writeoff' then
    select entry_id, void_entry_id into v_entry, v_void from acc.bad_debt_writeoffs where company_id = p_company and id = p_id for update;
  elsif p_kind = 'recovery' then
    select r.entry_id, r.void_entry_id, w.document_id into v_entry, v_void, v_doc
      from acc.bad_debt_recoveries r join acc.bad_debt_writeoffs w on w.company_id = r.company_id and w.id = r.writeoff_id
     where r.company_id = p_company and r.id = p_id for update of r;
  else
    raise exception 'ชนิดรายการไม่ถูกต้อง' using errcode = '22023';
  end if;
  if v_entry is null then raise exception 'ไม่พบรายการ' using errcode = 'ACC04'; end if;
  select doc_no into v_no from acc.journal_entries where company_id = p_company and id = v_entry;
  if v_void is not null then
    if exists (select 1 from acc.idempotency_keys where company_id = p_company and key = p_idem and entry_id = v_void) then return v_void; end if;
    raise exception '% ยกเลิกไปแล้ว', v_no using errcode = 'ACC16';
  end if;
  if length(btrim(coalesce(p_reason, ''))) = 0 then raise exception 'ต้องระบุเหตุผลที่ยกเลิก' using errcode = '22023'; end if;
  if p_kind = 'writeoff' and exists (select 1 from acc.bad_debt_recoveries where company_id = p_company and writeoff_id = p_id and voided_at is null) then
    raise exception 'ยกเลิก % ไม่ได้ มีรายการได้รับคืนอ้างอยู่ ยกเลิกรายการได้รับคืนก่อน', v_no using errcode = 'ACC16';
  end if;
  if p_kind = 'recovery' then
    -- รับคืนแล้วรับชำระไปแล้ว: ยกเลิกแล้วยอดค้างของใบจะติดลบ
    select d.total - s.amount into v_open from acc.documents d cross join lateral acc.document_settled(p_company, d.id) s
     where d.company_id = p_company and d.id = v_doc;
    if v_open < (select amount from acc.bad_debt_recoveries where company_id = p_company and id = p_id) then
      raise exception 'ยกเลิก % ไม่ได้ ยอดที่ได้รับคืนถูกรับชำระแล้ว ยกเลิกใบเสร็จก่อน', v_no using errcode = 'ACC16';
    end if;
  end if;
  v_rv := acc.reverse_journal(p_company, v_entry, p_date, p_idem, 'ยกเลิก ' || v_no || ': ' || btrim(p_reason));
  if p_kind = 'allowance' then
    update acc.allowance_entries set voided_at = now(), void_entry_id = v_rv, void_reason = btrim(p_reason) where company_id = p_company and id = p_id;
  elsif p_kind = 'writeoff' then
    update acc.bad_debt_writeoffs set voided_at = now(), void_entry_id = v_rv, void_reason = btrim(p_reason) where company_id = p_company and id = p_id;
  else
    update acc.bad_debt_recoveries set voided_at = now(), void_entry_id = v_rv, void_reason = btrim(p_reason) where company_id = p_company and id = p_id;
  end if;
  return v_rv;
end $$;

revoke all on function acc.ensure_bad_debt_accounts(uuid), acc.post_allowance(uuid, date, text, jsonb, text), acc.write_off_receivable(uuid, jsonb, text),
  acc.recover_bad_debt(uuid, jsonb, text), acc.void_bad_debt(uuid, text, uuid, date, text, text), acc.allowance_preview(uuid, date, text, jsonb),
  acc.ar_open_items_as_of(uuid, date), acc.account_net_as_of(uuid, text, date) from public;
grant execute on function acc.post_allowance(uuid, date, text, jsonb, text), acc.write_off_receivable(uuid, jsonb, text),
  acc.recover_bad_debt(uuid, jsonb, text), acc.void_bad_debt(uuid, text, uuid, date, text, text) to app_rw;
grant execute on function acc.allowance_preview(uuid, date, text, jsonb), acc.ar_open_items_as_of(uuid, date), acc.account_net_as_of(uuid, text, date)
  to app_rw, app_ro;

-- migrate:down
drop function acc.void_bad_debt(uuid, text, uuid, date, text, text), acc.recover_bad_debt(uuid, jsonb, text), acc.write_off_receivable(uuid, jsonb, text),
  acc.post_allowance(uuid, date, text, jsonb, text), acc.allowance_preview(uuid, date, text, jsonb), acc.ar_open_items_as_of(uuid, date),
  acc.account_net_as_of(uuid, text, date), acc.ensure_bad_debt_accounts(uuid);
create or replace function acc.document_settled(p_company uuid, p_target uuid, out amount numeric, out vat numeric)
language sql stable set search_path = acc, pg_temp as $$
  select coalesce(sum(a.amount), 0), coalesce(sum(a.vat_transfer), 0)
    from acc.allocations a join acc.documents s on s.company_id = a.company_id and s.id = a.source_id
   where a.company_id = p_company and a.target_id = p_target and s.voided_at is null
$$;
drop table acc.bad_debt_recoveries, acc.bad_debt_writeoffs, acc.allowance_entries;
