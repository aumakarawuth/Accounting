-- migrate:up
-- เอกสารขาย: ใบเสนอราคา → ใบสั่งขาย → ขายเชื่อ → ใบวางบิล · รับเงินมัดจำ และหักมัดจำตอนขาย
-- (docs/phase5-spec.md ข้อ 4, docs/assumptions.md ข้อ 43)
-- ใบเสนอราคา/ใบสั่งขาย/ใบวางบิลไม่ลงบัญชี · มัดจำ (DP) และหักมัดจำ (DA) ลงผ่าน acc.post_journal

insert into acc.coa_template (code, name, type) values ('2420', 'เงินมัดจำรับ', 'liability')
on conflict (code) do nothing;
insert into acc.chart_of_accounts (company_id, code, name, type)
select c.id, '2420', 'เงินมัดจำรับ', 'liability' from acc.companies c where not app.company_locked(c.id)
on conflict (company_id, code) do nothing;

alter table acc.documents drop constraint documents_kind_check;
alter table acc.documents add constraint documents_kind_check
  check (kind in ('sales_invoice', 'cash_sale', 'receipt', 'credit_note', 'debit_note', 'deposit', 'deposit_applied'));

-- เลขที่เอกสารที่ไม่ลงบัญชี (QT SO BL) ใช้ตัวนับเดียวกับเลขที่รายการ: ไม่ซ้ำ ไม่ข้าม (ล็อกแถว)
create function acc.next_doc_no(p_company uuid, p_prefix text) returns text
language sql security definer set search_path = acc, pg_temp as $$
  insert into acc.document_sequences (company_id, prefix, last_no) values (p_company, p_prefix, 1)
  on conflict (company_id, prefix) do update set last_no = acc.document_sequences.last_no + 1
  returning p_prefix || '-' || lpad(last_no::text, 4, '0')
$$;
revoke all on function acc.next_doc_no(uuid, text) from public;

-- ---- ใบเสนอราคา / ใบสั่งขาย ----
create table acc.sales_orders (
  id              uuid not null default gen_random_uuid(),
  company_id      uuid not null references acc.companies(id),
  kind            text not null check (kind in ('quotation', 'sales_order')),
  doc_no          text not null,
  doc_date        date not null,
  until_date      date,             -- ใบเสนอราคา: ยืนราคาถึง · ใบสั่งขาย: กำหนดส่ง
  party_id        uuid not null,
  party_code      text not null,
  party_name      text not null,
  party_tax_id    text,
  party_branch_no text not null,
  party_address   text not null,
  is_service      boolean not null,
  price_mode      text not null check (price_mode in ('exclusive', 'inclusive', 'none')),
  vat_rate        numeric(5,2) not null,
  gross           numeric(18,2) not null check (gross > 0),
  discount        numeric(18,2) not null default 0 check (discount >= 0),
  base            numeric(18,2) not null check (base >= 0),
  vat             numeric(18,2) not null check (vat >= 0),
  total           numeric(18,2) not null check (total > 0),
  source_id       uuid,             -- ใบสั่งขายที่สร้างจากใบเสนอราคา
  description     text not null default '' check (length(description) <= 300),
  idem_key        text not null,
  created_by      uuid not null references acc.users(id),
  created_at      timestamptz not null default now(),
  cancelled_at    timestamptz,
  cancel_reason   text check (length(cancel_reason) <= 300),
  primary key (company_id, id),
  unique (company_id, doc_no),
  unique (company_id, idem_key),
  foreign key (company_id, party_id) references acc.parties (company_id, id),
  foreign key (company_id, source_id) references acc.sales_orders (company_id, id),
  check (base + vat = total and gross - discount in (base, total)),
  check (until_date is null or until_date >= doc_date),
  check ((cancelled_at is null) = (cancel_reason is null))
);
create index sales_orders_party on acc.sales_orders (company_id, party_id, doc_date);
create table acc.sales_order_lines (
  company_id  uuid not null,
  order_id    uuid not null,
  line_no     int not null check (line_no between 1 and 200),
  item_id     uuid,
  description text not null check (length(btrim(description)) between 1 and 200),
  qty         numeric(14,3) not null check (qty > 0),
  unit        text not null default '' check (length(unit) <= 20),
  unit_price  numeric(18,2) not null check (unit_price >= 0),
  amount      numeric(18,2) not null check (amount >= 0),
  primary key (company_id, order_id, line_no),
  foreign key (company_id, order_id) references acc.sales_orders (company_id, id),
  foreign key (company_id, item_id) references acc.items (company_id, id)
);
-- ขายเชื่อจากใบสั่งขาย: ส่งบรรทัดไหนเท่าไรในใบขายใบไหน (ใบขายที่ยกเลิกไม่นับ)
create table acc.sales_order_deliveries (
  company_id  uuid not null,
  order_id    uuid not null,
  line_no     int not null,
  document_id uuid not null,
  qty         numeric(14,3) not null check (qty > 0),
  primary key (company_id, order_id, line_no, document_id),
  foreign key (company_id, order_id, line_no) references acc.sales_order_lines (company_id, order_id, line_no),
  foreign key (company_id, document_id) references acc.documents (company_id, id)
);
create index sales_order_deliveries_doc on acc.sales_order_deliveries (company_id, document_id);

-- เงินมัดจำที่อ้างใบสั่งขาย
alter table acc.documents add column sales_order_id uuid;
alter table acc.documents add constraint documents_sales_order_fk foreign key (company_id, sales_order_id) references acc.sales_orders (company_id, id);

-- ---- ใบวางบิล ----
create table acc.billing_notes (
  id              uuid not null default gen_random_uuid(),
  company_id      uuid not null references acc.companies(id),
  doc_no          text not null,
  doc_date        date not null,
  due_date        date not null,
  party_id        uuid not null,
  party_code      text not null,
  party_name      text not null,
  party_tax_id    text,
  party_branch_no text not null,
  party_address   text not null,
  total           numeric(18,2) not null check (total > 0),
  description     text not null default '' check (length(description) <= 300),
  idem_key        text not null,
  created_by      uuid not null references acc.users(id),
  created_at      timestamptz not null default now(),
  cancelled_at    timestamptz,
  cancel_reason   text check (length(cancel_reason) <= 300),
  primary key (company_id, id),
  unique (company_id, doc_no),
  unique (company_id, idem_key),
  foreign key (company_id, party_id) references acc.parties (company_id, id),
  check (due_date >= doc_date),
  check ((cancelled_at is null) = (cancel_reason is null))
);
create table acc.billing_note_items (
  company_id  uuid not null,
  note_id     uuid not null,
  document_id uuid not null,
  amount      numeric(18,2) not null check (amount > 0),  -- ยอดค้าง ณ วันวางบิล
  primary key (company_id, note_id, document_id),
  foreign key (company_id, note_id) references acc.billing_notes (company_id, id),
  foreign key (company_id, document_id) references acc.documents (company_id, id)
);
create index billing_note_items_doc on acc.billing_note_items (company_id, document_id);

-- แก้ไม่ได้ เปลี่ยนได้อย่างเดียวคือบันทึกการยกเลิกครั้งเดียว
create function acc.guard_cancel_only() returns trigger
language plpgsql set search_path = acc, pg_temp as $$
begin
  if tg_op = 'DELETE' or old.cancelled_at is not null
     or (to_jsonb(new) - '{cancelled_at,cancel_reason}'::text[]) <> (to_jsonb(old) - '{cancelled_at,cancel_reason}'::text[]) then
    raise exception 'เอกสารที่ออกแล้วแก้ไม่ได้ ถ้าผิดให้ยกเลิกแล้วออกใหม่' using errcode = 'ACC06';
  end if;
  return new;
end $$;
create trigger sales_orders_guard before update or delete on acc.sales_orders for each row execute function acc.guard_cancel_only();
create trigger billing_notes_guard before update or delete on acc.billing_notes for each row execute function acc.guard_cancel_only();
create trigger sales_order_lines_immutable before update or delete on acc.sales_order_lines for each row execute function acc.forbid_mutation();
create trigger sales_order_deliveries_immutable before update or delete on acc.sales_order_deliveries for each row execute function acc.forbid_mutation();
create trigger billing_note_items_immutable before update or delete on acc.billing_note_items for each row execute function acc.forbid_mutation();
create trigger sales_orders_locked before insert or update on acc.sales_orders for each row execute function acc.guard_locked_company();
create trigger billing_notes_locked before insert or update on acc.billing_notes for each row execute function acc.guard_locked_company();
create trigger audit_sales_orders after insert or update on acc.sales_orders for each row execute function acc.audit_row();
create trigger audit_billing_notes after insert or update on acc.billing_notes for each row execute function acc.audit_row();

alter table acc.sales_orders enable row level security;
alter table acc.sales_order_lines enable row level security;
alter table acc.sales_order_deliveries enable row level security;
alter table acc.billing_notes enable row level security;
alter table acc.billing_note_items enable row level security;
grant select on acc.sales_orders, acc.sales_order_lines, acc.sales_order_deliveries, acc.billing_notes, acc.billing_note_items to app_rw, app_ro;
create policy sales_orders_read on acc.sales_orders for select to app_rw, app_ro using (company_id in (select app.readable_company_ids()));
create policy sales_order_lines_read on acc.sales_order_lines for select to app_rw, app_ro using (company_id in (select app.readable_company_ids()));
create policy sales_order_deliveries_read on acc.sales_order_deliveries for select to app_rw, app_ro using (company_id in (select app.readable_company_ids()));
create policy billing_notes_read on acc.billing_notes for select to app_rw, app_ro using (company_id in (select app.readable_company_ids()));
create policy billing_note_items_read on acc.billing_note_items for select to app_rw, app_ro using (company_id in (select app.readable_company_ids()));

-- จำนวนที่ส่งแล้วของบรรทัดใบสั่งขาย (ใบขายที่ยังไม่ยกเลิก)
create function acc.sales_order_delivered(p_company uuid, p_order uuid, p_line int) returns numeric
language sql stable set search_path = acc, pg_temp as $$
  select coalesce(sum(x.qty), 0)
    from acc.sales_order_deliveries x join acc.documents d on d.company_id = x.company_id and d.id = x.document_id
   where x.company_id = p_company and x.order_id = p_order and x.line_no = p_line and d.voided_at is null
$$;

-- ยอดคงเหลือของเงินมัดจำ (ยังไม่ได้หัก) และภาษีส่วนที่ยังไม่ได้หัก
create function acc.deposit_remaining(p_company uuid, p_deposit uuid, out amount numeric, out vat numeric)
language sql stable set search_path = acc, pg_temp as $$
  select d.total - coalesce(sum(a.total), 0), d.vat - coalesce(sum(a.vat), 0)
    from acc.documents d
    left join acc.documents a on a.company_id = d.company_id and a.ref_document_id = d.id and a.kind = 'deposit_applied' and a.voided_at is null
   where d.company_id = p_company and d.id = p_deposit
   group by d.total, d.vat
$$;

-- ---- บันทึกใบเสนอราคา / ใบสั่งขาย ----
-- p: {date, party_code, until_date?, source_id? (ใบสั่งขายจากใบเสนอราคา), is_service?, price_mode?, discount?, description?,
--     lines: [{item_code?, description?, qty, unit?, unit_price}]}
create function acc.save_sales_order(p_company uuid, p_kind text, p jsonb, p_idem text) returns uuid
language plpgsql security definer set search_path = acc, pg_temp as $$
declare
  co     acc.companies;
  pa     acc.parties;
  src    acc.sales_orders;
  it     acc.items;
  v_id   uuid;
  v_date date; v_until date;
  v_mode text; v_rate numeric; v_svc boolean; v_line_svc boolean;
  v_lines jsonb := '[]';
  v_gross numeric := 0; v_disc numeric; v_base numeric; v_vat numeric; v_total numeric;
  v_qty numeric; v_price numeric; v_amt numeric;
  r record;
begin
  if not app.can_write_company(p_company) then
    raise exception 'ไม่มีสิทธิ์ออกเอกสารในบริษัทนี้' using errcode = '42501';
  end if;
  if p_kind not in ('quotation', 'sales_order') then raise exception 'ไม่รู้จักประเภทเอกสาร %', p_kind using errcode = '22023'; end if;
  if p_idem is null or length(p_idem) < 8 then raise exception 'ต้องมี idempotency key' using errcode = 'ACC03'; end if;
  perform pg_advisory_xact_lock(hashtextextended('sales-order:' || p_company::text, 0));
  select id into v_id from acc.sales_orders where company_id = p_company and idem_key = p_idem;
  if found then return v_id; end if;
  select * into co from acc.companies where id = p_company;
  begin
    v_date := (p->>'date')::date; v_until := nullif(p->>'until_date', '')::date;
  exception when others then raise exception 'วันที่ไม่ถูกต้อง' using errcode = '22023';
  end;
  if v_date is null then raise exception 'ต้องมีวันที่เอกสาร' using errcode = '22023'; end if;
  if v_until is not null and v_until < v_date then
    raise exception '%ต้องไม่ก่อนวันที่เอกสาร', case p_kind when 'quotation' then 'วันยืนราคา' else 'กำหนดส่ง' end using errcode = '22023';
  end if;
  select * into pa from acc.parties where company_id = p_company and code = upper(p->>'party_code');
  if not found or not pa.is_customer or not pa.active then
    raise exception 'ไม่พบลูกค้ารหัส %', coalesce(p->>'party_code', '(ว่าง)') using errcode = 'ACC04';
  end if;
  if nullif(p->>'source_id', '') is not null then
    select * into src from acc.sales_orders where company_id = p_company and id = (p->>'source_id')::uuid;
    if not found or p_kind <> 'sales_order' or src.kind <> 'quotation' or src.cancelled_at is not null or src.party_id <> pa.id then
      raise exception 'ใบสั่งขายต้องอ้างใบเสนอราคาของลูกค้ารายเดียวกันที่ยังไม่ยกเลิก' using errcode = 'ACC15';
    end if;
  end if;
  if co.vat_registered then
    v_mode := coalesce(nullif(p->>'price_mode', ''), 'exclusive');
    if v_mode not in ('exclusive', 'inclusive') then raise exception 'แบบราคาต้องเป็นแยกภาษีหรือรวมภาษี' using errcode = '22023'; end if;
    v_rate := co.vat_rate;
  else
    v_mode := 'none'; v_rate := 0;
  end if;
  select i.is_service into v_svc from acc.items i where i.company_id = p_company and i.code = upper(p->'lines'->0->>'item_code');
  v_svc := coalesce((p->>'is_service')::boolean, v_svc, false);

  if jsonb_typeof(p->'lines') is distinct from 'array' or jsonb_array_length(p->'lines') not between 1 and 200 then
    raise exception 'ต้องมีรายการ 1–200 บรรทัด' using errcode = '22023';
  end if;
  for r in select l.ord::int as ord, l.value as j from jsonb_array_elements(p->'lines') with ordinality as l(value, ord) loop
    it := null;
    if nullif(r.j->>'item_code', '') is not null then
      select * into it from acc.items where company_id = p_company and code = upper(r.j->>'item_code') and active;
      if not found then raise exception 'บรรทัดที่ %: ไม่พบสินค้า/บริการรหัส %', r.ord, r.j->>'item_code' using errcode = 'ACC04'; end if;
      v_line_svc := it.is_service;
    else
      v_line_svc := v_svc;
    end if;
    if v_line_svc <> v_svc then
      raise exception 'บรรทัดที่ %: สินค้ากับบริการต้องแยกใบ (ภาษีถึงกำหนดคนละเวลา)', r.ord using errcode = 'ACC15';
    end if;
    begin
      v_qty := (r.j->>'qty')::numeric; v_price := (r.j->>'unit_price')::numeric;
    exception when others then raise exception 'บรรทัดที่ %: จำนวนหรือราคาไม่ถูกต้อง', r.ord using errcode = 'ACC05';
    end;
    if v_qty is null or v_qty <= 0 or v_qty <> round(v_qty, 3) or v_price is null or v_price < 0 or v_price <> round(v_price, 2) then
      raise exception 'บรรทัดที่ %: จำนวนต้องมากกว่า 0 (ทศนิยมไม่เกิน 3) ราคาไม่ติดลบ (ทศนิยมไม่เกิน 2)', r.ord using errcode = 'ACC05';
    end if;
    if coalesce(nullif(btrim(r.j->>'description'), ''), it.name) is null then
      raise exception 'บรรทัดที่ %: ต้องมีรายละเอียดสินค้า/บริการ', r.ord using errcode = '22023';
    end if;
    v_amt := round(v_qty * v_price, 2);
    v_lines := v_lines || jsonb_build_object('line_no', r.ord, 'item_id', it.id,
      'description', coalesce(nullif(btrim(r.j->>'description'), ''), it.name), 'qty', v_qty,
      'unit', coalesce(nullif(r.j->>'unit', ''), it.unit, ''), 'unit_price', v_price, 'amount', v_amt);
    v_gross := v_gross + v_amt;
  end loop;
  if v_gross <= 0 then raise exception 'ยอดรวมต้องมากกว่า 0' using errcode = 'ACC05'; end if;
  v_disc := coalesce(nullif(p->>'discount', '')::numeric, 0);
  if v_disc < 0 or v_disc <> round(v_disc, 2) or v_disc >= v_gross then
    raise exception 'ส่วนลดต้องไม่ติดลบ ทศนิยมไม่เกิน 2 ตำแหน่ง และน้อยกว่ายอดรวม' using errcode = 'ACC05';
  end if;
  select c.base, c.vat, c.total into v_base, v_vat, v_total from app.vat_calc(v_gross, v_disc, v_rate, v_mode) c;

  insert into acc.sales_orders (company_id, kind, doc_no, doc_date, until_date, party_id, party_code, party_name, party_tax_id,
      party_branch_no, party_address, is_service, price_mode, vat_rate, gross, discount, base, vat, total, source_id, description,
      idem_key, created_by)
  values (p_company, p_kind, acc.next_doc_no(p_company, case p_kind when 'quotation' then 'QT' else 'SO' end), v_date, v_until,
      pa.id, pa.code, pa.name, pa.tax_id, pa.branch_no, pa.address, v_svc, v_mode, v_rate, v_gross, v_disc, v_base, v_vat, v_total,
      src.id, coalesce(btrim(p->>'description'), ''), p_idem, app.current_user_id())
  returning id into v_id;
  insert into acc.sales_order_lines (company_id, order_id, line_no, item_id, description, qty, unit, unit_price, amount)
  select p_company, v_id, (l->>'line_no')::int, nullif(l->>'item_id', '')::uuid, l->>'description', (l->>'qty')::numeric,
         l->>'unit', (l->>'unit_price')::numeric, (l->>'amount')::numeric
    from jsonb_array_elements(v_lines) l;
  return v_id;
end $$;

create function acc.cancel_sales_order(p_company uuid, p_order uuid, p_reason text) returns void
language plpgsql security definer set search_path = acc, pg_temp as $$
declare o acc.sales_orders;
begin
  if not app.can_write_company(p_company) then raise exception 'ไม่มีสิทธิ์' using errcode = '42501'; end if;
  select * into o from acc.sales_orders where company_id = p_company and id = p_order for update;
  if not found then raise exception 'ไม่พบเอกสาร' using errcode = 'ACC04'; end if;
  if o.cancelled_at is not null then return; end if;
  if length(btrim(coalesce(p_reason, ''))) = 0 then raise exception 'ต้องระบุเหตุผลที่ยกเลิก' using errcode = '22023'; end if;
  if exists (select 1 from acc.sales_order_deliveries x join acc.documents d on d.company_id = x.company_id and d.id = x.document_id
              where x.company_id = p_company and x.order_id = o.id and d.voided_at is null)
     or exists (select 1 from acc.documents d where d.company_id = p_company and d.sales_order_id = o.id and d.voided_at is null)
     or exists (select 1 from acc.sales_orders s where s.company_id = p_company and s.source_id = o.id and s.cancelled_at is null) then
    raise exception '% มีใบสั่งขาย/ใบขาย/เงินมัดจำอ้างอยู่ ยกเลิกเอกสารเหล่านั้นก่อน', o.doc_no using errcode = 'ACC16';
  end if;
  update acc.sales_orders set cancelled_at = now(), cancel_reason = btrim(p_reason) where company_id = p_company and id = o.id;
end $$;

-- ---- รับเงินมัดจำ (DP): ใบกำกับภาษี/ใบเสร็จรับเงินมัดจำ Dr เงิน / Cr 2420 / Cr 2210 ----
-- p: {date, party_code, amount, price_mode?, is_service?, cash_account?, order_id?, description?}
create function acc.post_sales_deposit(p_company uuid, p jsonb, p_idem text) returns uuid
language plpgsql security definer set search_path = acc, pg_temp as $$
declare
  co acc.companies; pa acc.parties; o acc.sales_orders; v_cash acc.chart_of_accounts; a_dep acc.chart_of_accounts;
  v_id uuid; v_date date; v_mode text; v_rate numeric; v_svc boolean; v_amt numeric;
  v_base numeric; v_vat numeric; v_total numeric; v_je jsonb; v_eid uuid; v_tax boolean;
begin
  if not app.can_write_company(p_company) then raise exception 'ไม่มีสิทธิ์ออกเอกสารในบริษัทนี้' using errcode = '42501'; end if;
  select id into v_id from acc.documents where company_id = p_company and idem_key = p_idem;
  if found then return v_id; end if;
  perform acc.ensure_tax_accounts(p_company);
  insert into acc.chart_of_accounts (company_id, code, name, type) values (p_company, '2420', 'เงินมัดจำรับ', 'liability')
  on conflict (company_id, code) do nothing;
  select * into a_dep from acc.chart_of_accounts where company_id = p_company and code = '2420';
  select * into co from acc.companies where id = p_company;
  begin
    v_date := (p->>'date')::date; v_amt := (p->>'amount')::numeric;
  exception when others then raise exception 'วันที่หรือจำนวนเงินไม่ถูกต้อง' using errcode = '22023';
  end;
  if v_date is null then raise exception 'ต้องมีวันที่เอกสาร' using errcode = '22023'; end if;
  if v_amt is null or v_amt <= 0 or v_amt <> round(v_amt, 2) then
    raise exception 'จำนวนเงินมัดจำต้องมากกว่า 0 ทศนิยมไม่เกิน 2 ตำแหน่ง' using errcode = 'ACC05';
  end if;
  select * into pa from acc.parties where company_id = p_company and code = upper(p->>'party_code');
  if not found or not pa.is_customer or not pa.active then
    raise exception 'ไม่พบลูกค้ารหัส %', coalesce(p->>'party_code', '(ว่าง)') using errcode = 'ACC04';
  end if;
  if nullif(p->>'order_id', '') is not null then
    select * into o from acc.sales_orders where company_id = p_company and id = (p->>'order_id')::uuid;
    if not found or o.kind <> 'sales_order' or o.cancelled_at is not null or o.party_id <> pa.id then
      raise exception 'เงินมัดจำต้องอ้างใบสั่งขายของลูกค้ารายเดียวกันที่ยังไม่ยกเลิก' using errcode = 'ACC15';
    end if;
  end if;
  v_svc := coalesce((p->>'is_service')::boolean, o.is_service, false);
  if co.vat_registered then
    v_mode := coalesce(nullif(p->>'price_mode', ''), o.price_mode, 'exclusive');
    if v_mode not in ('exclusive', 'inclusive') then raise exception 'แบบราคาต้องเป็นแยกภาษีหรือรวมภาษี' using errcode = '22023'; end if;
    v_rate := co.vat_rate;
  else
    v_mode := 'none'; v_rate := 0;
  end if;
  select c.base, c.vat, c.total into v_base, v_vat, v_total from app.vat_calc(v_amt, 0, v_rate, v_mode) c;
  v_tax := co.vat_registered;
  if v_tax and co.tax_id is null then
    raise exception 'กรอกเลขประจำตัวผู้เสียภาษีของบริษัทก่อนออกใบกำกับภาษี (ข้อมูลบริษัทและภาษี)' using errcode = 'ACC14';
  end if;
  select * into v_cash from acc.chart_of_accounts
   where company_id = p_company and code = coalesce(nullif(p->>'cash_account', ''), '1110') and active and type = 'asset' and code like '11%';
  if not found then raise exception 'บัญชีรับเงินต้องเป็นบัญชีเงินสด/เงินฝาก (11xx)' using errcode = 'ACC04'; end if;

  v_je := jsonb_build_array(
    jsonb_build_object('account_code', v_cash.code, 'debit', v_total::text, 'memo', pa.name),
    jsonb_build_object('account_code', '2420', 'credit', v_base::text, 'memo', pa.name));
  if v_vat > 0 then v_je := v_je || jsonb_build_object('account_code', '2210', 'credit', v_vat::text, 'memo', pa.name); end if;
  v_eid := acc.post_journal(p_company, v_date,
    coalesce(nullif(btrim(p->>'description'), ''), 'รับเงินมัดจำ ' || pa.name || coalesce(' ' || o.doc_no, '')), v_je, p_idem, 'DP', null);
  select id into v_id from acc.documents where company_id = p_company and entry_id = v_eid;
  if found then return v_id; end if;

  insert into acc.documents (company_id, kind, doc_no, doc_date, party_id, party_code, party_name, party_tax_id, party_branch_no,
      party_address, seller_name, seller_tax_id, seller_branch_no, seller_address, is_service, is_tax_invoice, price_mode, vat_rate,
      gross, discount, base, vat, total, cash_account_id, description, entry_id, idem_key, created_by, sales_order_id)
  select p_company, 'deposit', e.doc_no, v_date, pa.id, pa.code, pa.name, pa.tax_id, pa.branch_no, pa.address,
         co.name, co.tax_id, co.branch_no, co.address, v_svc, v_tax, v_mode, v_rate, v_amt, 0, v_base, v_vat, v_total, v_cash.id,
         coalesce(btrim(p->>'description'), ''), v_eid, p_idem, app.current_user_id(), o.id
    from acc.journal_entries e where e.company_id = p_company and e.id = v_eid
  returning id into v_id;
  insert into acc.document_lines (company_id, document_id, line_no, description, qty, unit_price, amount, account_id)
  values (p_company, v_id, 1, 'เงินมัดจำ' || coalesce(' ตามใบสั่งขาย ' || o.doc_no, ''), 1, v_amt, v_amt, a_dep.id);
  return v_id;
end $$;

-- ---- หักเงินมัดจำในใบขายเชื่อ (DA) ----
create function acc.apply_sales_deposit(p_company uuid, p_invoice uuid, p_deposit uuid, p_amount numeric, p_idem text) returns uuid
language plpgsql security definer set search_path = acc, pg_temp as $$
declare
  inv acc.documents; dep acc.documents; a_dep acc.chart_of_accounts;
  v_rem numeric; v_rem_vat numeric; v_open numeric; v_vat numeric; v_base numeric; v_je jsonb; v_eid uuid; v_id uuid;
begin
  select * into inv from acc.documents where company_id = p_company and id = p_invoice for update;
  select * into dep from acc.documents where company_id = p_company and id = p_deposit for update;
  if not found or dep.kind <> 'deposit' or dep.voided_at is not null or dep.party_id <> inv.party_id then
    raise exception 'หักได้เฉพาะเงินมัดจำของลูกค้ารายเดียวกันที่ยังไม่ยกเลิก' using errcode = 'ACC15';
  end if;
  if inv.kind <> 'sales_invoice' or inv.voided_at is not null then
    raise exception 'หักเงินมัดจำได้ในใบขายเชื่อที่ยังไม่ยกเลิก' using errcode = 'ACC15';
  end if;
  if dep.doc_date > inv.doc_date then
    raise exception '% ลงวันที่หลังใบขาย หักไม่ได้', dep.doc_no using errcode = '22023';
  end if;
  if p_amount is null or p_amount <= 0 or p_amount <> round(p_amount, 2) then
    raise exception 'ยอดหักเงินมัดจำต้องมากกว่า 0 ทศนิยมไม่เกิน 2 ตำแหน่ง' using errcode = 'ACC05';
  end if;
  select amount, vat into v_rem, v_rem_vat from acc.deposit_remaining(p_company, dep.id);
  if p_amount > v_rem then
    raise exception '% เหลือ % หักเกินไม่ได้', dep.doc_no, to_char(v_rem, 'FM999,999,999,990.00') using errcode = 'ACC15';
  end if;
  select inv.total - s.amount into v_open from acc.document_settled(p_company, inv.id) s;
  if p_amount > v_open then
    raise exception 'หักเงินมัดจำ % เกินยอดค้างของ % (%)', to_char(p_amount, 'FM999,999,999,990.00'), inv.doc_no,
      to_char(v_open, 'FM999,999,999,990.00') using errcode = 'ACC15';
  end if;
  -- ภาษีตามสัดส่วน ครั้งที่หักหมดรับเศษที่เหลือ
  v_vat := case when p_amount = v_rem then v_rem_vat else round(dep.vat * p_amount / dep.total, 2) end;
  v_base := p_amount - v_vat;
  select * into a_dep from acc.chart_of_accounts where company_id = p_company and code = '2420';
  v_je := jsonb_build_array(jsonb_build_object('account_code', '2420', 'debit', v_base::text, 'memo', dep.doc_no));
  if v_vat > 0 then
    v_je := v_je || jsonb_build_object('account_code', case when inv.is_service then '2211' else '2210' end, 'debit', v_vat::text, 'memo', dep.doc_no);
  end if;
  v_je := v_je || jsonb_build_object('account_code', '1210', 'credit', p_amount::text, 'memo', inv.party_name);
  v_eid := acc.post_journal(p_company, inv.doc_date, 'หักเงินมัดจำ ' || dep.doc_no || ' ใน ' || inv.doc_no, v_je, p_idem, 'DA', null);

  insert into acc.documents (company_id, kind, doc_no, doc_date, party_id, party_code, party_name, party_tax_id, party_branch_no,
      party_address, seller_name, seller_tax_id, seller_branch_no, seller_address, is_service, is_tax_invoice, price_mode, vat_rate,
      gross, discount, base, vat, total, ref_document_id, description, entry_id, idem_key, created_by)
  select p_company, 'deposit_applied', e.doc_no, inv.doc_date, inv.party_id, inv.party_code, inv.party_name, inv.party_tax_id,
         inv.party_branch_no, inv.party_address, inv.seller_name, inv.seller_tax_id, inv.seller_branch_no, inv.seller_address,
         inv.is_service, dep.is_tax_invoice and not inv.is_service, dep.price_mode, dep.vat_rate, p_amount, 0, v_base, v_vat, p_amount,
         dep.id, 'หักเงินมัดจำ ' || dep.doc_no || ' ใน ' || inv.doc_no, v_eid, p_idem, app.current_user_id()
    from acc.journal_entries e where e.company_id = p_company and e.id = v_eid
  returning id into v_id;
  insert into acc.document_lines (company_id, document_id, line_no, description, qty, unit_price, amount, account_id)
  values (p_company, v_id, 1, 'หักเงินมัดจำ ' || dep.doc_no, 1, p_amount, p_amount, a_dep.id);
  insert into acc.allocations (company_id, source_id, target_id, amount, vat_transfer)
  values (p_company, v_id, inv.id, p_amount, case when inv.is_service then v_vat else 0 end);
  return v_id;
end $$;

-- ---- ขายเชื่อ (ต่อยอด post_sales_document): อ้างใบสั่งขาย + หักเงินมัดจำ ในธุรกรรมเดียว ----
-- p เหมือน post_sales_document + {order_id?, lines[].order_line_no?, deposits?: [{document_id, amount}]}
create function acc.post_sales_invoice_ext(p_company uuid, p jsonb, p_idem text) returns uuid
language plpgsql security definer set search_path = acc, pg_temp as $$
declare
  o acc.sales_orders; ol acc.sales_order_lines; pa acc.parties;
  v_id uuid; r record; v_qty numeric; v_done numeric;
begin
  select id into v_id from acc.documents where company_id = p_company and idem_key = p_idem;
  if found then return v_id; end if;
  if nullif(p->>'order_id', '') is not null then
    select * into o from acc.sales_orders where company_id = p_company and id = (p->>'order_id')::uuid for update;
    select * into pa from acc.parties where company_id = p_company and code = upper(p->>'party_code');
    if not found or o.id is null or o.kind <> 'sales_order' or o.cancelled_at is not null or o.party_id <> pa.id then
      raise exception 'ใบขายต้องอ้างใบสั่งขายของลูกค้ารายเดียวกันที่ยังไม่ยกเลิก' using errcode = 'ACC15';
    end if;
  end if;
  v_id := acc.post_sales_document(p_company, 'sales_invoice', p, p_idem);

  if o.id is not null then
    for r in select l.ord::int as ord, l.value as j from jsonb_array_elements(p->'lines') with ordinality as l(value, ord)
              where nullif(l.value->>'order_line_no', '') is not null loop
      select * into ol from acc.sales_order_lines where company_id = p_company and order_id = o.id and line_no = (r.j->>'order_line_no')::int;
      if not found then raise exception 'บรรทัดที่ %: ไม่พบบรรทัด % ในใบสั่งขาย %', r.ord, r.j->>'order_line_no', o.doc_no using errcode = 'ACC15'; end if;
      v_qty := (r.j->>'qty')::numeric;
      v_done := acc.sales_order_delivered(p_company, o.id, ol.line_no);
      if v_done + v_qty > ol.qty then
        raise exception 'บรรทัดที่ %: ส่งเกินจำนวนในใบสั่งขาย % (สั่ง % ส่งแล้ว %)', r.ord, o.doc_no, ol.qty, v_done using errcode = 'ACC15';
      end if;
      insert into acc.sales_order_deliveries (company_id, order_id, line_no, document_id, qty)
      values (p_company, o.id, ol.line_no, v_id, v_qty)
      on conflict (company_id, order_id, line_no, document_id) do update set qty = acc.sales_order_deliveries.qty + excluded.qty;
    end loop;
  end if;
  for r in select l.ord::int as ord, l.value as j from jsonb_array_elements(coalesce(p->'deposits', '[]')) with ordinality as l(value, ord) loop
    perform acc.apply_sales_deposit(p_company, v_id, (r.j->>'document_id')::uuid, (r.j->>'amount')::numeric, p_idem || ':da:' || r.ord);
  end loop;
  return v_id;
end $$;

-- ---- ใบวางบิล ----
-- p: {date, party_code, due_date?, document_ids: [...], description?}
create function acc.create_billing_note(p_company uuid, p jsonb, p_idem text) returns uuid
language plpgsql security definer set search_path = acc, pg_temp as $$
declare
  pa acc.parties; d acc.documents; v_id uuid; v_date date; v_due date; v_open numeric; v_total numeric := 0;
  v_items jsonb := '[]'; r record; v_bl text;
begin
  if not app.can_write_company(p_company) then raise exception 'ไม่มีสิทธิ์ออกเอกสารในบริษัทนี้' using errcode = '42501'; end if;
  if p_idem is null or length(p_idem) < 8 then raise exception 'ต้องมี idempotency key' using errcode = 'ACC03'; end if;
  perform pg_advisory_xact_lock(hashtextextended('billing:' || p_company::text, 0));
  select id into v_id from acc.billing_notes where company_id = p_company and idem_key = p_idem;
  if found then return v_id; end if;
  begin
    v_date := (p->>'date')::date; v_due := nullif(p->>'due_date', '')::date;
  exception when others then raise exception 'วันที่ไม่ถูกต้อง' using errcode = '22023';
  end;
  if v_date is null then raise exception 'ต้องมีวันที่เอกสาร' using errcode = '22023'; end if;
  select * into pa from acc.parties where company_id = p_company and code = upper(p->>'party_code');
  if not found or not pa.is_customer then
    raise exception 'ไม่พบลูกค้ารหัส %', coalesce(p->>'party_code', '(ว่าง)') using errcode = 'ACC04';
  end if;
  if jsonb_typeof(p->'document_ids') is distinct from 'array' or jsonb_array_length(p->'document_ids') = 0 then
    raise exception 'เลือกใบที่จะวางบิลอย่างน้อยหนึ่งใบ' using errcode = '22023';
  end if;
  for r in select distinct value::text::uuid as id from jsonb_array_elements_text(p->'document_ids') loop
    select * into d from acc.documents where company_id = p_company and id = r.id;
    if not found or d.kind not in ('sales_invoice', 'debit_note') or d.voided_at is not null or d.party_id <> pa.id then
      raise exception 'วางบิลได้เฉพาะใบขายเชื่อ/ใบเพิ่มหนี้ของ % ที่ยังไม่ยกเลิก', pa.name using errcode = 'ACC15';
    end if;
    if d.doc_date > v_date then raise exception '% ลงวันที่หลังวันวางบิล', d.doc_no using errcode = '22023'; end if;
    select d.total - s.amount into v_open from acc.document_settled(p_company, d.id) s;
    if v_open <= 0 then raise exception '% ไม่มียอดค้าง', d.doc_no using errcode = 'ACC15'; end if;
    select b.doc_no into v_bl from acc.billing_note_items i join acc.billing_notes b on b.company_id = i.company_id and b.id = i.note_id
     where i.company_id = p_company and i.document_id = d.id and b.cancelled_at is null limit 1;
    if v_bl is not null then raise exception '% อยู่ในใบวางบิล % แล้ว', d.doc_no, v_bl using errcode = 'ACC15'; end if;
    v_items := v_items || jsonb_build_object('id', d.id, 'open', v_open, 'due', d.due_date);
    v_total := v_total + v_open;
  end loop;
  v_due := coalesce(v_due, (select max((x->>'due')::date) from jsonb_array_elements(v_items) x), v_date);
  if v_due < v_date then v_due := v_date; end if;
  insert into acc.billing_notes (company_id, doc_no, doc_date, due_date, party_id, party_code, party_name, party_tax_id, party_branch_no,
      party_address, total, description, idem_key, created_by)
  values (p_company, acc.next_doc_no(p_company, 'BL'), v_date, v_due, pa.id, pa.code, pa.name, pa.tax_id, pa.branch_no, pa.address,
      v_total, coalesce(btrim(p->>'description'), ''), p_idem, app.current_user_id())
  returning id into v_id;
  insert into acc.billing_note_items (company_id, note_id, document_id, amount)
  select p_company, v_id, (x->>'id')::uuid, (x->>'open')::numeric from jsonb_array_elements(v_items) x;
  return v_id;
end $$;

create function acc.cancel_billing_note(p_company uuid, p_note uuid, p_reason text) returns void
language plpgsql security definer set search_path = acc, pg_temp as $$
begin
  if not app.can_write_company(p_company) then raise exception 'ไม่มีสิทธิ์' using errcode = '42501'; end if;
  if length(btrim(coalesce(p_reason, ''))) = 0 then raise exception 'ต้องระบุเหตุผลที่ยกเลิก' using errcode = '22023'; end if;
  update acc.billing_notes set cancelled_at = now(), cancel_reason = btrim(p_reason)
   where company_id = p_company and id = p_note and cancelled_at is null;
  if not found and not exists (select 1 from acc.billing_notes where company_id = p_company and id = p_note) then
    raise exception 'ไม่พบใบวางบิล' using errcode = 'ACC04';
  end if;
end $$;

-- ---- รายงานภาษีขาย: ใบหักเงินมัดจำ (สินค้า) เป็นรายการลบ ----
create or replace function acc.vat_report(p_company uuid, p_month date, p_side text)
returns table (row_date date, document_id uuid, doc_no text, ref_no text, kind text, party_name text, party_tax_id text,
               party_branch_no text, base numeric, vat numeric, status text)
language sql stable set search_path = acc, pg_temp as $$
  with ev as (
    select d.id, d.doc_date, d.doc_no, null::text as ref_no, d.kind, d.party_name, d.party_tax_id, d.party_branch_no,
           case when d.kind in ('credit_note', 'deposit_applied') then -1 else 1 end as sign,
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

revoke all on function acc.save_sales_order(uuid, text, jsonb, text), acc.cancel_sales_order(uuid, uuid, text),
  acc.post_sales_deposit(uuid, jsonb, text), acc.apply_sales_deposit(uuid, uuid, uuid, numeric, text),
  acc.post_sales_invoice_ext(uuid, jsonb, text), acc.create_billing_note(uuid, jsonb, text), acc.cancel_billing_note(uuid, uuid, text) from public;
grant execute on function acc.save_sales_order(uuid, text, jsonb, text), acc.cancel_sales_order(uuid, uuid, text),
  acc.post_sales_deposit(uuid, jsonb, text), acc.post_sales_invoice_ext(uuid, jsonb, text),
  acc.create_billing_note(uuid, jsonb, text), acc.cancel_billing_note(uuid, uuid, text) to app_rw;
grant execute on function acc.sales_order_delivered(uuid, uuid, int), acc.deposit_remaining(uuid, uuid) to app_rw, app_ro;

-- migrate:down
drop function acc.cancel_billing_note(uuid, uuid, text), acc.create_billing_note(uuid, jsonb, text),
  acc.post_sales_invoice_ext(uuid, jsonb, text), acc.apply_sales_deposit(uuid, uuid, uuid, numeric, text),
  acc.post_sales_deposit(uuid, jsonb, text), acc.cancel_sales_order(uuid, uuid, text), acc.save_sales_order(uuid, text, jsonb, text),
  acc.deposit_remaining(uuid, uuid), acc.sales_order_delivered(uuid, uuid, int);
drop table acc.billing_note_items, acc.billing_notes;
alter table acc.documents drop constraint documents_sales_order_fk, drop column sales_order_id;
drop table acc.sales_order_deliveries, acc.sales_order_lines, acc.sales_orders;
drop function acc.guard_cancel_only(), acc.next_doc_no(uuid, text);
alter table acc.documents drop constraint documents_kind_check;
alter table acc.documents add constraint documents_kind_check
  check (kind in ('sales_invoice', 'cash_sale', 'receipt', 'credit_note', 'debit_note'));
-- vat_report: คืนรุ่นเดิมจาก migration 20261013000017 (ไม่มีแถว deposit_applied ก่อน migration นี้)
