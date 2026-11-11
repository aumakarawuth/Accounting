-- migrate:up
-- เงินสดย่อย (ระบบวงเงินคงที่) + ฝาก/ถอน/โอนเงินระหว่างบัญชี (docs/phase5-spec.md ข้อ 9, docs/assumptions.md ข้อ 48)
-- โอนระหว่างบัญชี (BT): Dr บัญชีปลายทาง / Cr บัญชีต้นทาง (+ ค่าธรรมเนียม) ผ่าน acc.post_journal
-- เงินสดย่อย: ตั้ง/ปรับวงเงิน (PC) ลง 1140 · ใบสำคัญจ่ายเงินสดย่อย (PCV) ไม่ลงบัญชี · เบิกชดเชย (PC) ลงค่าใช้จ่ายตามใบ / Cr เงินสด/ธนาคาร

-- ---- โอนเงินระหว่างบัญชีเงินสด/เงินฝาก ----
create table acc.cash_transfers (
  id              uuid not null default gen_random_uuid(),
  company_id      uuid not null references acc.companies(id),
  doc_date        date not null,
  from_account_id uuid not null,
  to_account_id   uuid not null,
  amount          numeric(18,2) not null check (amount > 0),
  fee             numeric(18,2) not null default 0 check (fee >= 0),
  fee_account_id  uuid,
  description     text not null default '' check (length(description) <= 300),
  entry_id        uuid not null,
  idem_key        text not null,
  voided_at       timestamptz,
  void_entry_id   uuid,
  void_reason     text check (length(void_reason) <= 300),
  created_by      uuid not null references acc.users(id),
  created_at      timestamptz not null default now(),
  primary key (company_id, id),
  unique (company_id, idem_key),
  foreign key (company_id, from_account_id) references acc.chart_of_accounts (company_id, id),
  foreign key (company_id, to_account_id) references acc.chart_of_accounts (company_id, id),
  foreign key (company_id, fee_account_id) references acc.chart_of_accounts (company_id, id),
  foreign key (company_id, entry_id) references acc.journal_entries (company_id, id),
  foreign key (company_id, void_entry_id) references acc.journal_entries (company_id, id),
  check (from_account_id <> to_account_id),
  check ((fee > 0) = (fee_account_id is not null)),
  check ((voided_at is null) = (void_entry_id is null))
);
create trigger cash_transfers_guard before update on acc.cash_transfers for each row execute function acc.guard_void_only();
create trigger cash_transfers_no_delete before delete on acc.cash_transfers for each row execute function acc.forbid_mutation();
create trigger cash_transfers_locked before insert or update on acc.cash_transfers for each row execute function acc.guard_locked_company();
create trigger audit_cash_transfers after insert or update on acc.cash_transfers for each row execute function acc.audit_row();
alter table acc.cash_transfers enable row level security;
grant select on acc.cash_transfers to app_rw, app_ro;
create policy cash_transfers_read on acc.cash_transfers for select to app_rw, app_ro using (company_id in (select app.readable_company_ids()));

-- p: {date, from, to, amount, fee?, fee_account?, description?}
create function acc.post_cash_transfer(p_company uuid, p jsonb, p_idem text) returns uuid
language plpgsql security definer set search_path = acc, pg_temp as $$
declare
  v_id uuid; v_date date; v_amt numeric; v_fee numeric; af acc.chart_of_accounts; at acc.chart_of_accounts; ax acc.chart_of_accounts;
  v_je jsonb; v_eid uuid; v_desc text;
begin
  if not app.can_write_company(p_company) then raise exception 'ไม่มีสิทธิ์บันทึกเอกสารในบริษัทนี้' using errcode = '42501'; end if;
  select id into v_id from acc.cash_transfers where company_id = p_company and idem_key = p_idem;
  if found then return v_id; end if;
  begin
    v_date := (p->>'date')::date; v_amt := (p->>'amount')::numeric; v_fee := coalesce(nullif(p->>'fee', '')::numeric, 0);
  exception when others then raise exception 'วันที่หรือจำนวนเงินไม่ถูกต้อง' using errcode = '22023';
  end;
  if v_date is null then raise exception 'ต้องมีวันที่เอกสาร' using errcode = '22023'; end if;
  if v_amt is null or v_amt <= 0 or v_amt <> round(v_amt, 2) or v_fee < 0 or v_fee <> round(v_fee, 2) then
    raise exception 'จำนวนเงินต้องมากกว่า 0 ค่าธรรมเนียมไม่ติดลบ ทศนิยมไม่เกิน 2 ตำแหน่ง' using errcode = 'ACC05';
  end if;
  select * into af from acc.chart_of_accounts where company_id = p_company and code = p->>'from' and active and type = 'asset' and code like '11%';
  select * into at from acc.chart_of_accounts where company_id = p_company and code = p->>'to' and active and type = 'asset' and code like '11%';
  if af.id is null or at.id is null then
    raise exception 'บัญชีต้นทางและปลายทางต้องเป็นบัญชีเงินสด/เงินฝาก (11xx) ที่เปิดใช้' using errcode = 'ACC04';
  end if;
  if af.id = at.id then raise exception 'บัญชีต้นทางและปลายทางต้องต่างกัน' using errcode = '22023'; end if;
  if af.code = '1140' or at.code = '1140' then
    raise exception 'เงินสดย่อยตั้ง/ปรับวงเงินที่หน้าเงินสดย่อย' using errcode = 'ACC15';
  end if;
  if v_fee > 0 then
    select * into ax from acc.chart_of_accounts where company_id = p_company and code = coalesce(nullif(p->>'fee_account', ''), '5260') and active and type = 'expense';
    if not found then raise exception 'บัญชีค่าธรรมเนียมต้องเป็นบัญชีค่าใช้จ่ายที่เปิดใช้' using errcode = 'ACC04'; end if;
  end if;
  v_desc := coalesce(nullif(btrim(p->>'description'), ''),
    case when af.code = '1110' then 'ฝากเงิน ' || at.name when at.code = '1110' then 'ถอนเงิน ' || af.name
         else 'โอนเงินจาก ' || af.name || ' เข้า ' || at.name end);
  v_je := jsonb_build_array(jsonb_build_object('account_code', at.code, 'debit', v_amt::text));
  if v_fee > 0 then v_je := v_je || jsonb_build_object('account_code', ax.code, 'debit', v_fee::text, 'memo', 'ค่าธรรมเนียมโอน'); end if;
  v_je := v_je || jsonb_build_object('account_code', af.code, 'credit', (v_amt + v_fee)::text);
  v_eid := acc.post_journal(p_company, v_date, left(v_desc, 300), v_je, p_idem, 'BT', null);
  select id into v_id from acc.cash_transfers where company_id = p_company and entry_id = v_eid;
  if found then return v_id; end if;
  insert into acc.cash_transfers (company_id, doc_date, from_account_id, to_account_id, amount, fee, fee_account_id, description, entry_id,
      idem_key, created_by)
  values (p_company, v_date, af.id, at.id, v_amt, v_fee, ax.id, coalesce(btrim(p->>'description'), ''), v_eid, p_idem, app.current_user_id())
  returning id into v_id;
  return v_id;
end $$;

create function acc.void_cash_transfer(p_company uuid, p_id uuid, p_date date, p_reason text, p_idem text) returns uuid
language plpgsql security definer set search_path = acc, pg_temp as $$
declare t acc.cash_transfers; v_rv uuid; v_no text;
begin
  if not app.can_write_company(p_company) then raise exception 'ไม่มีสิทธิ์' using errcode = '42501'; end if;
  select * into t from acc.cash_transfers where company_id = p_company and id = p_id for update;
  if not found then raise exception 'ไม่พบเอกสาร' using errcode = 'ACC04'; end if;
  select doc_no into v_no from acc.journal_entries where company_id = p_company and id = t.entry_id;
  if t.voided_at is not null then
    if exists (select 1 from acc.idempotency_keys where company_id = p_company and key = p_idem and entry_id = t.void_entry_id) then return t.void_entry_id; end if;
    raise exception '% ยกเลิกไปแล้ว', v_no using errcode = 'ACC16';
  end if;
  if length(btrim(coalesce(p_reason, ''))) = 0 then raise exception 'ต้องระบุเหตุผลที่ยกเลิก' using errcode = '22023'; end if;
  v_rv := acc.reverse_journal(p_company, t.entry_id, p_date, p_idem, 'ยกเลิก ' || v_no || ': ' || btrim(p_reason));
  update acc.cash_transfers set voided_at = now(), void_entry_id = v_rv, void_reason = btrim(p_reason) where company_id = p_company and id = t.id;
  return v_rv;
end $$;

-- ---- เงินสดย่อย ----
-- ใบสำคัญจ่ายเงินสดย่อย: ไม่ลงบัญชี (ค่าใช้จ่ายลงตอนเบิกชดเชย) · ยกเลิกได้ถ้ายังไม่เบิกชดเชย
create table acc.petty_cash_vouchers (
  id            uuid not null default gen_random_uuid(),
  company_id    uuid not null references acc.companies(id),
  doc_no        text not null,
  doc_date      date not null,
  payee         text not null check (length(btrim(payee)) between 1 and 160),
  description   text not null check (length(btrim(description)) between 1 and 200),
  account_id    uuid not null,
  amount        numeric(18,2) not null check (amount > 0),
  receipt_no    text check (length(receipt_no) <= 40),
  idem_key      text not null,
  created_by    uuid not null references acc.users(id),
  created_at    timestamptz not null default now(),
  cancelled_at  timestamptz,
  cancel_reason text check (length(cancel_reason) <= 300),
  primary key (company_id, id),
  unique (company_id, doc_no),
  unique (company_id, idem_key),
  foreign key (company_id, account_id) references acc.chart_of_accounts (company_id, id),
  check ((cancelled_at is null) = (cancel_reason is null))
);
-- เบิกชดเชย: ใบสำคัญที่รวมในการเบิกครั้งที่ยังไม่ยกเลิก = เบิกแล้ว
create table acc.petty_cash_reimbursements (
  id              uuid not null default gen_random_uuid(),
  company_id      uuid not null references acc.companies(id),
  doc_date        date not null,
  cash_account_id uuid not null,
  total           numeric(18,2) not null check (total > 0),
  entry_id        uuid not null,
  idem_key        text not null,
  voided_at       timestamptz,
  void_entry_id   uuid,
  void_reason     text check (length(void_reason) <= 300),
  created_by      uuid not null references acc.users(id),
  created_at      timestamptz not null default now(),
  primary key (company_id, id),
  unique (company_id, idem_key),
  foreign key (company_id, cash_account_id) references acc.chart_of_accounts (company_id, id),
  foreign key (company_id, entry_id) references acc.journal_entries (company_id, id),
  foreign key (company_id, void_entry_id) references acc.journal_entries (company_id, id),
  check ((voided_at is null) = (void_entry_id is null))
);
create table acc.petty_cash_reimbursement_items (
  company_id       uuid not null,
  reimbursement_id uuid not null,
  voucher_id       uuid not null,
  primary key (company_id, reimbursement_id, voucher_id),
  foreign key (company_id, reimbursement_id) references acc.petty_cash_reimbursements (company_id, id),
  foreign key (company_id, voucher_id) references acc.petty_cash_vouchers (company_id, id)
);
create index petty_cash_items_voucher on acc.petty_cash_reimbursement_items (company_id, voucher_id);
-- ตั้ง/ปรับวงเงิน: ประวัติวงเงิน (ยอด 1140 หลังรายการ)
create table acc.petty_cash_funds (
  id              uuid not null default gen_random_uuid(),
  company_id      uuid not null references acc.companies(id),
  doc_date        date not null,
  fund            numeric(18,2) not null check (fund >= 0),
  change          numeric(18,2) not null check (change <> 0),
  cash_account_id uuid not null,
  custodian       text not null check (length(btrim(custodian)) between 1 and 160),
  entry_id        uuid not null,
  idem_key        text not null,
  created_by      uuid not null references acc.users(id),
  created_at      timestamptz not null default now(),
  primary key (company_id, id),
  unique (company_id, idem_key),
  foreign key (company_id, cash_account_id) references acc.chart_of_accounts (company_id, id),
  foreign key (company_id, entry_id) references acc.journal_entries (company_id, id)
);

create trigger petty_cash_vouchers_guard before update or delete on acc.petty_cash_vouchers for each row execute function acc.guard_cancel_only();
create trigger petty_cash_reimbursements_guard before update on acc.petty_cash_reimbursements for each row execute function acc.guard_void_only();
create trigger petty_cash_reimbursements_no_delete before delete on acc.petty_cash_reimbursements for each row execute function acc.forbid_mutation();
create trigger petty_cash_items_immutable before update or delete on acc.petty_cash_reimbursement_items for each row execute function acc.forbid_mutation();
create trigger petty_cash_funds_immutable before update or delete on acc.petty_cash_funds for each row execute function acc.forbid_mutation();
create trigger petty_cash_vouchers_locked before insert or update on acc.petty_cash_vouchers for each row execute function acc.guard_locked_company();
create trigger petty_cash_reimbursements_locked before insert or update on acc.petty_cash_reimbursements for each row execute function acc.guard_locked_company();
create trigger petty_cash_funds_locked before insert on acc.petty_cash_funds for each row execute function acc.guard_locked_company();
create trigger audit_petty_cash_vouchers after insert or update on acc.petty_cash_vouchers for each row execute function acc.audit_row();
create trigger audit_petty_cash_reimbursements after insert or update on acc.petty_cash_reimbursements for each row execute function acc.audit_row();
create trigger audit_petty_cash_funds after insert on acc.petty_cash_funds for each row execute function acc.audit_row();
alter table acc.petty_cash_vouchers enable row level security;
alter table acc.petty_cash_reimbursements enable row level security;
alter table acc.petty_cash_reimbursement_items enable row level security;
alter table acc.petty_cash_funds enable row level security;
grant select on acc.petty_cash_vouchers, acc.petty_cash_reimbursements, acc.petty_cash_reimbursement_items, acc.petty_cash_funds to app_rw, app_ro;
create policy petty_cash_vouchers_read on acc.petty_cash_vouchers for select to app_rw, app_ro using (company_id in (select app.readable_company_ids()));
create policy petty_cash_reimbursements_read on acc.petty_cash_reimbursements for select to app_rw, app_ro using (company_id in (select app.readable_company_ids()));
create policy petty_cash_items_read on acc.petty_cash_reimbursement_items for select to app_rw, app_ro using (company_id in (select app.readable_company_ids()));
create policy petty_cash_funds_read on acc.petty_cash_funds for select to app_rw, app_ro using (company_id in (select app.readable_company_ids()));

-- ใบสำคัญที่ยังไม่เบิกชดเชย (ไม่ยกเลิก ไม่อยู่ในการเบิกที่ยังไม่ยกเลิก)
create function acc.petty_cash_unreimbursed(p_company uuid, p_voucher uuid) returns boolean
language sql stable set search_path = acc, pg_temp as $$
  select not exists (select 1 from acc.petty_cash_reimbursement_items i
                       join acc.petty_cash_reimbursements r on r.company_id = i.company_id and r.id = i.reimbursement_id
                      where i.company_id = p_company and i.voucher_id = p_voucher and r.voided_at is null)
$$;
-- ยอดเงินสดย่อย: วงเงิน = ยอดบัญชี 1140 · เงินในมือ = วงเงิน − ใบสำคัญที่ยังไม่เบิกชดเชย
create function acc.petty_cash_status(p_company uuid, out fund numeric, out pending numeric, out on_hand numeric)
language sql stable set search_path = acc, pg_temp as $$
  select f.v::numeric(18,2), p.v::numeric(18,2), (f.v - p.v)::numeric(18,2)
    from (select coalesce(sum(l.debit - l.credit), 0) v from acc.journal_lines l join acc.chart_of_accounts a on a.company_id = l.company_id and a.id = l.account_id
           where l.company_id = p_company and a.code = '1140') f,
         (select coalesce(sum(v.amount), 0) v from acc.petty_cash_vouchers v
           where v.company_id = p_company and v.cancelled_at is null and acc.petty_cash_unreimbursed(p_company, v.id)) p
$$;

-- ตั้ง/ปรับวงเงิน: ปรับยอด 1140 ให้เท่าวงเงินใหม่ คู่กับเงินสด/ธนาคาร · ลดวงเงินได้ไม่ต่ำกว่าใบสำคัญที่ยังไม่เบิก
-- p: {date, fund, cash_account, custodian}
create function acc.set_petty_cash_fund(p_company uuid, p jsonb, p_idem text) returns uuid
language plpgsql security definer set search_path = acc, pg_temp as $$
declare
  v_id uuid; v_date date; v_fund numeric; v_cash acc.chart_of_accounts; st record; v_diff numeric; v_je jsonb; v_eid uuid;
begin
  if not app.can_write_company(p_company) then raise exception 'ไม่มีสิทธิ์บันทึกเอกสารในบริษัทนี้' using errcode = '42501'; end if;
  select id into v_id from acc.petty_cash_funds where company_id = p_company and idem_key = p_idem;
  if found then return v_id; end if;
  perform pg_advisory_xact_lock(hashtextextended('petty-cash:' || p_company::text, 0));
  begin v_date := (p->>'date')::date; v_fund := (p->>'fund')::numeric;
  exception when others then raise exception 'วันที่หรือวงเงินไม่ถูกต้อง' using errcode = '22023';
  end;
  if v_date is null or v_fund is null or v_fund < 0 or v_fund <> round(v_fund, 2) then
    raise exception 'ต้องมีวันที่ และวงเงินไม่ติดลบ ทศนิยมไม่เกิน 2 ตำแหน่ง' using errcode = 'ACC05';
  end if;
  if length(btrim(coalesce(p->>'custodian', ''))) = 0 then raise exception 'ต้องระบุผู้รักษาเงินสดย่อย' using errcode = '22023'; end if;
  select * into v_cash from acc.chart_of_accounts
   where company_id = p_company and code = coalesce(nullif(p->>'cash_account', ''), '1110') and active and type = 'asset' and code like '11%' and code <> '1140';
  if not found then raise exception 'จ่าย/รับคืนวงเงินจากบัญชีเงินสด/เงินฝาก (11xx ที่ไม่ใช่เงินสดย่อย)' using errcode = 'ACC04'; end if;
  select * into st from acc.petty_cash_status(p_company);
  v_diff := v_fund - st.fund;
  if v_diff = 0 then raise exception 'วงเงินเท่าเดิม ไม่ต้องปรับ' using errcode = 'ACC15'; end if;
  if v_fund < st.pending then
    raise exception 'มีใบสำคัญจ่ายเงินสดย่อยที่ยังไม่เบิกชดเชย % ลดวงเงินต่ำกว่านั้นไม่ได้ เบิกชดเชยก่อน',
      to_char(st.pending, 'FM999,999,999,990.00') using errcode = 'ACC15';
  end if;
  v_je := case when v_diff > 0
    then jsonb_build_array(jsonb_build_object('account_code', '1140', 'debit', v_diff::text), jsonb_build_object('account_code', v_cash.code, 'credit', v_diff::text))
    else jsonb_build_array(jsonb_build_object('account_code', v_cash.code, 'debit', (-v_diff)::text), jsonb_build_object('account_code', '1140', 'credit', (-v_diff)::text)) end;
  v_eid := acc.post_journal(p_company, v_date,
    case when st.fund = 0 then 'ตั้งวงเงินสดย่อย ' else 'ปรับวงเงินสดย่อย ' end || to_char(v_fund, 'FM999,999,999,990.00') || ' ผู้รักษา ' || btrim(p->>'custodian'),
    v_je, p_idem, 'PC', null);
  insert into acc.petty_cash_funds (company_id, doc_date, fund, change, cash_account_id, custodian, entry_id, idem_key, created_by)
  values (p_company, v_date, v_fund, v_diff, v_cash.id, btrim(p->>'custodian'), v_eid, p_idem, app.current_user_id())
  returning id into v_id;
  return v_id;
end $$;

-- p: {date, payee, description, account, amount, receipt_no?}
create function acc.post_petty_cash_voucher(p_company uuid, p jsonb, p_idem text) returns uuid
language plpgsql security definer set search_path = acc, pg_temp as $$
declare v_id uuid; v_date date; v_amt numeric; v_acc acc.chart_of_accounts; st record;
begin
  if not app.can_write_company(p_company) then raise exception 'ไม่มีสิทธิ์บันทึกเอกสารในบริษัทนี้' using errcode = '42501'; end if;
  if p_idem is null or length(p_idem) < 8 then raise exception 'ต้องมี idempotency key' using errcode = 'ACC03'; end if;
  perform pg_advisory_xact_lock(hashtextextended('petty-cash:' || p_company::text, 0));
  select id into v_id from acc.petty_cash_vouchers where company_id = p_company and idem_key = p_idem;
  if found then return v_id; end if;
  begin v_date := (p->>'date')::date; v_amt := (p->>'amount')::numeric;
  exception when others then raise exception 'วันที่หรือจำนวนเงินไม่ถูกต้อง' using errcode = '22023';
  end;
  if v_date is null or v_amt is null or v_amt <= 0 or v_amt <> round(v_amt, 2) then
    raise exception 'ต้องมีวันที่ และจำนวนเงินมากกว่า 0 ทศนิยมไม่เกิน 2 ตำแหน่ง' using errcode = 'ACC05';
  end if;
  if exists (select 1 from acc.periods where company_id = p_company and v_date between start_date and end_date and closed) then
    raise exception 'งวด % ปิดแล้ว ลงรายการไม่ได้', to_char(v_date, 'YYYY-MM') using errcode = 'ACC02';
  end if;
  if length(btrim(coalesce(p->>'payee', ''))) = 0 or length(btrim(coalesce(p->>'description', ''))) = 0 then
    raise exception 'ต้องระบุผู้รับเงินและรายการ' using errcode = '22023';
  end if;
  select * into v_acc from acc.chart_of_accounts where company_id = p_company and code = p->>'account' and active and type = 'expense';
  if not found then raise exception 'บัญชีต้องเป็นบัญชีค่าใช้จ่ายที่เปิดใช้' using errcode = 'ACC04'; end if;
  select * into st from acc.petty_cash_status(p_company);
  if v_amt > st.on_hand then
    raise exception 'เงินสดย่อยคงเหลือ % ไม่พอจ่าย % เบิกชดเชยก่อน', to_char(st.on_hand, 'FM999,999,999,990.00'),
      to_char(v_amt, 'FM999,999,999,990.00') using errcode = 'ACC15';
  end if;
  insert into acc.petty_cash_vouchers (company_id, doc_no, doc_date, payee, description, account_id, amount, receipt_no, idem_key, created_by)
  values (p_company, acc.next_doc_no(p_company, 'PCV'), v_date, btrim(p->>'payee'), btrim(p->>'description'), v_acc.id, v_amt,
          nullif(btrim(coalesce(p->>'receipt_no', '')), ''), p_idem, app.current_user_id())
  returning id into v_id;
  return v_id;
end $$;

create function acc.cancel_petty_cash_voucher(p_company uuid, p_voucher uuid, p_reason text) returns void
language plpgsql security definer set search_path = acc, pg_temp as $$
declare v acc.petty_cash_vouchers;
begin
  if not app.can_write_company(p_company) then raise exception 'ไม่มีสิทธิ์' using errcode = '42501'; end if;
  select * into v from acc.petty_cash_vouchers where company_id = p_company and id = p_voucher for update;
  if not found then raise exception 'ไม่พบเอกสาร' using errcode = 'ACC04'; end if;
  if v.cancelled_at is not null then return; end if;
  if length(btrim(coalesce(p_reason, ''))) = 0 then raise exception 'ต้องระบุเหตุผลที่ยกเลิก' using errcode = '22023'; end if;
  if not acc.petty_cash_unreimbursed(p_company, v.id) then
    raise exception '% เบิกชดเชยแล้ว ยกเลิกการเบิกชดเชยก่อน', v.doc_no using errcode = 'ACC16';
  end if;
  update acc.petty_cash_vouchers set cancelled_at = now(), cancel_reason = btrim(p_reason) where company_id = p_company and id = v.id;
end $$;

-- เบิกชดเชย: Dr ค่าใช้จ่ายตามใบสำคัญ (รวมตามบัญชี) / Cr เงินสด/ธนาคาร · วงเงิน 1140 ไม่เปลี่ยน
-- p: {date, cash_account, voucher_ids: [...]}
create function acc.post_petty_cash_reimbursement(p_company uuid, p jsonb, p_idem text) returns uuid
language plpgsql security definer set search_path = acc, pg_temp as $$
declare
  v_id uuid; v_date date; v_cash acc.chart_of_accounts; v_total numeric := 0; v_je jsonb; v_eid uuid; pv acc.petty_cash_vouchers; v_ids uuid[];
begin
  if not app.can_write_company(p_company) then raise exception 'ไม่มีสิทธิ์บันทึกเอกสารในบริษัทนี้' using errcode = '42501'; end if;
  select id into v_id from acc.petty_cash_reimbursements where company_id = p_company and idem_key = p_idem;
  if found then return v_id; end if;
  perform pg_advisory_xact_lock(hashtextextended('petty-cash:' || p_company::text, 0));
  begin v_date := (p->>'date')::date; exception when others then v_date := null; end;
  if v_date is null then raise exception 'ต้องมีวันที่เอกสาร' using errcode = '22023'; end if;
  select * into v_cash from acc.chart_of_accounts
   where company_id = p_company and code = coalesce(nullif(p->>'cash_account', ''), '1110') and active and type = 'asset' and code like '11%' and code <> '1140';
  if not found then raise exception 'เบิกชดเชยจากบัญชีเงินสด/เงินฝาก (11xx ที่ไม่ใช่เงินสดย่อย)' using errcode = 'ACC04'; end if;
  select array_agg(distinct x::uuid) into v_ids from jsonb_array_elements_text(coalesce(p->'voucher_ids', '[]')) x;
  if coalesce(array_length(v_ids, 1), 0) = 0 then raise exception 'เลือกใบสำคัญที่จะเบิกชดเชยอย่างน้อย 1 ใบ' using errcode = '22023'; end if;
  for pv in select * from acc.petty_cash_vouchers where company_id = p_company and id = any (v_ids) order by doc_no for update loop
    if pv.cancelled_at is not null or not acc.petty_cash_unreimbursed(p_company, pv.id) then
      raise exception '% ยกเลิกแล้วหรือเบิกชดเชยไปแล้ว', pv.doc_no using errcode = 'ACC15';
    end if;
    if pv.doc_date > v_date then raise exception '% ลงวันที่หลังวันเบิกชดเชย', pv.doc_no using errcode = '22023'; end if;
    v_total := v_total + pv.amount;
  end loop;
  if (select count(*) from acc.petty_cash_vouchers where company_id = p_company and id = any (v_ids)) <> array_length(v_ids, 1) then
    raise exception 'ไม่พบใบสำคัญบางใบ' using errcode = 'ACC04';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('account_code', x.code, 'debit', x.amt::text) order by x.code), '[]') into v_je
    from (select a.code, sum(v.amount) amt from acc.petty_cash_vouchers v join acc.chart_of_accounts a on a.company_id = v.company_id and a.id = v.account_id
           where v.company_id = p_company and v.id = any (v_ids) group by a.code) x;
  v_je := v_je || jsonb_build_object('account_code', v_cash.code, 'credit', v_total::text);
  v_eid := acc.post_journal(p_company, v_date, 'เบิกชดเชยเงินสดย่อย ' ||
    (select string_agg(doc_no, ', ' order by doc_no) from acc.petty_cash_vouchers where company_id = p_company and id = any (v_ids)), v_je, p_idem, 'PC', null);
  insert into acc.petty_cash_reimbursements (company_id, doc_date, cash_account_id, total, entry_id, idem_key, created_by)
  values (p_company, v_date, v_cash.id, v_total, v_eid, p_idem, app.current_user_id()) returning id into v_id;
  insert into acc.petty_cash_reimbursement_items (company_id, reimbursement_id, voucher_id) select p_company, v_id, unnest(v_ids);
  return v_id;
end $$;

create function acc.void_petty_cash_reimbursement(p_company uuid, p_id uuid, p_date date, p_reason text, p_idem text) returns uuid
language plpgsql security definer set search_path = acc, pg_temp as $$
declare r acc.petty_cash_reimbursements; v_rv uuid; v_no text;
begin
  if not app.can_write_company(p_company) then raise exception 'ไม่มีสิทธิ์' using errcode = '42501'; end if;
  select * into r from acc.petty_cash_reimbursements where company_id = p_company and id = p_id for update;
  if not found then raise exception 'ไม่พบเอกสาร' using errcode = 'ACC04'; end if;
  select doc_no into v_no from acc.journal_entries where company_id = p_company and id = r.entry_id;
  if r.voided_at is not null then
    if exists (select 1 from acc.idempotency_keys where company_id = p_company and key = p_idem and entry_id = r.void_entry_id) then return r.void_entry_id; end if;
    raise exception '% ยกเลิกไปแล้ว', v_no using errcode = 'ACC16';
  end if;
  if length(btrim(coalesce(p_reason, ''))) = 0 then raise exception 'ต้องระบุเหตุผลที่ยกเลิก' using errcode = '22023'; end if;
  v_rv := acc.reverse_journal(p_company, r.entry_id, p_date, p_idem, 'ยกเลิก ' || v_no || ': ' || btrim(p_reason));
  update acc.petty_cash_reimbursements set voided_at = now(), void_entry_id = v_rv, void_reason = btrim(p_reason) where company_id = p_company and id = r.id;
  return v_rv;
end $$;

revoke all on function acc.post_cash_transfer(uuid, jsonb, text), acc.void_cash_transfer(uuid, uuid, date, text, text),
  acc.set_petty_cash_fund(uuid, jsonb, text), acc.post_petty_cash_voucher(uuid, jsonb, text), acc.cancel_petty_cash_voucher(uuid, uuid, text),
  acc.post_petty_cash_reimbursement(uuid, jsonb, text), acc.void_petty_cash_reimbursement(uuid, uuid, date, text, text) from public;
grant execute on function acc.post_cash_transfer(uuid, jsonb, text), acc.void_cash_transfer(uuid, uuid, date, text, text),
  acc.set_petty_cash_fund(uuid, jsonb, text), acc.post_petty_cash_voucher(uuid, jsonb, text), acc.cancel_petty_cash_voucher(uuid, uuid, text),
  acc.post_petty_cash_reimbursement(uuid, jsonb, text), acc.void_petty_cash_reimbursement(uuid, uuid, date, text, text) to app_rw;
grant execute on function acc.petty_cash_status(uuid), acc.petty_cash_unreimbursed(uuid, uuid) to app_rw, app_ro;

-- migrate:down
drop function acc.void_petty_cash_reimbursement(uuid, uuid, date, text, text), acc.post_petty_cash_reimbursement(uuid, jsonb, text),
  acc.cancel_petty_cash_voucher(uuid, uuid, text), acc.post_petty_cash_voucher(uuid, jsonb, text), acc.set_petty_cash_fund(uuid, jsonb, text),
  acc.petty_cash_status(uuid), acc.petty_cash_unreimbursed(uuid, uuid), acc.void_cash_transfer(uuid, uuid, date, text, text),
  acc.post_cash_transfer(uuid, jsonb, text);
drop table acc.petty_cash_funds, acc.petty_cash_reimbursement_items, acc.petty_cash_reimbursements, acc.petty_cash_vouchers, acc.cash_transfers;
