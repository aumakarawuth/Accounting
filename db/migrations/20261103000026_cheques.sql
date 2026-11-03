-- migrate:up
-- เฟส 3.3 เช็ครับ / เช็คจ่าย (docs/phase3-spec.md ข้อ 3)
-- ทะเบียนเช็คแก้ไม่ได้ สถานะเดินด้วยเหตุการณ์ (cheque_events) ที่เพิ่มได้อย่างเดียว
-- ทุกเหตุการณ์ที่กระทบบัญชีลงผ่าน acc.post_journal / acc.reverse_journal (เลขที่ชุด CQ)
--
-- รับเช็ค   : เดบิต 1220 เช็ครับ (หรือ 1221 เช็ครับลงวันที่ล่วงหน้า) / เครดิต บัญชีคู่ (หรือออกใบเสร็จรับชำระลูกหนี้)
-- นำฝาก    : ไม่ลงบัญชี บันทึกบัญชีเงินฝากที่นำเข้า → สถานะรอเรียกเก็บ
-- เช็คผ่าน : เดบิต เงินฝาก / เครดิต บัญชีพักเช็ค
-- จ่ายเช็ค  : เดบิต บัญชีคู่ (หรือจ่ายชำระเจ้าหนี้) / เครดิต 2120 เช็คจ่าย (หรือ 2121 เช็คจ่ายลงวันที่ล่วงหน้า)
-- เช็คผ่าน : เดบิต บัญชีพักเช็ค / เครดิต เงินฝากที่สั่งจ่าย
-- เช็คคืน / ยกเลิก : กลับรายการตอนรับ/จ่ายเช็ค (ถ้าผูกใบเสร็จ/ใบสำคัญจ่าย = ยกเลิกเอกสารนั้น ยอดค้างกลับมา)

insert into acc.coa_template (code, name, type) values
  ('1221', 'เช็ครับลงวันที่ล่วงหน้า', 'asset'),
  ('2121', 'เช็คจ่ายลงวันที่ล่วงหน้า', 'liability')
on conflict (code) do update set name = excluded.name, type = excluded.type;
insert into acc.chart_of_accounts (company_id, code, name, type)
select c.id, t.code, t.name, t.type
  from acc.companies c cross join acc.coa_template t
 where t.code in ('1220', '1221', '2120', '2121') and not app.company_locked(c.id)
on conflict (company_id, code) do nothing;

create function acc.ensure_cheque_accounts(p_company uuid) returns void
language sql security definer set search_path = acc, pg_temp as $$
  insert into acc.chart_of_accounts (company_id, code, name, type)
  select p_company, t.code, t.name, t.type from acc.coa_template t
   where t.code in ('1220', '1221', '2120', '2121')
  on conflict (company_id, code) do nothing
$$;

create table acc.cheques (
  id                   uuid not null default gen_random_uuid(),
  company_id           uuid not null references acc.companies(id),
  direction            text not null check (direction in ('received', 'paid')),
  cheque_no            text not null check (cheque_no ~ '^[0-9A-Za-z-]{1,20}$'),
  bank_name            text not null check (length(btrim(bank_name)) between 1 and 100),
  bank_branch          text not null default '' check (length(bank_branch) <= 100),
  cheque_date          date not null,  -- วันที่หน้าเช็ค
  issue_date           date not null,  -- วันที่รับเช็ค / วันที่จ่ายเช็ค
  amount               numeric(18,2) not null check (amount > 0),
  party_name           text not null default '' check (length(party_name) <= 160),
  holding_account_id   uuid not null,  -- 1220 / 1221 / 2120 / 2121
  bank_account_id      uuid,           -- เช็คจ่าย: บัญชีเงินฝากที่สั่งจ่าย
  counter_account_id   uuid,           -- ลงทะเบียนเอง: บัญชีคู่
  document_id          uuid,           -- เช็ครับจากใบเสร็จรับชำระ
  purchase_document_id uuid,           -- เช็คจ่ายจากการจ่ายชำระ
  entry_id             uuid not null,  -- รายการตอนรับ/จ่ายเช็ค (CQ หรือ RE/PV ของเอกสาร)
  description          text not null default '' check (length(description) <= 300),
  idem_key             text not null,
  created_by           uuid not null references acc.users(id),
  created_at           timestamptz not null default now(),
  primary key (company_id, id),
  unique (company_id, idem_key),
  foreign key (company_id, holding_account_id) references acc.chart_of_accounts (company_id, id),
  foreign key (company_id, bank_account_id) references acc.chart_of_accounts (company_id, id),
  foreign key (company_id, counter_account_id) references acc.chart_of_accounts (company_id, id),
  foreign key (company_id, document_id) references acc.documents (company_id, id),
  foreign key (company_id, purchase_document_id) references acc.purchase_documents (company_id, id),
  foreign key (company_id, entry_id) references acc.journal_entries (company_id, id),
  check ((direction = 'paid') = (bank_account_id is not null)),
  check (document_id is null or direction = 'received'),
  check (purchase_document_id is null or direction = 'paid'),
  check (num_nonnulls(counter_account_id, document_id, purchase_document_id) = 1)
);
create index cheques_date on acc.cheques (company_id, cheque_date);
create unique index cheques_document on acc.cheques (company_id, document_id) where document_id is not null;
create unique index cheques_purchase_document on acc.cheques (company_id, purchase_document_id) where purchase_document_id is not null;

create table acc.cheque_events (
  id              bigint generated always as identity,
  company_id      uuid not null,
  cheque_id       uuid not null,
  kind            text not null check (kind in ('deposited', 'cleared', 'bounced', 'cancelled')),
  event_date      date not null,
  bank_account_id uuid,  -- นำฝาก: บัญชีเงินฝากที่นำเข้า
  entry_id        uuid,  -- ผ่าน/คืน/ยกเลิก: รายการบัญชีของเหตุการณ์
  note            text not null default '' check (length(note) <= 300),
  idem_key        text not null,
  created_by      uuid not null references acc.users(id),
  created_at      timestamptz not null default now(),
  primary key (company_id, id),
  unique (company_id, idem_key),
  unique (company_id, cheque_id, kind),
  foreign key (company_id, cheque_id) references acc.cheques (company_id, id),
  foreign key (company_id, bank_account_id) references acc.chart_of_accounts (company_id, id),
  foreign key (company_id, entry_id) references acc.journal_entries (company_id, id),
  check ((kind = 'deposited') = (bank_account_id is not null)),
  check ((kind = 'deposited') = (entry_id is null))
);

create trigger cheques_locked before insert on acc.cheques for each row execute function acc.guard_locked_company();
create trigger cheque_events_locked before insert on acc.cheque_events for each row execute function acc.guard_locked_company();
create trigger cheques_immutable before update or delete on acc.cheques for each row execute function acc.forbid_mutation();
create trigger cheque_events_immutable before update or delete on acc.cheque_events for each row execute function acc.forbid_mutation();
create trigger audit_cheques after insert on acc.cheques for each row execute function acc.audit_row();
create trigger audit_cheque_events after insert on acc.cheque_events for each row execute function acc.audit_row();

alter table acc.cheques enable row level security;
alter table acc.cheque_events enable row level security;
grant select on acc.cheques, acc.cheque_events to app_rw, app_ro;
create policy cheques_read on acc.cheques for select to app_rw, app_ro using (app.can_read_company(company_id));
create policy cheque_events_read on acc.cheque_events for select to app_rw, app_ro using (app.can_read_company(company_id));
-- เขียนได้ผ่านฟังก์ชันข้างล่างเท่านั้น (ไม่มีสิทธิ์ insert ตรง)

-- สถานะปัจจุบัน: เช็ครับ on_hand (รอนำฝาก) → deposited (รอเรียกเก็บ) → cleared / bounced · on_hand → cancelled
--                เช็คจ่าย issued (รอเรียกเก็บ) → cleared / bounced / cancelled
create function acc.cheque_status(p_company uuid, p_cheque uuid) returns text
language sql stable as $$
  select coalesce(
    (select e.kind from acc.cheque_events e where e.company_id = p_company and e.cheque_id = p_cheque
      order by case e.kind when 'deposited' then 0 else 1 end desc, e.id desc limit 1),
    (select case direction when 'received' then 'on_hand' else 'issued' end from acc.cheques where company_id = p_company and id = p_cheque))
$$;

-- ใบเสร็จรับชำระ / จ่ายชำระ รับบัญชีพักเช็คเป็น "บัญชีรับ/จ่ายเงิน" ได้ เฉพาะตอนเรียกจาก acc.register_cheque
-- (ตั้งค่า acc.cheque_account ในทรานแซกชัน) — แก้ฟังก์ชันเดิมทีละเงื่อนไขแทนการคัดลอกทั้งฟังก์ชัน
do $$
declare
  f text;
  src text;
  old_cond constant text := $c$and active and type = 'asset' and code like '11%';$c$;
  new_cond constant text := $c$and active and ((type = 'asset' and code like '11%') or code = nullif(current_setting('acc.cheque_account', true), ''));$c$;
begin
  foreach f in array array['acc.post_receipt(uuid,jsonb,text)', 'acc.post_payment(uuid,jsonb,text)'] loop
    src := pg_get_functiondef(f::regprocedure);
    if (length(src) - length(replace(src, old_cond, ''))) / length(old_cond) <> 1 then
      raise exception 'เงื่อนไขบัญชีรับ/จ่ายเงินใน % ไม่ตรงกับที่คาดไว้', f;
    end if;
    execute replace(src, old_cond, new_cond);
  end loop;
end $$;

-- ยกเลิกใบเสร็จ/ใบสำคัญจ่ายที่เป็นเช็คต้องทำผ่านทะเบียนเช็ค (เช็คคืน/ยกเลิกเช็ค) ไม่อย่างนั้นยอดบัญชีพักเช็คค้าง
create function acc.guard_cheque_document_void() returns trigger
language plpgsql as $$
declare
  v_no text;
begin
  if old.voided_at is null and new.voided_at is not null
     and coalesce(current_setting('acc.cheque_op', true), '') <> new.id::text then
    select cheque_no into v_no from acc.cheques
     where company_id = new.company_id
       and (case tg_table_name when 'documents' then document_id else purchase_document_id end) = new.id;
    if found then
      raise exception '% เป็นเช็คเลขที่ % ยกเลิกที่ทะเบียนเช็ค (เช็คคืน / ยกเลิกเช็ค)', new.doc_no, v_no using errcode = 'ACC16';
    end if;
  end if;
  return new;
end $$;
create trigger documents_cheque_void before update of voided_at on acc.documents
  for each row execute function acc.guard_cheque_document_void();
create trigger purchase_documents_cheque_void before update of voided_at on acc.purchase_documents
  for each row execute function acc.guard_cheque_document_void();

-- ---- รับ/จ่ายเช็ค ----
-- p: {direction, cheque_no, bank_name, bank_branch?, cheque_date, date, amount?, party_name?, description?,
--     bank_account? (เช็คจ่าย: 11xx ที่สั่งจ่าย),
--     counter_account? | receipt? {party_code, allocations, wht_amount?} | payment? {party_code, allocations, wht_kind?, wht_rate?}}
create function acc.register_cheque(p_company uuid, p jsonb, p_idem text) returns uuid
language plpgsql security definer set search_path = acc, pg_temp as $$
declare
  v_id      uuid;
  v_dir     text := p->>'direction';
  v_no      text := btrim(coalesce(p->>'cheque_no', ''));
  v_bank    text := btrim(coalesce(p->>'bank_name', ''));
  v_cdate   date;
  v_date    date;
  v_amt     numeric;
  v_party   text := btrim(coalesce(p->>'party_name', ''));
  v_desc    text := btrim(coalesce(p->>'description', ''));
  v_hold    acc.chart_of_accounts;
  v_bankacc acc.chart_of_accounts;
  v_counter acc.chart_of_accounts;
  v_doc     uuid;
  v_pdoc    uuid;
  v_eid     uuid;
  v_kind    text;
begin
  if not app.can_write_company(p_company) then
    raise exception 'ไม่มีสิทธิ์ทำรายการในบริษัทนี้' using errcode = '42501';
  end if;
  if p_idem is null or length(p_idem) < 8 then raise exception 'ต้องมี idempotency key' using errcode = 'ACC03'; end if;
  select id into v_id from acc.cheques where company_id = p_company and idem_key = p_idem;
  if found then return v_id; end if;
  perform acc.ensure_cheque_accounts(p_company);

  if v_dir is null or v_dir not in ('received', 'paid') then
    raise exception 'ต้องระบุว่าเป็นเช็ครับหรือเช็คจ่าย' using errcode = '22023';
  end if;
  if v_no !~ '^[0-9A-Za-z-]{1,20}$' then
    raise exception 'เลขที่เช็คเป็นตัวเลข/ตัวอักษร ไม่เกิน 20 ตัว' using errcode = '22023';
  end if;
  if length(v_bank) not between 1 and 100 then raise exception 'ต้องระบุธนาคาร' using errcode = '22023'; end if;
  begin
    v_cdate := nullif(p->>'cheque_date', '')::date;
    v_date := nullif(p->>'date', '')::date;
  exception when others then v_cdate := null; end;
  if v_cdate is null or v_date is null then
    raise exception 'ต้องมีวันที่หน้าเช็คและวันที่%', case v_dir when 'received' then 'รับเช็ค' else 'จ่ายเช็ค' end using errcode = '22023';
  end if;
  -- เช็คเดิม (ธนาคาร + เลขที่) ลงซ้ำได้เฉพาะเมื่อฉบับก่อนยกเลิกแล้ว
  if exists (select 1 from acc.cheques c where c.company_id = p_company and c.direction = v_dir and c.cheque_no = v_no
                and lower(c.bank_name) = lower(v_bank) and acc.cheque_status(c.company_id, c.id) <> 'cancelled') then
    raise exception 'เช็คเลขที่ % ธนาคาร % ลงทะเบียนไว้แล้ว', v_no, v_bank using errcode = 'ACC18';
  end if;

  select * into v_hold from acc.chart_of_accounts where company_id = p_company and code =
    case when v_dir = 'received' then case when v_cdate > v_date then '1221' else '1220' end
         else case when v_cdate > v_date then '2121' else '2120' end end;
  if not v_hold.active then
    raise exception 'บัญชี % % ปิดใช้อยู่ เปิดใช้ที่ผังบัญชีก่อน', v_hold.code, v_hold.name using errcode = 'ACC04';
  end if;
  if v_dir = 'paid' then
    select * into v_bankacc from acc.chart_of_accounts
     where company_id = p_company and code = p->>'bank_account' and active and type = 'asset' and code like '11%'
       and code not in ('1110', '1140');
    if not found then raise exception 'เช็คจ่ายต้องระบุบัญชีเงินฝากธนาคารที่สั่งจ่าย (11xx ที่ไม่ใช่เงินสด)' using errcode = 'ACC04'; end if;
  end if;

  perform set_config('acc.cheque_account', v_hold.code, true);
  if v_dir = 'received' and p ? 'receipt' then
    v_doc := acc.post_receipt(p_company, (p->'receipt') || jsonb_build_object('date', v_date, 'cash_account', v_hold.code,
                'description', nullif(v_desc, '')), p_idem);
    select d.total - d.wht_amount, d.entry_id, coalesce(nullif(v_party, ''), d.party_name) into v_amt, v_eid, v_party
      from acc.documents d where d.company_id = p_company and d.id = v_doc;
  elsif v_dir = 'paid' and p ? 'payment' then
    v_pdoc := acc.post_payment(p_company, (p->'payment') || jsonb_build_object('date', v_date, 'cash_account', v_hold.code,
                'description', nullif(v_desc, '')), p_idem);
    select d.total - d.wht_amount, d.entry_id, coalesce(nullif(v_party, ''), d.party_name) into v_amt, v_eid, v_party
      from acc.purchase_documents d where d.company_id = p_company and d.id = v_pdoc;
  else
    begin v_amt := (p->>'amount')::numeric; exception when others then v_amt := null; end;
    if v_amt is null or v_amt <= 0 or v_amt <> round(v_amt, 2) then
      raise exception 'จำนวนเงินต้องมากกว่า 0 ทศนิยมไม่เกิน 2 ตำแหน่ง' using errcode = 'ACC05';
    end if;
    select * into v_counter from acc.chart_of_accounts where company_id = p_company and code = p->>'counter_account' and active;
    if not found then
      raise exception 'ไม่พบบัญชีคู่รหัส %', coalesce(p->>'counter_account', '(ว่าง)') using errcode = 'ACC04';
    end if;
    if v_counter.code in ('1220', '1221', '2120', '2121') then
      raise exception 'บัญชีคู่ต้องไม่ใช่บัญชีพักเช็ค' using errcode = 'ACC04';
    end if;
    v_kind := case v_dir when 'received' then 'รับเช็ค' else 'จ่ายเช็ค' end;
    v_eid := acc.post_journal(p_company, v_date,
      coalesce(nullif(v_desc, ''), v_kind || ' ' || v_bank || ' เลขที่ ' || v_no || coalesce(' ' || nullif(v_party, ''), '')),
      case v_dir when 'received' then jsonb_build_array(
          jsonb_build_object('account_code', v_hold.code, 'debit', v_amt::text, 'memo', 'เช็คเลขที่ ' || v_no),
          jsonb_build_object('account_code', v_counter.code, 'credit', v_amt::text, 'memo', v_party))
        else jsonb_build_array(
          jsonb_build_object('account_code', v_counter.code, 'debit', v_amt::text, 'memo', v_party),
          jsonb_build_object('account_code', v_hold.code, 'credit', v_amt::text, 'memo', 'เช็คเลขที่ ' || v_no)) end,
      p_idem, 'CQ', null);
  end if;
  perform set_config('acc.cheque_account', '', true);
  if v_amt is null or v_amt <= 0 then
    raise exception 'ยอดเช็คต้องมากกว่า 0' using errcode = 'ACC05';
  end if;

  insert into acc.cheques (company_id, direction, cheque_no, bank_name, bank_branch, cheque_date, issue_date, amount, party_name,
      holding_account_id, bank_account_id, counter_account_id, document_id, purchase_document_id, entry_id, description, idem_key, created_by)
  values (p_company, v_dir, v_no, v_bank, btrim(coalesce(p->>'bank_branch', '')), v_cdate, v_date, v_amt, v_party,
      v_hold.id, v_bankacc.id, v_counter.id, v_doc, v_pdoc, v_eid, v_desc, p_idem, app.current_user_id())
  returning id into v_id;
  return v_id;
end $$;

-- ---- เปลี่ยนสถานะเช็ค: deposit (นำฝาก) / clear (ผ่าน) / bounce (คืน) / cancel (ยกเลิก) ----
create function acc.cheque_action(p_company uuid, p_cheque uuid, p_action text, p_date date,
                                  p_bank_account text, p_note text, p_idem text) returns bigint
language plpgsql security definer set search_path = acc, pg_temp as $$
declare
  q        acc.cheques;
  v_status text;
  v_ev     acc.cheque_events;
  v_dep    acc.cheque_events;
  v_bank   acc.chart_of_accounts;
  v_hold   text;
  v_bcode  text;
  v_eid    uuid;
  v_kind   text;
  v_note   text := btrim(coalesce(p_note, ''));
  v_label  text;
  v_id     bigint;
begin
  if not app.can_write_company(p_company) then
    raise exception 'ไม่มีสิทธิ์ทำรายการในบริษัทนี้' using errcode = '42501';
  end if;
  if p_idem is null or length(p_idem) < 8 then raise exception 'ต้องมี idempotency key' using errcode = 'ACC03'; end if;
  select * into q from acc.cheques where company_id = p_company and id = p_cheque for update;
  if not found then raise exception 'ไม่พบเช็ค' using errcode = 'ACC04'; end if;
  select * into v_ev from acc.cheque_events where company_id = p_company and idem_key = p_idem;
  if found then
    if v_ev.cheque_id <> p_cheque then raise exception 'idempotency key นี้ถูกใช้กับคำขออื่นแล้ว' using errcode = 'ACC03'; end if;
    return v_ev.id; -- คำขอซ้ำ
  end if;
  if p_date is null then raise exception 'ต้องมีวันที่' using errcode = '22023'; end if;
  v_status := acc.cheque_status(p_company, q.id);
  v_kind := case p_action when 'deposit' then 'deposited' when 'clear' then 'cleared' when 'bounce' then 'bounced'
                          when 'cancel' then 'cancelled' end;
  if v_kind is null then raise exception 'คำสั่งเช็คไม่ถูกต้อง' using errcode = '22023'; end if;
  v_label := 'เช็คเลขที่ ' || q.cheque_no;

  if not (q.direction = 'received' and ((v_kind = 'deposited' and v_status = 'on_hand') or (v_kind in ('cleared', 'bounced') and v_status = 'deposited')
            or (v_kind = 'cancelled' and v_status = 'on_hand'))
       or q.direction = 'paid' and v_status = 'issued' and v_kind <> 'deposited') then
    raise exception '% สถานะ % ทำรายการนี้ไม่ได้', v_label,
      case v_status when 'on_hand' then 'รอนำฝาก' when 'deposited' then 'รอเรียกเก็บ' when 'issued' then 'รอเรียกเก็บ'
                    when 'cleared' then 'ผ่านแล้ว' when 'bounced' then 'เช็คคืน' else 'ยกเลิกแล้ว' end
      using errcode = 'ACC18';
  end if;
  select * into v_dep from acc.cheque_events where company_id = p_company and cheque_id = q.id and kind = 'deposited';
  if p_date < coalesce(v_dep.event_date, q.issue_date) then
    raise exception 'วันที่ต้องไม่ก่อนวันที่%ของ% (%)', case when v_dep.id is null then case q.direction when 'received' then 'รับเช็ค' else 'จ่ายเช็ค' end else 'นำฝาก' end,
      v_label, to_char(coalesce(v_dep.event_date, q.issue_date), 'DD/MM/') || (extract(year from coalesce(v_dep.event_date, q.issue_date))::int + 543)
      using errcode = '22023';
  end if;
  if v_kind in ('deposited', 'cleared') and p_date < q.cheque_date then
    raise exception '% ลงวันที่ % %ก่อนวันที่หน้าเช็คไม่ได้', v_label,
      to_char(q.cheque_date, 'DD/MM/') || (extract(year from q.cheque_date)::int + 543),
      case v_kind when 'deposited' then 'นำฝาก' else 'เรียกเก็บ' end using errcode = 'ACC18';
  end if;

  if v_kind = 'deposited' then
    select * into v_bank from acc.chart_of_accounts
     where company_id = p_company and code = p_bank_account and active and type = 'asset' and code like '11%'
       and code not in ('1110', '1140');
    if not found then raise exception 'ต้องเลือกบัญชีเงินฝากธนาคารที่นำเช็คเข้า (11xx ที่ไม่ใช่เงินสด)' using errcode = 'ACC04'; end if;
  elsif v_kind = 'cleared' then
    select code into v_hold from acc.chart_of_accounts where company_id = p_company and id = q.holding_account_id;
    select code into v_bcode from acc.chart_of_accounts where company_id = p_company and id = coalesce(v_dep.bank_account_id, q.bank_account_id);
    v_eid := acc.post_journal(p_company, p_date, coalesce(nullif(v_note, ''), 'เช็คผ่าน ' || v_label || ' ' || q.bank_name),
      case q.direction when 'received' then jsonb_build_array(
          jsonb_build_object('account_code', v_bcode, 'debit', q.amount::text, 'memo', v_label),
          jsonb_build_object('account_code', v_hold, 'credit', q.amount::text, 'memo', q.party_name))
        else jsonb_build_array(
          jsonb_build_object('account_code', v_hold, 'debit', q.amount::text, 'memo', q.party_name),
          jsonb_build_object('account_code', v_bcode, 'credit', q.amount::text, 'memo', v_label)) end,
      p_idem, 'CQ', null);
  else
    -- เช็คคืน / ยกเลิก = กลับรายการตอนรับ/จ่ายเช็ค
    v_note := coalesce(nullif(v_note, ''), case v_kind when 'bounced' then 'เช็คคืน' else 'ยกเลิกเช็ค' end);
    perform set_config('acc.cheque_op', coalesce(q.document_id, q.purchase_document_id)::text, true);
    if q.document_id is not null then
      v_eid := acc.void_document(p_company, q.document_id, p_date, v_note || ' ' || v_label, p_idem);
    elsif q.purchase_document_id is not null then
      v_eid := acc.void_purchase_document(p_company, q.purchase_document_id, p_date, v_note || ' ' || v_label, p_idem);
    else
      v_eid := acc.reverse_journal(p_company, q.entry_id, p_date, p_idem, v_note || ' ' || v_label || ' ' || q.bank_name);
    end if;
    perform set_config('acc.cheque_op', '', true);
  end if;

  insert into acc.cheque_events (company_id, cheque_id, kind, event_date, bank_account_id, entry_id, note, idem_key, created_by)
  values (p_company, q.id, v_kind, p_date, v_bank.id, v_eid, v_note, p_idem, app.current_user_id())
  returning id into v_id;
  return v_id;
end $$;

-- ทะเบียนเช็ค (invoker: RLS ใช้กับผู้เรียก)
create function acc.cheque_register(p_company uuid)
returns table (id uuid, direction text, cheque_no text, bank_name text, bank_branch text, cheque_date date, issue_date date,
               amount numeric, party_name text, holding_code text, bank_code text, counter_code text, status text,
               status_date date, deposit_code text, document_id uuid, purchase_document_id uuid, doc_no text,
               entry_id uuid, entry_doc_no text, status_entry_id uuid, status_doc_no text, postdated boolean, description text)
language sql stable as $$
  select c.id, c.direction, c.cheque_no, c.bank_name, c.bank_branch, c.cheque_date, c.issue_date, c.amount, c.party_name,
         h.code, b.code, k.code, coalesce(st.kind, case c.direction when 'received' then 'on_hand' else 'issued' end),
         coalesce(st.event_date, c.issue_date), dep.code, c.document_id, c.purchase_document_id, coalesce(d.doc_no, pd.doc_no),
         c.entry_id, e.doc_no, st.entry_id, se.doc_no, c.cheque_date > c.issue_date, c.description
    from acc.cheques c
    join acc.chart_of_accounts h on h.company_id = c.company_id and h.id = c.holding_account_id
    join acc.journal_entries e on e.company_id = c.company_id and e.id = c.entry_id
    left join acc.chart_of_accounts b on b.company_id = c.company_id and b.id = c.bank_account_id
    left join acc.chart_of_accounts k on k.company_id = c.company_id and k.id = c.counter_account_id
    left join acc.documents d on d.company_id = c.company_id and d.id = c.document_id
    left join acc.purchase_documents pd on pd.company_id = c.company_id and pd.id = c.purchase_document_id
    left join lateral (select x.kind, x.event_date, x.entry_id from acc.cheque_events x
                        where x.company_id = c.company_id and x.cheque_id = c.id
                        order by case x.kind when 'deposited' then 0 else 1 end desc, x.id desc limit 1) st on true
    left join lateral (select a.code from acc.cheque_events x join acc.chart_of_accounts a on a.company_id = x.company_id and a.id = x.bank_account_id
                        where x.company_id = c.company_id and x.cheque_id = c.id and x.kind = 'deposited') dep on true
    left join acc.journal_entries se on se.company_id = c.company_id and se.id = st.entry_id
   where c.company_id = p_company
   order by c.cheque_date, c.created_at
$$;

revoke all on function acc.ensure_cheque_accounts(uuid), acc.register_cheque(uuid, jsonb, text),
  acc.cheque_action(uuid, uuid, text, date, text, text, text) from public;
grant execute on function acc.register_cheque(uuid, jsonb, text), acc.cheque_action(uuid, uuid, text, date, text, text, text) to app_rw;
grant execute on function acc.cheque_status(uuid, uuid), acc.cheque_register(uuid) to app_rw, app_ro;

-- migrate:down
drop function acc.cheque_register(uuid), acc.cheque_action(uuid, uuid, text, date, text, text, text),
  acc.register_cheque(uuid, jsonb, text);
drop trigger documents_cheque_void on acc.documents;
drop trigger purchase_documents_cheque_void on acc.purchase_documents;
drop function acc.guard_cheque_document_void();
do $$
declare f text; src text;
begin
  foreach f in array array['acc.post_receipt(uuid,jsonb,text)', 'acc.post_payment(uuid,jsonb,text)'] loop
    src := pg_get_functiondef(f::regprocedure);
    execute replace(src, $c$and active and ((type = 'asset' and code like '11%') or code = nullif(current_setting('acc.cheque_account', true), ''));$c$,
                         $c$and active and type = 'asset' and code like '11%';$c$);
  end loop;
end $$;
drop function acc.cheque_status(uuid, uuid);
drop table acc.cheque_events, acc.cheques;
drop function acc.ensure_cheque_accounts(uuid);
delete from acc.chart_of_accounts a where a.code in ('1221', '2121')
  and not exists (select 1 from acc.journal_lines l where l.company_id = a.company_id and l.account_id = a.id);
delete from acc.coa_template where code in ('1221', '2121');
