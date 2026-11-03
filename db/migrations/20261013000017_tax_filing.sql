-- migrate:up
-- เฟส 2.4 ภาษี: รายงานภาษีขาย/ภาษีซื้อ ปิดภาษีมูลค่าเพิ่มรายเดือน (ภ.พ.30, T10) ชำระภาษี นำส่งภาษีหัก ณ ที่จ่าย (ภ.ง.ด.3/53)
-- ยอดปิดภาษีคิดจากบัญชีแยกประเภท (2210 ภาษีขาย / 1410 ภาษีซื้อ) ของเดือน รายงานคิดจากเอกสาร มีเทสต์ยืนยันว่าตรงกัน

create table acc.vat_closings (
  id            uuid not null default gen_random_uuid(),
  company_id    uuid not null references acc.companies(id),
  month         date not null check (extract(day from month) = 1),
  output_vat    numeric(18,2) not null,              -- ภาษีขายของเดือน (ยอดเครดิตสุทธิ 2210)
  input_vat     numeric(18,2) not null,              -- ภาษีซื้อของเดือน (ยอดเดบิตสุทธิ 1410)
  carry_used    numeric(18,2) not null default 0 check (carry_used >= 0),   -- ภาษีชำระเกินยกมา (1430) ที่ใช้หัก
  payable       numeric(18,2) not null default 0 check (payable >= 0),      -- ต้องชำระ (2220)
  refundable    numeric(18,2) not null default 0 check (refundable >= 0),   -- ชำระเกิน (1430) ยกไปเดือนถัดไป
  entry_id      uuid,
  paid_entry_id uuid,
  idem_key      text not null,
  voided_at     timestamptz,
  void_entry_id uuid,
  void_reason   text check (length(void_reason) <= 300),
  created_by    uuid not null references acc.users(id),
  created_at    timestamptz not null default now(),
  primary key (company_id, id),
  unique (company_id, idem_key),
  foreign key (company_id, entry_id) references acc.journal_entries (company_id, id),
  foreign key (company_id, paid_entry_id) references acc.journal_entries (company_id, id),
  foreign key (company_id, void_entry_id) references acc.journal_entries (company_id, id),
  check (output_vat - input_vat = payable + carry_used - refundable),
  check (not (payable > 0 and refundable > 0))
);
create unique index vat_closings_active on acc.vat_closings (company_id, month) where voided_at is null;

create table acc.wht_remittances (
  id          uuid not null default gen_random_uuid(),
  company_id  uuid not null references acc.companies(id),
  month       date not null check (extract(day from month) = 1),
  form        text not null check (form in ('pnd3', 'pnd53')),
  amount      numeric(18,2) not null check (amount > 0),
  cert_count  int not null check (cert_count > 0),
  entry_id    uuid not null,
  idem_key    text not null,
  created_by  uuid not null references acc.users(id),
  created_at  timestamptz not null default now(),
  primary key (company_id, id),
  unique (company_id, month, form),
  unique (company_id, idem_key),
  foreign key (company_id, entry_id) references acc.journal_entries (company_id, id)
);

-- ปิดภาษีแล้วแก้ได้เฉพาะ: บันทึกการชำระ (ครั้งเดียว) และยกเลิก (ครั้งเดียว)
create function acc.guard_vat_closing_update() returns trigger
language plpgsql as $$
begin
  if old.voided_at is not null
     or (old.paid_entry_id is not null and new.paid_entry_id is distinct from old.paid_entry_id)
     or (to_jsonb(new) - '{paid_entry_id,voided_at,void_entry_id,void_reason}'::text[])
        <> (to_jsonb(old) - '{paid_entry_id,voided_at,void_entry_id,void_reason}'::text[]) then
    raise exception 'การปิดภาษีที่บันทึกแล้วแก้ไม่ได้' using errcode = 'ACC06';
  end if;
  return new;
end $$;
create trigger vat_closings_guard before update on acc.vat_closings for each row execute function acc.guard_vat_closing_update();
create trigger vat_closings_no_delete before delete on acc.vat_closings for each row execute function acc.forbid_mutation();
create trigger wht_remittances_immutable before update or delete on acc.wht_remittances for each row execute function acc.forbid_mutation();
create trigger vat_closings_locked before insert or update on acc.vat_closings for each row execute function acc.guard_locked_company();
create trigger wht_remittances_locked before insert on acc.wht_remittances for each row execute function acc.guard_locked_company();
create trigger audit_vat_closings after insert or update on acc.vat_closings for each row execute function acc.audit_row();
create trigger audit_wht_remittances after insert on acc.wht_remittances for each row execute function acc.audit_row();

alter table acc.vat_closings enable row level security;
alter table acc.wht_remittances enable row level security;
grant select on acc.vat_closings, acc.wht_remittances to app_rw, app_ro;
create policy vat_closings_read on acc.vat_closings for select to app_rw, app_ro using (app.can_read_company(company_id));
create policy wht_remittances_read on acc.wht_remittances for select to app_rw, app_ro using (app.can_read_company(company_id));

-- เดือนภาษีที่ปิดแล้ว: ห้ามลงภาษีขาย/ภาษีซื้อ (2210/1410) ลงวันที่ในเดือนนั้นหรือก่อนหน้า
-- ยกเว้นรายการปิดภาษีเอง (VC) และการกลับรายการปิดภาษีตอนยกเลิก (RV ของ VC)
create function acc.guard_vat_month() returns trigger
language plpgsql as $$
declare
  e      acc.journal_entries;
  v_code text;
  v_rev  text;
begin
  select a.code into v_code from acc.chart_of_accounts a where a.company_id = new.company_id and a.id = new.account_id;
  if v_code not in ('2210', '1410') then return new; end if;
  select * into e from acc.journal_entries where company_id = new.company_id and id = new.entry_id;
  if e.doc_prefix = 'VC' then return new; end if;
  if e.reverses_entry_id is not null then
    select doc_prefix into v_rev from acc.journal_entries where company_id = new.company_id and id = e.reverses_entry_id;
    if v_rev = 'VC' then return new; end if;
  end if;
  if exists (select 1 from acc.vat_closings c
              where c.company_id = new.company_id and c.voided_at is null and c.month >= date_trunc('month', e.entry_date)::date) then
    raise exception 'เดือนภาษี %/% ปิดแล้ว (ยื่น ภ.พ.30 แล้ว) ลงภาษีขาย/ภาษีซื้อลงวันที่ในเดือนนี้ไม่ได้ ใช้วันที่ในเดือนที่ยังไม่ปิด',
      to_char(e.entry_date, 'MM'), extract(year from e.entry_date)::int + 543 using errcode = 'ACC17';
  end if;
  return new;
end $$;
create trigger journal_lines_vat_month before insert on acc.journal_lines for each row execute function acc.guard_vat_month();

-- นำส่ง ภ.ง.ด. เดือนไหนแล้ว: ออก 50 ทวิ ใหม่หรือยกเลิก 50 ทวิ ของเดือน/แบบนั้นไม่ได้ (ยอดนำส่งจะไม่ตรง)
create function acc.guard_wht_remitted() returns trigger
language plpgsql as $$
begin
  if (tg_op = 'INSERT' or (new.voided_at is not null and old.voided_at is null))
     and exists (select 1 from acc.wht_remittances r where r.company_id = new.company_id and r.form = new.form
                    and r.month = date_trunc('month', new.cert_date)::date) then
    raise exception 'นำส่ง % เดือน %/% แล้ว ออกหรือยกเลิกหนังสือรับรองของเดือนนี้ไม่ได้',
      case new.form when 'pnd3' then 'ภ.ง.ด.3' else 'ภ.ง.ด.53' end,
      to_char(new.cert_date, 'MM'), extract(year from new.cert_date)::int + 543 using errcode = 'ACC17';
  end if;
  return new;
end $$;
create trigger wht_certificates_remitted before insert or update on acc.wht_certificates for each row execute function acc.guard_wht_remitted();

-- รายงานภาษีขาย ('sales') / ภาษีซื้อ ('purchases') ของเดือน: ใบกำกับภาษีที่ลงภาษีขาย 2210 / ภาษีซื้อ 1410
-- ยกเลิกในเดือนเดียวกัน = แถวยอดศูนย์ สถานะยกเลิก · ยกเลิกต่างเดือน = แถวติดลบในเดือนที่ยกเลิก
create function acc.vat_report(p_company uuid, p_month date, p_side text)
returns table (row_date date, document_id uuid, doc_no text, ref_no text, kind text, party_name text, party_tax_id text,
               party_branch_no text, base numeric, vat numeric, status text)
language sql stable as $$
  with ev as (
    select d.id, d.doc_date, d.doc_no, null::text as ref_no, d.kind, d.party_name, d.party_tax_id, d.party_branch_no,
           case when d.kind = 'credit_note' then -1 else 1 end as sign,
           case when d.kind = 'receipt' then (select coalesce(sum(a.amount - a.vat_transfer), 0) from acc.allocations a
                                               join acc.documents t on t.company_id = a.company_id and t.id = a.target_id
                                              where a.company_id = d.company_id and a.source_id = d.id and t.is_service)
                else d.base end as base,
           d.vat, d.void_entry_id
      from acc.documents d
     where p_side = 'sales' and d.company_id = p_company and d.is_tax_invoice
       and (d.kind <> 'receipt' or d.vat > 0)
    union all
    select d.id, d.doc_date, d.doc_no,
           case when d.kind = 'payment' then (select string_agg(t.vendor_doc_no, ', ' order by t.doc_no) from acc.purchase_allocations a
                                               join acc.purchase_documents t on t.company_id = a.company_id and t.id = a.target_id
                                              where a.company_id = d.company_id and a.source_id = d.id and t.is_service and t.vat_claimable)
                else d.vendor_doc_no end,
           d.kind, d.party_name, d.party_tax_id, d.party_branch_no,
           case when d.kind = 'purchase_credit_note' then -1 else 1 end,
           case when d.kind = 'payment' then (select coalesce(sum(a.amount - a.vat_transfer), 0) from acc.purchase_allocations a
                                               join acc.purchase_documents t on t.company_id = a.company_id and t.id = a.target_id
                                              where a.company_id = d.company_id and a.source_id = d.id and t.is_service and t.vat_claimable)
                else d.base end,
           d.vat, d.void_entry_id
      from acc.purchase_documents d
     where p_side = 'purchases' and d.company_id = p_company and d.vat_claimable and d.vat > 0
       and (d.kind in ('cash_purchase', 'payment') or not d.is_service)
  ), x as (
    select ev.*, ve.entry_date as void_date
      from ev left join acc.journal_entries ve on ve.company_id = p_company and ve.id = ev.void_entry_id
  )
  select doc_date, id, doc_no, ref_no, kind, party_name, party_tax_id, party_branch_no,
         case when void_date is not null and date_trunc('month', void_date) = date_trunc('month', doc_date) then 0 else sign * base end,
         case when void_date is not null and date_trunc('month', void_date) = date_trunc('month', doc_date) then 0 else sign * vat end,
         case when void_date is not null and date_trunc('month', void_date) = date_trunc('month', doc_date) then 'voided' else 'normal' end
    from x where date_trunc('month', doc_date) = date_trunc('month', p_month)
  union all
  select void_date, id, doc_no, ref_no, kind, party_name, party_tax_id, party_branch_no, -sign * base, -sign * vat, 'void_reversal'
    from x where void_date is not null and date_trunc('month', void_date) = date_trunc('month', p_month)
     and date_trunc('month', void_date) <> date_trunc('month', doc_date)
  order by 1, 3
$$;

-- ยอดเคลื่อนไหวสุทธิของบัญชีในช่วงวันที่ (เดบิต − เครดิต)
create function acc.account_movement(p_company uuid, p_code text, p_from date, p_to date) returns numeric
language sql stable as $$
  select coalesce(sum(l.debit - l.credit), 0)
    from acc.journal_lines l
    join acc.journal_entries e on e.company_id = l.company_id and e.id = l.entry_id
    join acc.chart_of_accounts a on a.company_id = l.company_id and a.id = l.account_id
   where l.company_id = p_company and a.code = p_code
     and (p_from is null or e.entry_date >= p_from) and e.entry_date <= p_to
$$;

create function acc.ensure_vat_accounts(p_company uuid) returns void
language sql security definer set search_path = acc, pg_temp as $$
  insert into acc.chart_of_accounts (company_id, code, name, type)
  select p_company, t.code, t.name, t.type from acc.coa_template t
   where t.code in ('1410', '1430', '2210', '2220', '2230')
  on conflict (company_id, code) do nothing
$$;

-- ---- ปิดภาษีมูลค่าเพิ่มประจำเดือน (T10) ปิดเรียงเดือน: ภาษีขาย/ภาษีซื้อก่อนเดือนนี้ต้องปิดหมดแล้ว (ยอดยกมาเป็นศูนย์) ----
-- รายการ (VC ลงวันสิ้นเดือน): เดบิตภาษีขาย เครดิตภาษีซื้อ · ภาษีขายมากกว่า: ใช้ภาษีชำระเกินยกมา (1430) ก่อน ที่เหลือเครดิต 2220
-- · ภาษีซื้อมากกว่า: เดบิต 1430 ยกไปเดือนถัดไป
create function acc.close_vat_month(p_company uuid, p_month date, p_idem text) returns uuid
language plpgsql security definer set search_path = acc, pg_temp as $$
declare
  co      acc.companies;
  v_id    uuid;
  v_start date := date_trunc('month', p_month)::date;
  v_end   date := (date_trunc('month', p_month) + interval '1 month - 1 day')::date;
  v_out   numeric; v_in numeric; v_carry numeric; v_pay numeric; v_ref numeric; v_bal1430 numeric;
  v_je    jsonb := '[]';
  v_eid   uuid;
begin
  if not app.can_write_company(p_company) then
    raise exception 'ไม่มีสิทธิ์ปิดภาษีในบริษัทนี้' using errcode = '42501';
  end if;
  select id into v_id from acc.vat_closings where company_id = p_company and idem_key = p_idem;
  if found then return v_id; end if;
  select * into co from acc.companies where id = p_company for update; -- กันปิดเดือนเดียวกันพร้อมกัน
  if not co.vat_registered then
    raise exception 'บริษัทไม่ได้จดทะเบียนภาษีมูลค่าเพิ่ม ไม่ต้องยื่น ภ.พ.30' using errcode = '22023';
  end if;
  perform acc.ensure_vat_accounts(p_company);
  if exists (select 1 from acc.vat_closings where company_id = p_company and month = v_start and voided_at is null) then
    raise exception 'ปิดภาษีเดือนนี้ไปแล้ว' using errcode = 'ACC17';
  end if;
  if exists (select 1 from acc.vat_closings where company_id = p_company and month > v_start and voided_at is null) then
    raise exception 'ปิดภาษีเดือนหลังจากนี้ไปแล้ว ปิดย้อนหลังไม่ได้' using errcode = 'ACC17';
  end if;
  if acc.account_movement(p_company, '2210', null, v_start - 1) <> 0 or acc.account_movement(p_company, '1410', null, v_start - 1) <> 0 then
    raise exception 'ยังมีภาษีขาย/ภาษีซื้อของเดือนก่อนหน้าที่ยังไม่ปิด ปิดภาษีเรียงจากเดือนเก่าก่อน' using errcode = 'ACC17';
  end if;
  v_out := -acc.account_movement(p_company, '2210', v_start, v_end);
  v_in := acc.account_movement(p_company, '1410', v_start, v_end);
  v_bal1430 := acc.account_movement(p_company, '1430', null, v_end);
  v_carry := least(greatest(v_bal1430, 0), greatest(v_out - v_in, 0));
  v_pay := greatest(v_out - v_in - v_carry, 0);
  v_ref := greatest(v_in - v_out, 0);

  if v_out <> 0 then
    v_je := v_je || jsonb_build_object('account_code', '2210', case when v_out > 0 then 'debit' else 'credit' end, abs(v_out)::text);
  end if;
  if v_in <> 0 then
    v_je := v_je || jsonb_build_object('account_code', '1410', case when v_in > 0 then 'credit' else 'debit' end, abs(v_in)::text);
  end if;
  if v_ref > 0 then v_je := v_je || jsonb_build_object('account_code', '1430', 'debit', v_ref::text); end if;
  if v_carry > 0 then v_je := v_je || jsonb_build_object('account_code', '1430', 'credit', v_carry::text); end if;
  if v_pay > 0 then v_je := v_je || jsonb_build_object('account_code', '2220', 'credit', v_pay::text); end if;
  if jsonb_array_length(v_je) > 0 then
    v_eid := acc.post_journal(p_company, v_end,
      'ปิดภาษีมูลค่าเพิ่ม เดือน ' || to_char(v_start, 'MM') || '/' || (extract(year from v_start)::int + 543), v_je, p_idem, 'VC', null);
  end if;

  insert into acc.vat_closings (company_id, month, output_vat, input_vat, carry_used, payable, refundable, entry_id, idem_key, created_by)
  values (p_company, v_start, v_out, v_in, v_carry, v_pay, v_ref, v_eid, p_idem, app.current_user_id())
  returning id into v_id;
  return v_id;
end $$;

-- ยกเลิกการปิดภาษี (เฉพาะเดือนล่าสุดที่ยังไม่ได้ชำระ): กลับรายการปิดลงวันสิ้นเดือนเดิม แล้วลงภาษีในเดือนนั้นได้อีก
create function acc.void_vat_close(p_company uuid, p_closing uuid, p_reason text, p_idem text) returns uuid
language plpgsql security definer set search_path = acc, pg_temp as $$
declare
  c    acc.vat_closings;
  v_rv uuid;
begin
  if not app.can_write_company(p_company) then
    raise exception 'ไม่มีสิทธิ์ยกเลิกการปิดภาษีในบริษัทนี้' using errcode = '42501';
  end if;
  select * into c from acc.vat_closings where company_id = p_company and id = p_closing for update;
  if not found then raise exception 'ไม่พบการปิดภาษี' using errcode = 'ACC04'; end if;
  if c.voided_at is not null then
    if c.void_entry_id is null or exists (select 1 from acc.idempotency_keys where company_id = p_company and key = p_idem and entry_id = c.void_entry_id) then
      return c.void_entry_id;
    end if;
    raise exception 'ยกเลิกการปิดภาษีเดือนนี้ไปแล้ว' using errcode = 'ACC16';
  end if;
  if length(btrim(coalesce(p_reason, ''))) = 0 then
    raise exception 'ต้องระบุเหตุผลที่ยกเลิก' using errcode = '22023';
  end if;
  if c.paid_entry_id is not null then
    raise exception 'ชำระภาษีเดือนนี้แล้ว ยกเลิกการปิดไม่ได้' using errcode = 'ACC16';
  end if;
  if exists (select 1 from acc.vat_closings where company_id = p_company and month > c.month and voided_at is null) then
    raise exception 'ยกเลิกได้เฉพาะเดือนล่าสุดที่ปิด ยกเลิกเดือนหลังจากนี้ก่อน' using errcode = 'ACC16';
  end if;
  if c.entry_id is not null then
    v_rv := acc.reverse_journal(p_company, c.entry_id, (c.month + interval '1 month - 1 day')::date, p_idem,
      'ยกเลิกการปิดภาษี: ' || btrim(p_reason));
  end if;
  update acc.vat_closings set voided_at = now(), void_entry_id = v_rv, void_reason = btrim(p_reason)
   where company_id = p_company and id = c.id;
  return v_rv;
end $$;

-- ชำระภาษีมูลค่าเพิ่มตาม ภ.พ.30 ที่ปิดแล้ว: เดบิต 2220 เครดิตเงินสด/ธนาคาร (TX)
create function acc.pay_vat(p_company uuid, p_closing uuid, p_date date, p_cash text, p_idem text) returns uuid
language plpgsql security definer set search_path = acc, pg_temp as $$
declare
  c      acc.vat_closings;
  v_cash acc.chart_of_accounts;
  v_eid  uuid;
begin
  if not app.can_write_company(p_company) then
    raise exception 'ไม่มีสิทธิ์ชำระภาษีในบริษัทนี้' using errcode = '42501';
  end if;
  select * into c from acc.vat_closings where company_id = p_company and id = p_closing for update;
  if not found or c.voided_at is not null then raise exception 'ไม่พบการปิดภาษีที่ใช้อยู่' using errcode = 'ACC04'; end if;
  if c.paid_entry_id is not null then
    if exists (select 1 from acc.idempotency_keys where company_id = p_company and key = p_idem and entry_id = c.paid_entry_id) then
      return c.paid_entry_id;
    end if;
    raise exception 'ชำระภาษีเดือนนี้แล้ว' using errcode = 'ACC16';
  end if;
  if c.payable <= 0 then raise exception 'เดือนนี้ไม่มีภาษีต้องชำระ' using errcode = '22023'; end if;
  if p_date is null or p_date <= (c.month + interval '1 month - 1 day')::date then
    raise exception 'วันที่ชำระต้องหลังสิ้นเดือนภาษี' using errcode = '22023';
  end if;
  select * into v_cash from acc.chart_of_accounts
   where company_id = p_company and code = coalesce(nullif(p_cash, ''), '1110') and active and type = 'asset' and code like '11%';
  if not found then raise exception 'บัญชีจ่ายเงินต้องเป็นบัญชีเงินสด/เงินฝาก (11xx)' using errcode = 'ACC04'; end if;
  v_eid := acc.post_journal(p_company, p_date,
    'ชำระภาษีมูลค่าเพิ่ม ภ.พ.30 เดือน ' || to_char(c.month, 'MM') || '/' || (extract(year from c.month)::int + 543),
    jsonb_build_array(jsonb_build_object('account_code', '2220', 'debit', c.payable::text),
                      jsonb_build_object('account_code', v_cash.code, 'credit', c.payable::text)), p_idem, 'TX', null);
  update acc.vat_closings set paid_entry_id = v_eid where company_id = p_company and id = c.id;
  return v_eid;
end $$;

-- นำส่งภาษีหัก ณ ที่จ่าย ภ.ง.ด.3 / ภ.ง.ด.53 ของเดือน: ยอด = 50 ทวิ ที่ยังไม่ยกเลิกของเดือน/แบบนั้น · เดบิต 2230 เครดิตเงินสด (TX)
create function acc.remit_wht(p_company uuid, p_month date, p_form text, p_date date, p_cash text, p_idem text) returns uuid
language plpgsql security definer set search_path = acc, pg_temp as $$
declare
  v_id    uuid;
  v_start date := date_trunc('month', p_month)::date;
  v_amt   numeric; v_n int;
  v_cash  acc.chart_of_accounts;
  v_eid   uuid;
begin
  if not app.can_write_company(p_company) then
    raise exception 'ไม่มีสิทธิ์นำส่งภาษีในบริษัทนี้' using errcode = '42501';
  end if;
  select id into v_id from acc.wht_remittances where company_id = p_company and idem_key = p_idem;
  if found then return v_id; end if;
  if p_form not in ('pnd3', 'pnd53') then raise exception 'แบบต้องเป็น ภ.ง.ด.3 หรือ ภ.ง.ด.53' using errcode = '22023'; end if;
  perform 1 from acc.companies where id = p_company for update;
  if exists (select 1 from acc.wht_remittances where company_id = p_company and month = v_start and form = p_form) then
    raise exception 'นำส่ง % เดือนนี้ไปแล้ว', case p_form when 'pnd3' then 'ภ.ง.ด.3' else 'ภ.ง.ด.53' end using errcode = 'ACC17';
  end if;
  select coalesce(sum(amount), 0), count(*) into v_amt, v_n from acc.wht_certificates
   where company_id = p_company and form = p_form and voided_at is null and date_trunc('month', cert_date) = v_start;
  if v_n = 0 then raise exception 'เดือนนี้ไม่มีหนังสือรับรองหัก ณ ที่จ่ายแบบนี้' using errcode = '22023'; end if;
  if p_date is null or p_date <= (v_start + interval '1 month - 1 day')::date then
    raise exception 'วันที่นำส่งต้องหลังสิ้นเดือนที่หัก' using errcode = '22023';
  end if;
  perform acc.ensure_vat_accounts(p_company);
  select * into v_cash from acc.chart_of_accounts
   where company_id = p_company and code = coalesce(nullif(p_cash, ''), '1110') and active and type = 'asset' and code like '11%';
  if not found then raise exception 'บัญชีจ่ายเงินต้องเป็นบัญชีเงินสด/เงินฝาก (11xx)' using errcode = 'ACC04'; end if;
  v_eid := acc.post_journal(p_company, p_date,
    'นำส่ง ' || case p_form when 'pnd3' then 'ภ.ง.ด.3' else 'ภ.ง.ด.53' end || ' เดือน ' || to_char(v_start, 'MM') || '/' || (extract(year from v_start)::int + 543),
    jsonb_build_array(jsonb_build_object('account_code', '2230', 'debit', v_amt::text),
                      jsonb_build_object('account_code', v_cash.code, 'credit', v_amt::text)), p_idem, 'TX', null);
  insert into acc.wht_remittances (company_id, month, form, amount, cert_count, entry_id, idem_key, created_by)
  values (p_company, v_start, p_form, v_amt, v_n, v_eid, p_idem, app.current_user_id())
  returning id into v_id;
  return v_id;
end $$;

revoke all on function acc.ensure_vat_accounts(uuid), acc.close_vat_month(uuid, date, text), acc.void_vat_close(uuid, uuid, text, text),
  acc.pay_vat(uuid, uuid, date, text, text), acc.remit_wht(uuid, date, text, date, text, text) from public;
grant execute on function acc.close_vat_month(uuid, date, text), acc.void_vat_close(uuid, uuid, text, text),
  acc.pay_vat(uuid, uuid, date, text, text), acc.remit_wht(uuid, date, text, date, text, text) to app_rw;
grant execute on function acc.vat_report(uuid, date, text), acc.account_movement(uuid, text, date, date) to app_rw, app_ro;

-- migrate:down
drop function acc.remit_wht(uuid, date, text, date, text, text), acc.pay_vat(uuid, uuid, date, text, text),
  acc.void_vat_close(uuid, uuid, text, text), acc.close_vat_month(uuid, date, text), acc.ensure_vat_accounts(uuid),
  acc.account_movement(uuid, text, date, date), acc.vat_report(uuid, date, text);
drop trigger wht_certificates_remitted on acc.wht_certificates;
drop trigger journal_lines_vat_month on acc.journal_lines;
drop function acc.guard_wht_remitted(), acc.guard_vat_month();
drop table acc.wht_remittances, acc.vat_closings;
drop function acc.guard_vat_closing_update();
