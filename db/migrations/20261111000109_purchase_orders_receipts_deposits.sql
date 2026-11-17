-- migrate:up
-- เอกสารซื้อ: ใบสั่งซื้อ → ใบรับสินค้า → บันทึกซื้อ · ใบเพิ่มหนี้จากผู้ขาย · จ่ายเงินมัดจำ และหักมัดจำตอนซื้อ
-- (docs/phase5-spec.md ข้อ 5, docs/assumptions.md ข้อ 44)
-- ใบสั่งซื้อไม่ลงบัญชี · ใบรับสินค้า (GR) ล้างสินค้ารับ (GM) ใบเพิ่มหนี้ (PD) มัดจำ (VD) หักมัดจำ (VA) ลงผ่าน acc.post_journal

insert into acc.coa_template (code, name, type) values
  ('1520', 'เงินมัดจำจ่าย', 'asset'),
  ('2130', 'สินค้ารับแล้วยังไม่ได้รับใบแจ้งหนี้', 'liability')
on conflict (code) do nothing;
insert into acc.chart_of_accounts (company_id, code, name, type)
select c.id, t.code, t.name, t.type from acc.companies c cross join acc.coa_template t
 where t.code in ('1520', '2130') and not app.company_locked(c.id)
on conflict (company_id, code) do nothing;

alter table acc.purchase_documents drop constraint purchase_documents_kind_check;
alter table acc.purchase_documents add constraint purchase_documents_kind_check
  check (kind in ('purchase_invoice', 'cash_purchase', 'purchase_credit_note', 'payment',
                  'goods_receipt', 'purchase_debit_note', 'deposit', 'deposit_applied'));
alter table acc.purchase_documents drop constraint purchase_documents_check4;
alter table acc.purchase_documents add constraint purchase_documents_vendor_doc_required
  check ((kind in ('payment', 'deposit_applied')) = (vendor_doc_no is null));

-- เลขที่เอกสารของผู้ขายห้ามซ้ำภายในกลุ่ม: ใบกำกับ (ซื้อเชื่อ/ซื้อสด) · ใบลดหนี้ · ใบเพิ่มหนี้ · ใบส่งของ · ใบรับเงินมัดจำ
create function acc.purchase_vendor_doc_group(p_kind text) returns int
language sql immutable set search_path = acc, pg_temp as $$
  select case p_kind when 'purchase_credit_note' then 1 when 'purchase_debit_note' then 2
                     when 'goods_receipt' then 3 when 'deposit' then 4 else 0 end
$$;
drop index acc.purchase_documents_vendor_doc;
create unique index purchase_documents_vendor_doc on acc.purchase_documents
  (company_id, party_id, acc.purchase_vendor_doc_group(kind), upper(btrim(vendor_doc_no)))
  where voided_at is null and vendor_doc_no is not null;

-- ---- ใบสั่งซื้อ ----
create table acc.purchase_orders (
  id              uuid not null default gen_random_uuid(),
  company_id      uuid not null references acc.companies(id),
  doc_no          text not null,
  doc_date        date not null,
  until_date      date,             -- กำหนดส่ง
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
  check (base + vat = total and gross - discount in (base, total)),
  check (until_date is null or until_date >= doc_date),
  check ((cancelled_at is null) = (cancel_reason is null))
);
create index purchase_orders_party on acc.purchase_orders (company_id, party_id, doc_date);
create table acc.purchase_order_lines (
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
  foreign key (company_id, order_id) references acc.purchase_orders (company_id, id),
  foreign key (company_id, item_id) references acc.items (company_id, id)
);
-- รับของตามใบสั่งซื้อ: บรรทัดไหนเท่าไรในใบรับสินค้า/ใบซื้อใบไหน (เอกสารที่ยกเลิกไม่นับ)
create table acc.purchase_order_receipts (
  company_id  uuid not null,
  order_id    uuid not null,
  line_no     int not null,
  document_id uuid not null,
  qty         numeric(14,3) not null check (qty > 0),
  primary key (company_id, order_id, line_no, document_id),
  foreign key (company_id, order_id, line_no) references acc.purchase_order_lines (company_id, order_id, line_no),
  foreign key (company_id, document_id) references acc.purchase_documents (company_id, id)
);
create index purchase_order_receipts_doc on acc.purchase_order_receipts (company_id, document_id);
-- เงินมัดจำที่อ้างใบสั่งซื้อ
alter table acc.purchase_documents add column purchase_order_id uuid;
alter table acc.purchase_documents add constraint purchase_documents_order_fk
  foreign key (company_id, purchase_order_id) references acc.purchase_orders (company_id, id);

-- ---- ใบซื้อที่จับคู่กับใบรับสินค้า: บรรทัดของใบซื้อ ↔ บรรทัดของใบรับสินค้า (มูลค่าตามใบรับสินค้า) ----
create table acc.purchase_receipt_matches (
  company_id      uuid not null,
  invoice_id      uuid not null,
  invoice_line_no int not null,
  receipt_id      uuid not null,
  receipt_line_no int not null,
  qty             numeric(14,3) not null check (qty > 0),
  amount          numeric(18,2) not null check (amount >= 0),
  primary key (company_id, invoice_id, invoice_line_no),
  foreign key (company_id, invoice_id, invoice_line_no) references acc.purchase_document_lines (company_id, document_id, line_no),
  foreign key (company_id, receipt_id, receipt_line_no) references acc.purchase_document_lines (company_id, document_id, line_no)
);
create index purchase_receipt_matches_receipt on acc.purchase_receipt_matches (company_id, receipt_id, receipt_line_no);
-- รายการล้าง 2130 ของใบซื้อ (กลับรายการเมื่อยกเลิกใบซื้อ)
create table acc.purchase_receipt_match_posts (
  company_id uuid not null,
  invoice_id uuid not null,
  entry_id   uuid not null,
  primary key (company_id, invoice_id),
  foreign key (company_id, invoice_id) references acc.purchase_documents (company_id, id),
  foreign key (company_id, entry_id) references acc.journal_entries (company_id, id)
);

create trigger purchase_orders_guard before update or delete on acc.purchase_orders for each row execute function acc.guard_cancel_only();
create trigger purchase_order_lines_immutable before update or delete on acc.purchase_order_lines for each row execute function acc.forbid_mutation();
create trigger purchase_order_receipts_immutable before update or delete on acc.purchase_order_receipts for each row execute function acc.forbid_mutation();
create trigger purchase_receipt_matches_immutable before update or delete on acc.purchase_receipt_matches for each row execute function acc.forbid_mutation();
create trigger purchase_receipt_match_posts_immutable before update or delete on acc.purchase_receipt_match_posts for each row execute function acc.forbid_mutation();
create trigger purchase_orders_locked before insert or update on acc.purchase_orders for each row execute function acc.guard_locked_company();
create trigger audit_purchase_orders after insert or update on acc.purchase_orders for each row execute function acc.audit_row();

alter table acc.purchase_orders enable row level security;
alter table acc.purchase_order_lines enable row level security;
alter table acc.purchase_order_receipts enable row level security;
alter table acc.purchase_receipt_matches enable row level security;
alter table acc.purchase_receipt_match_posts enable row level security;
grant select on acc.purchase_orders, acc.purchase_order_lines, acc.purchase_order_receipts, acc.purchase_receipt_matches,
  acc.purchase_receipt_match_posts to app_rw, app_ro;
create policy purchase_orders_read on acc.purchase_orders for select to app_rw, app_ro using (company_id in (select app.readable_company_ids()));
create policy purchase_order_lines_read on acc.purchase_order_lines for select to app_rw, app_ro using (company_id in (select app.readable_company_ids()));
create policy purchase_order_receipts_read on acc.purchase_order_receipts for select to app_rw, app_ro using (company_id in (select app.readable_company_ids()));
create policy purchase_receipt_matches_read on acc.purchase_receipt_matches for select to app_rw, app_ro using (company_id in (select app.readable_company_ids()));
create policy purchase_receipt_match_posts_read on acc.purchase_receipt_match_posts for select to app_rw, app_ro using (company_id in (select app.readable_company_ids()));

-- จำนวนที่รับแล้วของบรรทัดใบสั่งซื้อ
create function acc.purchase_order_received(p_company uuid, p_order uuid, p_line int) returns numeric
language sql stable set search_path = acc, pg_temp as $$
  select coalesce(sum(x.qty), 0)
    from acc.purchase_order_receipts x join acc.purchase_documents d on d.company_id = x.company_id and d.id = x.document_id
   where x.company_id = p_company and x.order_id = p_order and x.line_no = p_line and d.voided_at is null
$$;
-- จำนวน/มูลค่าของบรรทัดใบรับสินค้าที่ได้รับใบแจ้งหนี้แล้ว (ใบซื้อที่ยังไม่ยกเลิก)
create function acc.receipt_line_invoiced(p_company uuid, p_receipt uuid, p_line int, out qty numeric, out amount numeric)
language sql stable set search_path = acc, pg_temp as $$
  select coalesce(sum(m.qty), 0), coalesce(sum(m.amount), 0)
    from acc.purchase_receipt_matches m join acc.purchase_documents d on d.company_id = m.company_id and d.id = m.invoice_id
   where m.company_id = p_company and m.receipt_id = p_receipt and m.receipt_line_no = p_line and d.voided_at is null
$$;
-- ยอดคงเหลือของเงินมัดจำจ่าย (ยังไม่ได้หัก) และภาษีส่วนที่ยังไม่ได้หัก
create function acc.purchase_deposit_remaining(p_company uuid, p_deposit uuid, out amount numeric, out vat numeric)
language sql stable set search_path = acc, pg_temp as $$
  select d.total - coalesce(sum(a.total), 0), d.vat - coalesce(sum(a.vat), 0)
    from acc.purchase_documents d
    left join acc.purchase_documents a on a.company_id = d.company_id and a.ref_document_id = d.id
                                      and a.kind = 'deposit_applied' and a.voided_at is null
   where d.company_id = p_company and d.id = p_deposit
   group by d.total, d.vat
$$;

-- เจ้าหนี้คงค้าง: ใบซื้อเชื่อ + ใบเพิ่มหนี้
create or replace function acc.ap_open_items(p_company uuid)
returns table (document_id uuid, doc_no text, vendor_doc_no text, doc_date date, due_date date, party_code text, party_name text,
               is_service boolean, total numeric, settled numeric, open numeric, undue_vat numeric)
language sql stable set search_path = acc, app, public, pg_temp as $$
  select d.id, d.doc_no, d.vendor_doc_no, d.doc_date, d.due_date, d.party_code, d.party_name, d.is_service, d.total,
         s.amount, d.total - s.amount, case when d.is_service and d.vat_claimable then d.vat - s.vat else 0 end
    from acc.purchase_documents d cross join lateral acc.purchase_settled(d.company_id, d.id) s
   where d.company_id = p_company and d.kind in ('purchase_invoice', 'purchase_debit_note') and d.voided_at is null
     and d.total - s.amount > 0
   order by d.due_date, d.doc_no
$$;

-- ---- ใบสั่งซื้อ (PO) ----
-- p: {date, until_date?, party_code, is_service?, price_mode?, discount?, description?, lines: [{item_code?, description?, qty, unit?, unit_price}]}
create function acc.save_purchase_order(p_company uuid, p jsonb, p_idem text) returns uuid
language plpgsql security definer set search_path = acc, pg_temp as $$
declare
  co acc.companies; pa acc.parties; it acc.items;
  v_id uuid; v_date date; v_until date; v_mode text; v_rate numeric; v_svc boolean; v_line_svc boolean;
  v_lines jsonb := '[]'; v_gross numeric := 0; v_disc numeric; v_base numeric; v_vat numeric; v_total numeric;
  v_qty numeric; v_price numeric; v_amt numeric; r record;
begin
  if not app.can_write_company(p_company) then
    raise exception 'ไม่มีสิทธิ์ออกเอกสารในบริษัทนี้' using errcode = '42501';
  end if;
  if p_idem is null or length(p_idem) < 8 then raise exception 'ต้องมี idempotency key' using errcode = 'ACC03'; end if;
  perform pg_advisory_xact_lock(hashtextextended('purchase-order:' || p_company::text, 0));
  select id into v_id from acc.purchase_orders where company_id = p_company and idem_key = p_idem;
  if found then return v_id; end if;
  select * into co from acc.companies where id = p_company;
  begin
    v_date := (p->>'date')::date; v_until := nullif(p->>'until_date', '')::date;
  exception when others then raise exception 'วันที่ไม่ถูกต้อง' using errcode = '22023';
  end;
  if v_date is null then raise exception 'ต้องมีวันที่เอกสาร' using errcode = '22023'; end if;
  if v_until is not null and v_until < v_date then
    raise exception 'กำหนดส่งต้องไม่ก่อนวันที่เอกสาร' using errcode = '22023';
  end if;
  select * into pa from acc.parties where company_id = p_company and code = upper(p->>'party_code');
  if not found or not pa.is_vendor or not pa.active then
    raise exception 'ไม่พบผู้ขายรหัส %', coalesce(p->>'party_code', '(ว่าง)') using errcode = 'ACC04';
  end if;
  -- ผู้ขายไม่จด VAT เรียกเก็บภาษีไม่ได้ (เหมือนบันทึกซื้อ)
  if pa.vat_registered then
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

  insert into acc.purchase_orders (company_id, doc_no, doc_date, until_date, party_id, party_code, party_name, party_tax_id,
      party_branch_no, party_address, is_service, price_mode, vat_rate, gross, discount, base, vat, total, description,
      idem_key, created_by)
  values (p_company, acc.next_doc_no(p_company, 'PO'), v_date, v_until, pa.id, pa.code, pa.name, pa.tax_id, pa.branch_no,
      pa.address, v_svc, v_mode, v_rate, v_gross, v_disc, v_base, v_vat, v_total, coalesce(btrim(p->>'description'), ''),
      p_idem, app.current_user_id())
  returning id into v_id;
  insert into acc.purchase_order_lines (company_id, order_id, line_no, item_id, description, qty, unit, unit_price, amount)
  select p_company, v_id, (l->>'line_no')::int, nullif(l->>'item_id', '')::uuid, l->>'description', (l->>'qty')::numeric,
         l->>'unit', (l->>'unit_price')::numeric, (l->>'amount')::numeric
    from jsonb_array_elements(v_lines) l;
  return v_id;
end $$;

create function acc.cancel_purchase_order(p_company uuid, p_order uuid, p_reason text) returns void
language plpgsql security definer set search_path = acc, pg_temp as $$
declare o acc.purchase_orders;
begin
  if not app.can_write_company(p_company) then raise exception 'ไม่มีสิทธิ์' using errcode = '42501'; end if;
  select * into o from acc.purchase_orders where company_id = p_company and id = p_order for update;
  if not found then raise exception 'ไม่พบเอกสาร' using errcode = 'ACC04'; end if;
  if o.cancelled_at is not null then return; end if;
  if length(btrim(coalesce(p_reason, ''))) = 0 then raise exception 'ต้องระบุเหตุผลที่ยกเลิก' using errcode = '22023'; end if;
  if exists (select 1 from acc.purchase_order_receipts x join acc.purchase_documents d on d.company_id = x.company_id and d.id = x.document_id
              where x.company_id = p_company and x.order_id = o.id and d.voided_at is null)
     or exists (select 1 from acc.purchase_documents d where d.company_id = p_company and d.purchase_order_id = o.id and d.voided_at is null) then
    raise exception '% มีใบรับสินค้า/ใบซื้อ/เงินมัดจำอ้างอยู่ ยกเลิกเอกสารเหล่านั้นก่อน', o.doc_no using errcode = 'ACC16';
  end if;
  update acc.purchase_orders set cancelled_at = now(), cancel_reason = btrim(p_reason) where company_id = p_company and id = o.id;
end $$;

-- บันทึกจำนวนที่รับตามใบสั่งซื้อของเอกสาร p_doc (บรรทัดที่มี order_line_no) ไม่เกินที่สั่ง
create function acc.record_order_receipts(p_company uuid, p_order uuid, p_doc uuid, p_lines jsonb) returns void
language plpgsql security definer set search_path = acc, pg_temp as $$
declare o acc.purchase_orders; ol acc.purchase_order_lines; r record; v_qty numeric; v_done numeric;
begin
  select * into o from acc.purchase_orders where company_id = p_company and id = p_order;
  for r in select l.ord::int as ord, l.value as j from jsonb_array_elements(p_lines) with ordinality as l(value, ord)
            where nullif(l.value->>'order_line_no', '') is not null loop
    select * into ol from acc.purchase_order_lines where company_id = p_company and order_id = o.id and line_no = (r.j->>'order_line_no')::int;
    if not found then raise exception 'บรรทัดที่ %: ไม่พบบรรทัด % ในใบสั่งซื้อ %', r.ord, r.j->>'order_line_no', o.doc_no using errcode = 'ACC15'; end if;
    if exists (select 1 from acc.purchase_order_receipts where company_id = p_company and order_id = o.id and line_no = ol.line_no and document_id = p_doc) then
      raise exception 'บรรทัดที่ %: บรรทัด % ของใบสั่งซื้อ % ซ้ำในใบเดียวกัน', r.ord, ol.line_no, o.doc_no using errcode = 'ACC15';
    end if;
    v_qty := (r.j->>'qty')::numeric;
    v_done := acc.purchase_order_received(p_company, o.id, ol.line_no);
    if v_done + v_qty > ol.qty then
      raise exception 'บรรทัดที่ %: รับเกินจำนวนในใบสั่งซื้อ % (สั่ง % รับแล้ว %)', r.ord, o.doc_no, ol.qty, v_done using errcode = 'ACC15';
    end if;
    insert into acc.purchase_order_receipts (company_id, order_id, line_no, document_id, qty) values (p_company, o.id, ol.line_no, p_doc, v_qty);
  end loop;
end $$;

-- ตรวจใบสั่งซื้อที่อ้าง: ของผู้ขายรายเดียวกัน ยังไม่ยกเลิก (ล็อกกันรับเกินเมื่อกดพร้อมกัน)
create function acc.lock_purchase_order(p_company uuid, p_order uuid, p_party_code text) returns acc.purchase_orders
language plpgsql security definer set search_path = acc, pg_temp as $$
declare o acc.purchase_orders; pa acc.parties;
begin
  select * into o from acc.purchase_orders where company_id = p_company and id = p_order for update;
  select * into pa from acc.parties where company_id = p_company and code = upper(p_party_code);
  if o.id is null or pa.id is null or o.cancelled_at is not null or o.party_id <> pa.id then
    raise exception 'ต้องอ้างใบสั่งซื้อของผู้ขายรายเดียวกันที่ยังไม่ยกเลิก' using errcode = 'ACC15';
  end if;
  return o;
end $$;

-- ---- ใบรับสินค้า (GR): Dr บัญชีซื้อของสินค้า / Cr 2130 ตามราคาก่อนภาษีในใบส่งของ ----
-- p: {date, party_code, vendor_doc_no, order_id?, description?, lines: [{item_code, description?, qty, unit_price, order_line_no?}]}
create function acc.post_goods_receipt(p_company uuid, p jsonb, p_idem text) returns uuid
language plpgsql security definer set search_path = acc, pg_temp as $$
declare
  pa acc.parties; it acc.items; v_acc acc.chart_of_accounts; o acc.purchase_orders;
  v_id uuid; v_date date; v_vdoc text; v_lines jsonb := '[]'; v_gross numeric := 0;
  v_qty numeric; v_price numeric; v_amt numeric; v_je jsonb; v_eid uuid; r record;
begin
  if not app.can_write_company(p_company) then
    raise exception 'ไม่มีสิทธิ์บันทึกเอกสารในบริษัทนี้' using errcode = '42501';
  end if;
  select id into v_id from acc.purchase_documents where company_id = p_company and idem_key = p_idem;
  if found then return v_id; end if;
  perform acc.ensure_purchase_accounts(p_company);
  insert into acc.chart_of_accounts (company_id, code, name, type)
  values (p_company, '2130', 'สินค้ารับแล้วยังไม่ได้รับใบแจ้งหนี้', 'liability') on conflict (company_id, code) do nothing;
  begin v_date := (p->>'date')::date; exception when others then v_date := null; end;
  if v_date is null then raise exception 'ต้องมีวันที่เอกสาร' using errcode = '22023'; end if;
  v_vdoc := nullif(btrim(coalesce(p->>'vendor_doc_no', '')), '');
  if v_vdoc is null or length(v_vdoc) > 40 then
    raise exception 'ต้องใส่เลขที่ใบส่งของของผู้ขาย (ไม่เกิน 40 ตัว)' using errcode = '22023';
  end if;
  select * into pa from acc.parties where company_id = p_company and code = upper(p->>'party_code');
  if not found or not pa.is_vendor or not pa.active then
    raise exception 'ไม่พบผู้ขายรหัส %', coalesce(p->>'party_code', '(ว่าง)') using errcode = 'ACC04';
  end if;
  if nullif(p->>'order_id', '') is not null then
    o := acc.lock_purchase_order(p_company, (p->>'order_id')::uuid, pa.code);
  end if;
  if exists (select 1 from acc.purchase_documents x
              where x.company_id = p_company and x.party_id = pa.id and x.voided_at is null and x.kind = 'goods_receipt'
                and upper(btrim(x.vendor_doc_no)) = upper(v_vdoc)) then
    raise exception 'บันทึกใบส่งของเลขที่ % ของผู้ขายรายนี้ไปแล้ว', v_vdoc using errcode = 'ACC15';
  end if;
  if jsonb_typeof(p->'lines') is distinct from 'array' or jsonb_array_length(p->'lines') not between 1 and 200 then
    raise exception 'ต้องมีรายการ 1–200 บรรทัด' using errcode = '22023';
  end if;
  for r in select l.ord::int as ord, l.value as j from jsonb_array_elements(p->'lines') with ordinality as l(value, ord) loop
    select * into it from acc.items where company_id = p_company and code = upper(coalesce(r.j->>'item_code', '')) and active;
    if not found then raise exception 'บรรทัดที่ %: ใบรับสินค้าต้องเลือกสินค้าที่มีในทะเบียน', r.ord using errcode = 'ACC04'; end if;
    if it.is_service then raise exception 'บรรทัดที่ %: % เป็นบริการ ใบรับสินค้าใช้กับสินค้าเท่านั้น', r.ord, it.code using errcode = 'ACC15'; end if;
    begin
      v_qty := (r.j->>'qty')::numeric; v_price := (r.j->>'unit_price')::numeric;
    exception when others then raise exception 'บรรทัดที่ %: จำนวนหรือราคาไม่ถูกต้อง', r.ord using errcode = 'ACC05';
    end;
    if v_qty is null or v_qty <= 0 or v_qty <> round(v_qty, 3) or v_price is null or v_price <= 0 or v_price <> round(v_price, 2) then
      raise exception 'บรรทัดที่ %: จำนวนและราคาต้องมากกว่า 0 (จำนวนทศนิยมไม่เกิน 3 ราคาไม่เกิน 2)', r.ord using errcode = 'ACC05';
    end if;
    select * into v_acc from acc.chart_of_accounts
     where company_id = p_company and active
       and (type = 'expense' or (type = 'asset' and left(code, 2) in ('13', '15', '16')))
       and case when it.purchase_account_id is not null then id = it.purchase_account_id else code = '5110' end;
    if not found then raise exception 'บรรทัดที่ %: บัญชีซื้อของสินค้า % ไม่ได้เปิดใช้', r.ord, it.code using errcode = 'ACC04'; end if;
    v_amt := round(v_qty * v_price, 2);
    v_lines := v_lines || jsonb_build_object('line_no', r.ord, 'item_id', it.id,
      'description', coalesce(nullif(btrim(r.j->>'description'), ''), it.name), 'qty', v_qty, 'unit', it.unit,
      'unit_price', v_price, 'amount', v_amt, 'account_id', v_acc.id, 'account_code', v_acc.code);
    v_gross := v_gross + v_amt;
  end loop;

  select coalesce(jsonb_agg(jsonb_build_object('account_code', x.code, 'debit', x.amt::text, 'memo', pa.name) order by x.code), '[]') into v_je
    from (select l->>'account_code' as code, sum((l->>'amount')::numeric) as amt from jsonb_array_elements(v_lines) l group by 1) x;
  v_je := v_je || jsonb_build_object('account_code', '2130', 'credit', v_gross::text, 'memo', pa.name);
  v_eid := acc.post_journal(p_company, v_date,
    coalesce(nullif(btrim(p->>'description'), ''), 'รับสินค้า ' || pa.name || ' ใบส่งของ ' || v_vdoc), v_je, p_idem, 'GR', null);
  select id into v_id from acc.purchase_documents where company_id = p_company and entry_id = v_eid;
  if found then return v_id; end if;

  insert into acc.purchase_documents (company_id, kind, doc_no, doc_date, vendor_doc_no, party_id, party_code, party_name,
      party_tax_id, party_branch_no, party_address, is_service, vat_claimable, price_mode, vat_rate, gross, discount, base, vat,
      total, description, entry_id, idem_key, created_by, purchase_order_id)
  select p_company, 'goods_receipt', e.doc_no, v_date, v_vdoc, pa.id, pa.code, pa.name, pa.tax_id, pa.branch_no, pa.address,
         false, false, 'none', 0, v_gross, 0, v_gross, 0, v_gross, coalesce(btrim(p->>'description'), ''), v_eid, p_idem,
         app.current_user_id(), o.id
    from acc.journal_entries e where e.company_id = p_company and e.id = v_eid
  returning id into v_id;
  insert into acc.purchase_document_lines (company_id, document_id, line_no, item_id, description, qty, unit, unit_price, amount, account_id)
  select p_company, v_id, (l->>'line_no')::int, (l->>'item_id')::uuid, l->>'description', (l->>'qty')::numeric,
         l->>'unit', (l->>'unit_price')::numeric, (l->>'amount')::numeric, (l->>'account_id')::uuid
    from jsonb_array_elements(v_lines) l;
  if o.id is not null then perform acc.record_order_receipts(p_company, o.id, v_id, p->'lines'); end if;
  return v_id;
end $$;

-- ---- ใบเพิ่มหนี้จากผู้ขาย (PD) ต่อยอดบันทึกซื้อ · จ่ายชำระใบเพิ่มหนี้ได้ ----
-- แก้ฟังก์ชันเดิมทีละเงื่อนไข (ไม่คัดลอกทั้งฟังก์ชัน: คงส่วนที่ migration เช็คแก้ไว้)
do $$
declare
  r record;
  src text;
begin
  for r in select * from (values
    ($r$acc.post_purchase_document(uuid,text,jsonb,text)$r$, $r$if p_kind not in ('purchase_invoice', 'cash_purchase', 'purchase_credit_note') then$r$, $r$if p_kind not in ('purchase_invoice', 'cash_purchase', 'purchase_credit_note', 'purchase_debit_note') then$r$),
    ($r$acc.post_purchase_document(uuid,text,jsonb,text)$r$, $r$  if p_kind = 'purchase_credit_note' then
    select * into tgt$r$, $r$  if p_kind in ('purchase_credit_note', 'purchase_debit_note') then
    select * into tgt$r$),
    ($r$acc.post_purchase_document(uuid,text,jsonb,text)$r$, $r$raise exception 'ใบลดหนี้ต้องอ้างใบซื้อเชื่อที่ยังไม่ยกเลิก'$r$, $r$raise exception 'ใบลด/เพิ่มหนี้ต้องอ้างใบซื้อเชื่อที่ยังไม่ยกเลิก'$r$),
    ($r$acc.post_purchase_document(uuid,text,jsonb,text)$r$, $r$raise exception 'ใบลดหนี้ต้องระบุเหตุผล'$r$, $r$raise exception 'ใบลด/เพิ่มหนี้ต้องระบุเหตุผล'$r$),
    ($r$acc.post_purchase_document(uuid,text,jsonb,text)$r$, $r$                and (x.kind = 'purchase_credit_note') = (p_kind = 'purchase_credit_note')$r$, $r$                and acc.purchase_vendor_doc_group(x.kind) = acc.purchase_vendor_doc_group(p_kind)$r$),
    ($r$acc.post_purchase_document(uuid,text,jsonb,text)$r$, $r$                 when p_kind = 'purchase_credit_note' then id = v_ref_acc$r$, $r$                 when p_kind in ('purchase_credit_note', 'purchase_debit_note') and v_svc then id = v_ref_acc$r$),
    ($r$acc.post_purchase_document(uuid,text,jsonb,text)$r$, $r$  if p_kind = 'purchase_credit_note' then
    v_claim := tgt.vat_claimable and v_vat > 0;$r$, $r$  if p_kind = 'purchase_debit_note' then
    v_claim := tgt.vat_claimable and v_vat > 0;
  end if;
  if p_kind = 'purchase_credit_note' then
    v_claim := tgt.vat_claimable and v_vat > 0;$r$),
    ($r$acc.post_purchase_document(uuid,text,jsonb,text)$r$, $r$    else 'ลดหนี้ ' || tgt.doc_no || ' ' || pa.name || ' ' || v_vdoc end);$r$, $r$    when 'purchase_debit_note' then 'เพิ่มหนี้ ' || tgt.doc_no || ' ' || pa.name || ' ' || v_vdoc
    else 'ลดหนี้ ' || tgt.doc_no || ' ' || pa.name || ' ' || v_vdoc end);$r$),
    ($r$acc.post_purchase_document(uuid,text,jsonb,text)$r$, $r$v_prefix := case p_kind when 'purchase_invoice' then 'PI' when 'cash_purchase' then 'CP' else 'PN' end;$r$, $r$v_prefix := case p_kind when 'purchase_invoice' then 'PI' when 'cash_purchase' then 'CP' when 'purchase_debit_note' then 'PD' else 'PN' end;$r$),
    ($r$acc.post_purchase_document(uuid,text,jsonb,text)$r$, $r$case when v_svc and p_kind = 'purchase_invoice' then '1411' else '1410' end$r$, $r$case when v_svc and p_kind in ('purchase_invoice', 'purchase_debit_note') then '1411' else '1410' end$r$),
    ($r$acc.post_purchase_document(uuid,text,jsonb,text)$r$, $r$v_credit := case when p_kind = 'purchase_invoice' then$r$, $r$v_credit := case when p_kind in ('purchase_invoice', 'purchase_debit_note') then$r$),
    ($r$acc.post_payment(uuid,jsonb,text)$r$, $r$if not found or tgt.kind <> 'purchase_invoice' or tgt.voided_at$r$, $r$if not found or tgt.kind not in ('purchase_invoice', 'purchase_debit_note') or tgt.voided_at$r$),
    ($r$acc.post_payment(uuid,jsonb,text)$r$, $r$'จ่ายชำระได้เฉพาะใบซื้อเชื่อของผู้ขายรายนี้ที่ยังไม่ยกเลิก'$r$, $r$'จ่ายชำระได้เฉพาะใบซื้อเชื่อ/ใบเพิ่มหนี้ของผู้ขายรายนี้ที่ยังไม่ยกเลิก'$r$)
  ) v(fn, old_text, new_text) loop
    src := pg_get_functiondef(r.fn::regprocedure);
    if (length(src) - length(replace(src, r.old_text, ''))) / length(r.old_text) <> 1 then
      raise exception 'ข้อความที่จะแก้ใน % ไม่ตรงกับที่คาดไว้: %', r.fn, left(r.old_text, 60);
    end if;
    execute replace(src, r.old_text, r.new_text);
  end loop;
end $$;

-- ---- จ่ายเงินมัดจำ (VD): Dr 1520 (ฐาน) / Dr 1410 / Cr เงิน · ผู้ขายออกใบกำกับภาษีตอนรับมัดจำ ----
-- p: {date, party_code, vendor_doc_no, amount, price_mode?, is_service?, cash_account?, order_id?, description?}
create function acc.post_purchase_deposit(p_company uuid, p jsonb, p_idem text) returns uuid
language plpgsql security definer set search_path = acc, pg_temp as $$
declare
  co acc.companies; pa acc.parties; o acc.purchase_orders; v_cash acc.chart_of_accounts; a_dep acc.chart_of_accounts;
  v_id uuid; v_date date; v_vdoc text; v_mode text; v_rate numeric; v_svc boolean; v_amt numeric;
  v_base numeric; v_vat numeric; v_total numeric; v_claim boolean; v_je jsonb; v_eid uuid;
begin
  if not app.can_write_company(p_company) then raise exception 'ไม่มีสิทธิ์บันทึกเอกสารในบริษัทนี้' using errcode = '42501'; end if;
  select id into v_id from acc.purchase_documents where company_id = p_company and idem_key = p_idem;
  if found then return v_id; end if;
  perform acc.ensure_purchase_accounts(p_company);
  insert into acc.chart_of_accounts (company_id, code, name, type) values (p_company, '1520', 'เงินมัดจำจ่าย', 'asset')
  on conflict (company_id, code) do nothing;
  select * into a_dep from acc.chart_of_accounts where company_id = p_company and code = '1520';
  select * into co from acc.companies where id = p_company;
  begin
    v_date := (p->>'date')::date; v_amt := (p->>'amount')::numeric;
  exception when others then raise exception 'วันที่หรือจำนวนเงินไม่ถูกต้อง' using errcode = '22023';
  end;
  if v_date is null then raise exception 'ต้องมีวันที่เอกสาร' using errcode = '22023'; end if;
  if v_amt is null or v_amt <= 0 or v_amt <> round(v_amt, 2) then
    raise exception 'จำนวนเงินมัดจำต้องมากกว่า 0 ทศนิยมไม่เกิน 2 ตำแหน่ง' using errcode = 'ACC05';
  end if;
  v_vdoc := nullif(btrim(coalesce(p->>'vendor_doc_no', '')), '');
  if v_vdoc is null or length(v_vdoc) > 40 then
    raise exception 'ต้องใส่เลขที่ใบกำกับภาษี/ใบรับเงินมัดจำของผู้ขาย (ไม่เกิน 40 ตัว)' using errcode = '22023';
  end if;
  select * into pa from acc.parties where company_id = p_company and code = upper(p->>'party_code');
  if not found or not pa.is_vendor or not pa.active then
    raise exception 'ไม่พบผู้ขายรหัส %', coalesce(p->>'party_code', '(ว่าง)') using errcode = 'ACC04';
  end if;
  if nullif(p->>'order_id', '') is not null then
    o := acc.lock_purchase_order(p_company, (p->>'order_id')::uuid, pa.code);
  end if;
  if exists (select 1 from acc.purchase_documents x
              where x.company_id = p_company and x.party_id = pa.id and x.voided_at is null and x.kind = 'deposit'
                and upper(btrim(x.vendor_doc_no)) = upper(v_vdoc)) then
    raise exception 'บันทึกใบรับเงินมัดจำเลขที่ % ของผู้ขายรายนี้ไปแล้ว', v_vdoc using errcode = 'ACC15';
  end if;
  v_svc := coalesce((p->>'is_service')::boolean, o.is_service, false);
  if pa.vat_registered then
    v_mode := coalesce(nullif(p->>'price_mode', ''), o.price_mode, 'exclusive');
    if v_mode not in ('exclusive', 'inclusive') then raise exception 'แบบราคาต้องเป็นแยกภาษีหรือรวมภาษี' using errcode = '22023'; end if;
    v_rate := co.vat_rate;
  else
    v_mode := 'none'; v_rate := 0;
  end if;
  select c.base, c.vat, c.total into v_base, v_vat, v_total from app.vat_calc(v_amt, 0, v_rate, v_mode) c;
  v_claim := co.vat_registered and v_vat > 0; -- บริษัทไม่จด VAT: ภาษีรวมอยู่ในเงินมัดจำ
  select * into v_cash from acc.chart_of_accounts
   where company_id = p_company and code = coalesce(nullif(p->>'cash_account', ''), '1110') and active and type = 'asset' and code like '11%';
  if not found then raise exception 'บัญชีจ่ายเงินต้องเป็นบัญชีเงินสด/เงินฝาก (11xx)' using errcode = 'ACC04'; end if;

  v_je := jsonb_build_array(jsonb_build_object('account_code', '1520', 'debit', (case when v_claim then v_base else v_total end)::text, 'memo', pa.name));
  if v_claim then v_je := v_je || jsonb_build_object('account_code', '1410', 'debit', v_vat::text, 'memo', pa.name); end if;
  v_je := v_je || jsonb_build_object('account_code', v_cash.code, 'credit', v_total::text, 'memo', pa.name);
  v_eid := acc.post_journal(p_company, v_date,
    coalesce(nullif(btrim(p->>'description'), ''), 'จ่ายเงินมัดจำ ' || pa.name || coalesce(' ' || o.doc_no, '')), v_je, p_idem, 'VD', null);
  select id into v_id from acc.purchase_documents where company_id = p_company and entry_id = v_eid;
  if found then return v_id; end if;

  insert into acc.purchase_documents (company_id, kind, doc_no, doc_date, vendor_doc_no, party_id, party_code, party_name,
      party_tax_id, party_branch_no, party_address, is_service, vat_claimable, price_mode, vat_rate, gross, discount, base, vat,
      total, cash_account_id, description, entry_id, idem_key, created_by, purchase_order_id)
  select p_company, 'deposit', e.doc_no, v_date, v_vdoc, pa.id, pa.code, pa.name, pa.tax_id, pa.branch_no, pa.address,
         v_svc, v_claim, v_mode, v_rate, v_amt, 0, v_base, v_vat, v_total, v_cash.id, coalesce(btrim(p->>'description'), ''),
         v_eid, p_idem, app.current_user_id(), o.id
    from acc.journal_entries e where e.company_id = p_company and e.id = v_eid
  returning id into v_id;
  insert into acc.purchase_document_lines (company_id, document_id, line_no, description, qty, unit_price, amount, account_id)
  values (p_company, v_id, 1, 'เงินมัดจำ' || coalesce(' ตามใบสั่งซื้อ ' || o.doc_no, ''), 1, v_amt, v_amt, a_dep.id);
  return v_id;
end $$;

-- ---- หักเงินมัดจำในใบซื้อเชื่อ (VA): Dr 2110 / Cr 1520 / Cr ภาษีซื้อส่วนที่หัก ----
create function acc.apply_purchase_deposit(p_company uuid, p_invoice uuid, p_deposit uuid, p_amount numeric, p_idem text) returns uuid
language plpgsql security definer set search_path = acc, pg_temp as $$
declare
  inv acc.purchase_documents; dep acc.purchase_documents; a_dep acc.chart_of_accounts;
  v_rem numeric; v_rem_vat numeric; v_open numeric; v_vat numeric; v_je jsonb; v_eid uuid; v_id uuid;
begin
  select * into inv from acc.purchase_documents where company_id = p_company and id = p_invoice for update;
  select * into dep from acc.purchase_documents where company_id = p_company and id = p_deposit for update;
  if not found or dep.kind <> 'deposit' or dep.voided_at is not null or dep.party_id <> inv.party_id then
    raise exception 'หักได้เฉพาะเงินมัดจำของผู้ขายรายเดียวกันที่ยังไม่ยกเลิก' using errcode = 'ACC15';
  end if;
  if inv.kind <> 'purchase_invoice' or inv.voided_at is not null then
    raise exception 'หักเงินมัดจำได้ในใบซื้อเชื่อที่ยังไม่ยกเลิก' using errcode = 'ACC15';
  end if;
  if dep.doc_date > inv.doc_date then
    raise exception '% ลงวันที่หลังใบซื้อ หักไม่ได้', dep.doc_no using errcode = '22023';
  end if;
  if p_amount is null or p_amount <= 0 or p_amount <> round(p_amount, 2) then
    raise exception 'ยอดหักเงินมัดจำต้องมากกว่า 0 ทศนิยมไม่เกิน 2 ตำแหน่ง' using errcode = 'ACC05';
  end if;
  select amount, vat into v_rem, v_rem_vat from acc.purchase_deposit_remaining(p_company, dep.id);
  if p_amount > v_rem then
    raise exception '% เหลือ % หักเกินไม่ได้', dep.doc_no, to_char(v_rem, 'FM999,999,999,990.00') using errcode = 'ACC15';
  end if;
  select inv.total - s.amount into v_open from acc.purchase_settled(p_company, inv.id) s;
  if p_amount > v_open then
    raise exception 'หักเงินมัดจำ % เกินยอดค้างของ % (%)', to_char(p_amount, 'FM999,999,999,990.00'), inv.doc_no,
      to_char(v_open, 'FM999,999,999,990.00') using errcode = 'ACC15';
  end if;
  -- ภาษีตามสัดส่วน ครั้งที่หักหมดรับเศษ · มัดจำที่ขอคืนภาษีไม่ได้ไม่มีภาษีแยก
  v_vat := case when not dep.vat_claimable then 0 when p_amount = v_rem then v_rem_vat else round(dep.vat * p_amount / dep.total, 2) end;
  select * into a_dep from acc.chart_of_accounts where company_id = p_company and code = '1520';
  v_je := jsonb_build_array(jsonb_build_object('account_code', '2110', 'debit', p_amount::text, 'memo', inv.party_name),
                            jsonb_build_object('account_code', '1520', 'credit', (p_amount - v_vat)::text, 'memo', dep.doc_no));
  if v_vat > 0 then
    v_je := v_je || jsonb_build_object('account_code', case when inv.is_service and inv.vat_claimable then '1411' else '1410' end,
                                       'credit', v_vat::text, 'memo', dep.doc_no);
  end if;
  v_eid := acc.post_journal(p_company, inv.doc_date, 'หักเงินมัดจำ ' || dep.doc_no || ' ใน ' || inv.doc_no, v_je, p_idem, 'VA', null);

  insert into acc.purchase_documents (company_id, kind, doc_no, doc_date, party_id, party_code, party_name, party_tax_id,
      party_branch_no, party_address, is_service, vat_claimable, price_mode, vat_rate, gross, discount, base, vat, total,
      ref_document_id, description, entry_id, idem_key, created_by)
  select p_company, 'deposit_applied', e.doc_no, inv.doc_date, inv.party_id, inv.party_code, inv.party_name, inv.party_tax_id,
         inv.party_branch_no, inv.party_address, inv.is_service and inv.vat_claimable, v_vat > 0,
         case when v_vat > 0 then 'inclusive' else 'none' end, dep.vat_rate, p_amount, 0, p_amount - v_vat, v_vat, p_amount,
         dep.id, 'หักเงินมัดจำ ' || dep.doc_no || ' ใน ' || inv.doc_no, v_eid, p_idem, app.current_user_id()
    from acc.journal_entries e where e.company_id = p_company and e.id = v_eid
  returning id into v_id;
  insert into acc.purchase_document_lines (company_id, document_id, line_no, description, qty, unit_price, amount, account_id)
  values (p_company, v_id, 1, 'หักเงินมัดจำ ' || dep.doc_no, 1, p_amount, p_amount, a_dep.id);
  insert into acc.purchase_allocations (company_id, source_id, target_id, amount, vat_transfer)
  values (p_company, v_id, inv.id, p_amount, case when inv.is_service and inv.vat_claimable then v_vat else 0 end);
  return v_id;
end $$;

-- ---- ซื้อเชื่อ/ซื้อสด (ต่อยอด post_purchase_document): อ้างใบสั่งซื้อ · จับคู่ใบรับสินค้า · หักเงินมัดจำ ในธุรกรรมเดียว ----
-- p เหมือน post_purchase_document + {order_id?, lines[].order_line_no?, lines[].receipt_id?, lines[].receipt_line_no?,
--   deposits?: [{document_id, amount}]}
create function acc.post_purchase_ext(p_company uuid, p_kind text, p jsonb, p_idem text) returns uuid
language plpgsql security definer set search_path = acc, pg_temp as $$
declare
  o acc.purchase_orders; inv acc.purchase_documents; gr acc.purchase_documents; gl acc.purchase_document_lines;
  il acc.purchase_document_lines;
  v_id uuid; r record; v_qty numeric; v_done numeric; v_done_amt numeric; v_amt numeric;
  v_match jsonb := '[]'; v_je jsonb; v_eid uuid; v_total numeric;
begin
  if p_kind not in ('purchase_invoice', 'cash_purchase') then
    raise exception 'ไม่รู้จักประเภทเอกสาร %', p_kind using errcode = '22023';
  end if;
  select id into v_id from acc.purchase_documents where company_id = p_company and idem_key = p_idem;
  if found then return v_id; end if;
  if nullif(p->>'order_id', '') is not null then
    o := acc.lock_purchase_order(p_company, (p->>'order_id')::uuid, p->>'party_code');
  end if;
  if p_kind <> 'purchase_invoice' and jsonb_array_length(coalesce(p->'deposits', '[]')) > 0 then
    raise exception 'หักเงินมัดจำได้ในใบซื้อเชื่อเท่านั้น' using errcode = '22023';
  end if;
  v_id := acc.post_purchase_document(p_company, p_kind, p, p_idem);
  select * into inv from acc.purchase_documents where company_id = p_company and id = v_id;

  for r in select l.ord::int as ord, l.value as j from jsonb_array_elements(p->'lines') with ordinality as l(value, ord) loop
    if nullif(r.j->>'order_line_no', '') is not null and o.id is null then
      raise exception 'บรรทัดที่ %: อ้างบรรทัดใบสั่งซื้อแต่ไม่ได้เลือกใบสั่งซื้อ', r.ord using errcode = '22023';
    end if;
    continue when nullif(r.j->>'receipt_id', '') is null;
    if nullif(r.j->>'order_line_no', '') is not null then
      raise exception 'บรรทัดที่ %: บรรทัดจากใบรับสินค้านับรับตามใบสั่งซื้อไปแล้ว ไม่ต้องอ้างใบสั่งซื้อซ้ำ', r.ord using errcode = '22023';
    end if;
    select * into gr from acc.purchase_documents where company_id = p_company and id = (r.j->>'receipt_id')::uuid for update;
    if not found or gr.kind <> 'goods_receipt' or gr.voided_at is not null or gr.party_id <> inv.party_id then
      raise exception 'บรรทัดที่ %: ต้องอ้างใบรับสินค้าของผู้ขายรายเดียวกันที่ยังไม่ยกเลิก', r.ord using errcode = 'ACC15';
    end if;
    if gr.doc_date > inv.doc_date then
      raise exception 'บรรทัดที่ %: % ลงวันที่หลังใบซื้อ', r.ord, gr.doc_no using errcode = '22023';
    end if;
    select * into gl from acc.purchase_document_lines where company_id = p_company and document_id = gr.id and line_no = (r.j->>'receipt_line_no')::int;
    if not found then raise exception 'บรรทัดที่ %: ไม่พบบรรทัด % ใน %', r.ord, r.j->>'receipt_line_no', gr.doc_no using errcode = 'ACC15'; end if;
    select * into il from acc.purchase_document_lines where company_id = p_company and document_id = inv.id and line_no = r.ord;
    if il.item_id is distinct from gl.item_id then
      raise exception 'บรรทัดที่ %: สินค้าต้องตรงกับบรรทัด % ของ %', r.ord, gl.line_no, gr.doc_no using errcode = 'ACC15';
    end if;
    select qty, amount into v_done, v_done_amt from acc.receipt_line_invoiced(p_company, gr.id, gl.line_no);
    v_qty := il.qty;
    if v_done + v_qty > gl.qty then
      raise exception 'บรรทัดที่ %: เกินจำนวนที่รับใน % (รับ % ได้ใบแจ้งหนี้แล้ว %)', r.ord, gr.doc_no, gl.qty, v_done using errcode = 'ACC15';
    end if;
    -- มูลค่าตามใบรับสินค้าของส่วนที่จับคู่ ครั้งที่ครบจำนวนรับเศษที่เหลือ
    v_amt := case when v_done + v_qty = gl.qty then gl.amount - v_done_amt else round(gl.amount * v_qty / gl.qty, 2) end;
    insert into acc.purchase_receipt_matches (company_id, invoice_id, invoice_line_no, receipt_id, receipt_line_no, qty, amount)
    values (p_company, inv.id, r.ord, gr.id, gl.line_no, v_qty, v_amt);
    v_match := v_match || jsonb_build_object('account_id', gl.account_id, 'amount', v_amt, 'gr', gr.doc_no);
  end loop;

  if jsonb_array_length(v_match) > 0 then
    select sum((m->>'amount')::numeric) into v_total from jsonb_array_elements(v_match) m;
    if v_total > 0 then
      v_je := jsonb_build_array(jsonb_build_object('account_code', '2130', 'debit', v_total::text, 'memo', inv.party_name));
      select v_je || coalesce(jsonb_agg(jsonb_build_object('account_code', a.code, 'credit', x.amt::text, 'memo', inv.party_name) order by a.code), '[]')
        into v_je
        from (select (m->>'account_id')::uuid as aid, sum((m->>'amount')::numeric) as amt from jsonb_array_elements(v_match) m group by 1) x
        join acc.chart_of_accounts a on a.company_id = p_company and a.id = x.aid
       where x.amt > 0;
      v_eid := acc.post_journal(p_company, inv.doc_date,
        'ล้างสินค้ารับ ' || (select string_agg(distinct m->>'gr', ', ') from jsonb_array_elements(v_match) m) || ' ใน ' || inv.doc_no,
        v_je, p_idem || ':gm', 'GM', null);
      insert into acc.purchase_receipt_match_posts (company_id, invoice_id, entry_id) values (p_company, inv.id, v_eid);
    end if;
  end if;
  if o.id is not null then perform acc.record_order_receipts(p_company, o.id, inv.id, p->'lines'); end if;
  for r in select l.ord::int as ord, l.value as j from jsonb_array_elements(coalesce(p->'deposits', '[]')) with ordinality as l(value, ord) loop
    perform acc.apply_purchase_deposit(p_company, inv.id, (r.j->>'document_id')::uuid, (r.j->>'amount')::numeric, p_idem || ':va:' || r.ord);
  end loop;
  return v_id;
end $$;

-- ยกเลิกใบรับสินค้าไม่ได้เมื่อมีใบซื้ออ้าง · ยกเลิกใบซื้อ = กลับรายการล้างสินค้ารับ (GM)
create function acc.purchase_receipt_on_void() returns trigger
language plpgsql security definer set search_path = acc, pg_temp as $$
declare v_no text; mp acc.purchase_receipt_match_posts; v_date date;
begin
  if old.voided_at is not null or new.voided_at is null then return new; end if;
  if new.kind = 'goods_receipt' then
    select d.doc_no into v_no from acc.purchase_receipt_matches m join acc.purchase_documents d on d.company_id = m.company_id and d.id = m.invoice_id
     where m.company_id = new.company_id and m.receipt_id = new.id and d.voided_at is null and d.id <> new.id limit 1;
    if v_no is not null then
      raise exception '% มีใบซื้อ % อ้างอยู่ ยกเลิกใบซื้อก่อน', new.doc_no, v_no using errcode = 'ACC16';
    end if;
  end if;
  select * into mp from acc.purchase_receipt_match_posts where company_id = new.company_id and invoice_id = new.id;
  if found then
    select entry_date into v_date from acc.journal_entries where company_id = new.company_id and id = new.void_entry_id;
    perform acc.reverse_journal(new.company_id, mp.entry_id, coalesce(v_date, current_date), 'gm-void:' || new.id::text,
                                'ยกเลิก ' || new.doc_no);
  end if;
  return new;
end $$;
create trigger purchase_documents_receipt_void before update of voided_at on acc.purchase_documents
  for each row execute function acc.purchase_receipt_on_void();

-- ---- รับสินค้าเข้าคลัง: ใบรับสินค้าด้วย · บรรทัดของใบซื้อที่จับคู่ใบรับสินค้าไม่รับซ้ำ ----
create or replace function acc.receive_purchase_inventory() returns trigger
language plpgsql security definer set search_path = acc, pg_temp as $$
declare
  d acc.purchase_documents;
  r record;
  total_cost numeric := 0;
  je jsonb := '[]';
  eid uuid;
begin
  -- Deferred trigger เรียกครั้งละบรรทัดตอน commit; ประมวลผลทั้งเอกสารเพียงครั้งเดียว
  if exists (select 1 from acc.inventory_document_posts
             where company_id = new.company_id and source_kind = 'purchase_receipt' and source_id = new.document_id) then
    return null;
  end if;
  select * into d from acc.purchase_documents where company_id = new.company_id and id = new.document_id;
  if d.kind not in ('purchase_invoice', 'cash_purchase', 'goods_receipt') or d.is_service then return null; end if;
  -- สินค้าถูกล็อกตามลำดับเดียวกันเสมอเพื่อกันต้นทุนเฉลี่ยแข่งกัน
  perform 1 from acc.items i
   where i.company_id = d.company_id and i.track_inventory
     and exists (select 1 from acc.purchase_document_lines l where l.company_id = d.company_id and l.document_id = d.id and l.item_id = i.id)
   order by i.id for update;
  for r in
    select l.*, i.name as item_name, a.code as purchase_code, pc.cost
      from acc.purchase_document_lines l
      join acc.purchase_line_costs(d.company_id, d.id) pc on pc.line_no = l.line_no
      join acc.items i on i.company_id = l.company_id and i.id = l.item_id and i.track_inventory
      join acc.chart_of_accounts a on a.company_id = l.company_id and a.id = l.account_id
     where l.company_id = d.company_id and l.document_id = d.id
       and not exists (select 1 from acc.purchase_receipt_matches m
                        where m.company_id = l.company_id and m.invoice_id = l.document_id and m.invoice_line_no = l.line_no)
     order by l.line_no
  loop
    if r.cost <= 0 then raise exception 'มูลค่าสินค้าคงเหลือต้องมากกว่า 0' using errcode = 'ACC05'; end if;
    je := je || jsonb_build_array(
      jsonb_build_object('account_code', '1310', 'debit', r.cost::text, 'memo', r.item_name),
      jsonb_build_object('account_code', r.purchase_code, 'credit', r.cost::text, 'memo', r.item_name));
    total_cost := total_cost + r.cost;
  end loop;
  if total_cost = 0 then return null; end if;
  eid := acc.post_journal(d.company_id, d.doc_date, 'รับสินค้าเข้าคลัง ' || d.doc_no, je,
                          'inventory-purchase:' || d.id::text, 'IM', null);
  insert into acc.inventory_document_posts(company_id, source_kind, source_id, entry_id)
  values (d.company_id, 'purchase_receipt', d.id, eid);
  insert into acc.inventory_movements(company_id, item_id, movement_date, kind, quantity, unit_cost, value, entry_id, idem_key, reference, created_by)
  select d.company_id, i.id, d.doc_date, 'adjustment_in', l.qty, round(pc.cost / l.qty, 6), pc.cost, eid,
         'inventory-purchase:' || d.id::text || ':' || l.line_no::text, d.doc_no, d.created_by
    from acc.purchase_document_lines l join acc.purchase_line_costs(d.company_id, d.id) pc on pc.line_no = l.line_no
    join acc.items i on i.company_id = l.company_id and i.id = l.item_id and i.track_inventory
   where l.company_id = d.company_id and l.document_id = d.id
     and not exists (select 1 from acc.purchase_receipt_matches m
                      where m.company_id = l.company_id and m.invoice_id = l.document_id and m.invoice_line_no = l.line_no)
   order by l.line_no;
  return null;
end $$;

-- ---- รายงานภาษีซื้อ: มัดจำ (สินค้า/บริการ) เป็นรายการบวก · หักมัดจำในใบซื้อสินค้าเป็นรายการลบ ----
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
                when d.kind = 'deposit_applied' then (select t.vendor_doc_no from acc.purchase_documents t
                                                       where t.company_id = d.company_id and t.id = d.ref_document_id)
                else d.vendor_doc_no end,
           d.kind, d.party_name, d.party_tax_id, d.party_branch_no,
           case when d.kind in ('purchase_credit_note', 'deposit_applied') then -1 else 1 end,
           case when d.kind = 'payment' then (select coalesce(sum(a.amount - a.vat_transfer), 0) from acc.purchase_allocations a
                                               join acc.purchase_documents t on t.company_id = a.company_id and t.id = a.target_id
                                              where a.company_id = d.company_id and a.source_id = d.id and t.is_service and t.vat_claimable)
                else d.base end,
           d.vat, d.void_entry_id
      from acc.purchase_documents d
     where p_side = 'purchases' and d.company_id = p_company and d.vat_claimable and d.vat > 0
       and (d.kind in ('cash_purchase', 'payment', 'deposit') or not d.is_service)
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

revoke all on function acc.save_purchase_order(uuid, jsonb, text), acc.cancel_purchase_order(uuid, uuid, text),
  acc.record_order_receipts(uuid, uuid, uuid, jsonb), acc.lock_purchase_order(uuid, uuid, text),
  acc.post_goods_receipt(uuid, jsonb, text), acc.post_purchase_deposit(uuid, jsonb, text),
  acc.apply_purchase_deposit(uuid, uuid, uuid, numeric, text), acc.post_purchase_ext(uuid, text, jsonb, text),
  acc.purchase_receipt_on_void() from public;
grant execute on function acc.save_purchase_order(uuid, jsonb, text), acc.cancel_purchase_order(uuid, uuid, text),
  acc.post_goods_receipt(uuid, jsonb, text), acc.post_purchase_deposit(uuid, jsonb, text),
  acc.post_purchase_ext(uuid, text, jsonb, text) to app_rw;
grant execute on function acc.purchase_order_received(uuid, uuid, int), acc.receipt_line_invoiced(uuid, uuid, int),
  acc.purchase_deposit_remaining(uuid, uuid), acc.purchase_vendor_doc_group(text) to app_rw, app_ro;

-- migrate:down
drop trigger purchase_documents_receipt_void on acc.purchase_documents;
drop function acc.purchase_receipt_on_void(), acc.post_purchase_ext(uuid, text, jsonb, text),
  acc.apply_purchase_deposit(uuid, uuid, uuid, numeric, text), acc.post_purchase_deposit(uuid, jsonb, text),
  acc.post_goods_receipt(uuid, jsonb, text), acc.lock_purchase_order(uuid, uuid, text),
  acc.record_order_receipts(uuid, uuid, uuid, jsonb), acc.cancel_purchase_order(uuid, uuid, text),
  acc.save_purchase_order(uuid, jsonb, text), acc.purchase_deposit_remaining(uuid, uuid),
  acc.receipt_line_invoiced(uuid, uuid, int), acc.purchase_order_received(uuid, uuid, int);
-- คืนนิยามเดิม (ไม่มีเอกสารชนิดใหม่ก่อน migration นี้)
do $$
declare
  r record;
  src text;
begin
  for r in select * from (values
    ($r$acc.post_purchase_document(uuid,text,jsonb,text)$r$, $r$if p_kind not in ('purchase_invoice', 'cash_purchase', 'purchase_credit_note', 'purchase_debit_note') then$r$, $r$if p_kind not in ('purchase_invoice', 'cash_purchase', 'purchase_credit_note') then$r$),
    ($r$acc.post_purchase_document(uuid,text,jsonb,text)$r$, $r$  if p_kind in ('purchase_credit_note', 'purchase_debit_note') then
    select * into tgt$r$, $r$  if p_kind = 'purchase_credit_note' then
    select * into tgt$r$),
    ($r$acc.post_purchase_document(uuid,text,jsonb,text)$r$, $r$raise exception 'ใบลด/เพิ่มหนี้ต้องอ้างใบซื้อเชื่อที่ยังไม่ยกเลิก'$r$, $r$raise exception 'ใบลดหนี้ต้องอ้างใบซื้อเชื่อที่ยังไม่ยกเลิก'$r$),
    ($r$acc.post_purchase_document(uuid,text,jsonb,text)$r$, $r$raise exception 'ใบลด/เพิ่มหนี้ต้องระบุเหตุผล'$r$, $r$raise exception 'ใบลดหนี้ต้องระบุเหตุผล'$r$),
    ($r$acc.post_purchase_document(uuid,text,jsonb,text)$r$, $r$                and acc.purchase_vendor_doc_group(x.kind) = acc.purchase_vendor_doc_group(p_kind)$r$, $r$                and (x.kind = 'purchase_credit_note') = (p_kind = 'purchase_credit_note')$r$),
    ($r$acc.post_purchase_document(uuid,text,jsonb,text)$r$, $r$                 when p_kind in ('purchase_credit_note', 'purchase_debit_note') and v_svc then id = v_ref_acc$r$, $r$                 when p_kind = 'purchase_credit_note' then id = v_ref_acc$r$),
    ($r$acc.post_purchase_document(uuid,text,jsonb,text)$r$, $r$  if p_kind = 'purchase_debit_note' then
    v_claim := tgt.vat_claimable and v_vat > 0;
  end if;
  if p_kind = 'purchase_credit_note' then
    v_claim := tgt.vat_claimable and v_vat > 0;$r$, $r$  if p_kind = 'purchase_credit_note' then
    v_claim := tgt.vat_claimable and v_vat > 0;$r$),
    ($r$acc.post_purchase_document(uuid,text,jsonb,text)$r$, $r$    when 'purchase_debit_note' then 'เพิ่มหนี้ ' || tgt.doc_no || ' ' || pa.name || ' ' || v_vdoc
    else 'ลดหนี้ ' || tgt.doc_no || ' ' || pa.name || ' ' || v_vdoc end);$r$, $r$    else 'ลดหนี้ ' || tgt.doc_no || ' ' || pa.name || ' ' || v_vdoc end);$r$),
    ($r$acc.post_purchase_document(uuid,text,jsonb,text)$r$, $r$v_prefix := case p_kind when 'purchase_invoice' then 'PI' when 'cash_purchase' then 'CP' when 'purchase_debit_note' then 'PD' else 'PN' end;$r$, $r$v_prefix := case p_kind when 'purchase_invoice' then 'PI' when 'cash_purchase' then 'CP' else 'PN' end;$r$),
    ($r$acc.post_purchase_document(uuid,text,jsonb,text)$r$, $r$case when v_svc and p_kind in ('purchase_invoice', 'purchase_debit_note') then '1411' else '1410' end$r$, $r$case when v_svc and p_kind = 'purchase_invoice' then '1411' else '1410' end$r$),
    ($r$acc.post_purchase_document(uuid,text,jsonb,text)$r$, $r$v_credit := case when p_kind in ('purchase_invoice', 'purchase_debit_note') then$r$, $r$v_credit := case when p_kind = 'purchase_invoice' then$r$),
    ($r$acc.post_payment(uuid,jsonb,text)$r$, $r$if not found or tgt.kind not in ('purchase_invoice', 'purchase_debit_note') or tgt.voided_at$r$, $r$if not found or tgt.kind <> 'purchase_invoice' or tgt.voided_at$r$),
    ($r$acc.post_payment(uuid,jsonb,text)$r$, $r$'จ่ายชำระได้เฉพาะใบซื้อเชื่อ/ใบเพิ่มหนี้ของผู้ขายรายนี้ที่ยังไม่ยกเลิก'$r$, $r$'จ่ายชำระได้เฉพาะใบซื้อเชื่อของผู้ขายรายนี้ที่ยังไม่ยกเลิก'$r$)
  ) v(fn, old_text, new_text) loop
    src := pg_get_functiondef(r.fn::regprocedure);
    if (length(src) - length(replace(src, r.old_text, ''))) / length(r.old_text) <> 1 then
      raise exception 'ข้อความที่จะแก้ใน % ไม่ตรงกับที่คาดไว้: %', r.fn, left(r.old_text, 60);
    end if;
    execute replace(src, r.old_text, r.new_text);
  end loop;
end $$;

create or replace function acc.ap_open_items(p_company uuid)
returns table (document_id uuid, doc_no text, vendor_doc_no text, doc_date date, due_date date, party_code text, party_name text,
               is_service boolean, total numeric, settled numeric, open numeric, undue_vat numeric)
language sql stable set search_path = acc, app, public, pg_temp as $$
  select d.id, d.doc_no, d.vendor_doc_no, d.doc_date, d.due_date, d.party_code, d.party_name, d.is_service, d.total,
         s.amount, d.total - s.amount, case when d.is_service and d.vat_claimable then d.vat - s.vat else 0 end
    from acc.purchase_documents d cross join lateral acc.purchase_settled(d.company_id, d.id) s
   where d.company_id = p_company and d.kind = 'purchase_invoice' and d.voided_at is null
     and d.total - s.amount > 0
   order by d.due_date, d.doc_no
$$;

CREATE OR REPLACE FUNCTION acc.receive_purchase_inventory()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'acc', 'pg_temp'
AS $function$
declare
  d acc.purchase_documents;
  r record;
  total_cost numeric := 0;
  je jsonb := '[]';
  eid uuid;
begin
  -- Deferred trigger เรียกครั้งละบรรทัดตอน commit; ประมวลผลทั้งเอกสารเพียงครั้งเดียว
  if exists (select 1 from acc.inventory_document_posts
             where company_id = new.company_id and source_kind = 'purchase_receipt' and source_id = new.document_id) then
    return null;
  end if;
  select * into d from acc.purchase_documents
   where company_id = new.company_id and id = new.document_id;
  if d.kind not in ('purchase_invoice', 'cash_purchase') or d.is_service then return null; end if;
  -- สินค้าถูกล็อกตามลำดับเดียวกันเสมอเพื่อกันต้นทุนเฉลี่ยแข่งกัน
  perform 1 from acc.items i
   where i.company_id = d.company_id and i.track_inventory
     and exists (select 1 from acc.purchase_document_lines l where l.company_id = d.company_id and l.document_id = d.id and l.item_id = i.id)
   order by i.id for update;
  for r in
    select l.*, i.code as item_code, i.name as item_name, a.code as purchase_code,
           pc.cost
      from acc.purchase_document_lines l
      join acc.purchase_line_costs(d.company_id, d.id) pc on pc.line_no = l.line_no
      join acc.items i on i.company_id = l.company_id and i.id = l.item_id and i.track_inventory
      join acc.chart_of_accounts a on a.company_id = l.company_id and a.id = l.account_id
     where l.company_id = d.company_id and l.document_id = d.id
     order by l.line_no
  loop
    if r.cost <= 0 then raise exception 'มูลค่าสินค้าคงเหลือต้องมากกว่า 0' using errcode = 'ACC05'; end if;
    je := je || jsonb_build_array(
      jsonb_build_object('account_code', '1310', 'debit', r.cost::text, 'memo', r.item_name),
      jsonb_build_object('account_code', r.purchase_code, 'credit', r.cost::text, 'memo', r.item_name)
    );
    total_cost := total_cost + r.cost;
  end loop;
  if total_cost = 0 then return null; end if;
  eid := acc.post_journal(d.company_id, d.doc_date, 'รับสินค้าเข้าคลัง ' || d.doc_no, je,
                          'inventory-purchase:' || d.id::text, 'IM', null);
  insert into acc.inventory_document_posts(company_id, source_kind, source_id, entry_id)
  values (d.company_id, 'purchase_receipt', d.id, eid);
  for r in
    select l.*, i.id as stock_item_id,
           pc.cost
      from acc.purchase_document_lines l join acc.purchase_line_costs(d.company_id, d.id) pc on pc.line_no = l.line_no
      join acc.items i on i.company_id = l.company_id and i.id = l.item_id and i.track_inventory
     where l.company_id = d.company_id and l.document_id = d.id order by l.line_no
  loop
    insert into acc.inventory_movements(company_id, item_id, movement_date, kind, quantity, unit_cost, value, entry_id, idem_key, reference, created_by)
    values (d.company_id, r.stock_item_id, d.doc_date, 'adjustment_in', r.qty, round(r.cost / r.qty, 6), r.cost, eid,
            'inventory-purchase:' || d.id::text || ':' || r.line_no::text, d.doc_no, d.created_by);
  end loop;
  return null;
end $function$;

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

drop table acc.purchase_receipt_match_posts, acc.purchase_receipt_matches, acc.purchase_order_receipts;
alter table acc.purchase_documents drop constraint purchase_documents_order_fk, drop column purchase_order_id;
drop table acc.purchase_order_lines, acc.purchase_orders;
drop index acc.purchase_documents_vendor_doc;
create unique index purchase_documents_vendor_doc on acc.purchase_documents
  (company_id, party_id, (kind = 'purchase_credit_note'), upper(btrim(vendor_doc_no)))
  where voided_at is null and kind <> 'payment';
drop function acc.purchase_vendor_doc_group(text);
alter table acc.purchase_documents drop constraint purchase_documents_vendor_doc_required;
alter table acc.purchase_documents add constraint purchase_documents_check4 check ((kind = 'payment') = (vendor_doc_no is null));
alter table acc.purchase_documents drop constraint purchase_documents_kind_check;
alter table acc.purchase_documents add constraint purchase_documents_kind_check
  check (kind in ('purchase_invoice', 'cash_purchase', 'purchase_credit_note', 'payment'));
