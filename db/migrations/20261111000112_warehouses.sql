-- migrate:up
-- หลายคลัง + โอนย้ายระหว่างคลัง (docs/phase5-spec.md ข้อ 8, docs/assumptions.md ข้อ 47)
-- ต้นทุนคิดรวมทั้งบริษัทต่อสินค้า (ถัวเฉลี่ย/FIFO เดิม ไม่เปลี่ยน) คลังติดตามเฉพาะจำนวน
-- บรรทัดบัตรสต็อกและเอกสารขาย/ซื้อรู้คลังจากค่าที่ API ตั้งในทรานแซกชัน (acc.warehouse) ไม่ตั้ง = คลังหลัก
-- โอนย้ายไม่ลงบัญชี (ยังอยู่ใน 1310 มูลค่าเท่าเดิม) เก็บแยกใน acc.inventory_transfers

create table acc.warehouses (
  id         uuid not null default gen_random_uuid(),
  company_id uuid not null references acc.companies(id),
  code       text not null check (code ~ '^[A-Z0-9-]{1,20}$'),
  name       text not null check (length(btrim(name)) between 1 and 100),
  is_main    boolean not null default false,
  active     boolean not null default true,
  version    int not null default 1,
  created_at timestamptz not null default now(),
  primary key (company_id, id),
  unique (company_id, code),
  check (not is_main or active)
);
create unique index warehouses_main on acc.warehouses (company_id) where is_main;
create trigger warehouses_version before update on acc.warehouses for each row execute function acc.enforce_version();
create trigger warehouses_locked before insert or update on acc.warehouses for each row execute function acc.guard_locked_company();
create trigger audit_warehouses after insert or update on acc.warehouses for each row execute function acc.audit_row();
alter table acc.warehouses enable row level security;
grant select on acc.warehouses to app_rw, app_ro;
create policy warehouses_read on acc.warehouses for select to app_rw, app_ro using (company_id in (select app.readable_company_ids()));

-- คลังหลักของบริษัท (สร้างเมื่อใช้ครั้งแรก) · บรรทัดที่ไม่ระบุคลัง = คลังหลัก
create function acc.main_warehouse(p_company uuid) returns uuid
language plpgsql security definer set search_path = acc, pg_temp as $$
declare v uuid;
begin
  select id into v from acc.warehouses where company_id = p_company and is_main;
  if not found then
    insert into acc.warehouses (company_id, code, name, is_main) values (p_company, 'MAIN', 'คลังหลัก', true)
    on conflict (company_id, code) do nothing;
    select id into v from acc.warehouses where company_id = p_company and is_main;
    if v is null then
      raise exception 'มีรหัสคลัง MAIN ที่ไม่ใช่คลังหลักอยู่แล้ว' using errcode = 'ACC15';
    end if;
  end if;
  return v;
end $$;

-- คลังที่ API เลือกไว้ในทรานแซกชันนี้ (ไม่มี = คลังหลัก) ต้องเป็นคลังที่เปิดใช้ของบริษัทนี้
create function acc.current_warehouse(p_company uuid) returns uuid
language plpgsql security definer set search_path = acc, pg_temp as $$
declare v uuid := nullif(current_setting('acc.warehouse', true), '')::uuid;
begin
  if v is null then return acc.main_warehouse(p_company); end if;
  if not exists (select 1 from acc.warehouses where company_id = p_company and id = v and active) then
    raise exception 'คลังที่เลือกไม่มีหรือปิดใช้แล้ว' using errcode = 'ACC04';
  end if;
  return v;
end $$;

alter table acc.inventory_movements add column warehouse_id uuid;
alter table acc.inventory_movements add constraint inventory_movements_warehouse_fk
  foreign key (company_id, warehouse_id) references acc.warehouses (company_id, id);
alter table acc.documents add column warehouse_id uuid;
alter table acc.documents add constraint documents_warehouse_fk foreign key (company_id, warehouse_id) references acc.warehouses (company_id, id);
alter table acc.purchase_documents add column warehouse_id uuid;
alter table acc.purchase_documents add constraint purchase_documents_warehouse_fk
  foreign key (company_id, warehouse_id) references acc.warehouses (company_id, id);

-- บรรทัดบัตรสต็อก: ยกเลิก = คลังเดิม · ตัดต้นทุน/รับเข้าตามเอกสาร = คลังของเอกสาร · อื่น ๆ = คลังที่เลือกในทรานแซกชัน
create function acc.inventory_movement_warehouse() returns trigger
language plpgsql security definer set search_path = acc, pg_temp as $$
begin
  if new.warehouse_id is not null then return new; end if;
  if new.idem_key like '%:void' then
    select o.warehouse_id into new.warehouse_id from acc.inventory_movements o
     where o.company_id = new.company_id and o.idem_key = left(new.idem_key, -5);
  end if;
  if new.warehouse_id is null then
    select coalesce(
      (select d.warehouse_id from acc.inventory_document_posts p join acc.documents d on d.company_id = p.company_id and d.id = p.source_id
        where p.company_id = new.company_id and p.entry_id = new.entry_id and p.source_kind in ('sales_cogs', 'sales_return')),
      (select d.warehouse_id from acc.inventory_document_posts p join acc.purchase_documents d on d.company_id = p.company_id and d.id = p.source_id
        where p.company_id = new.company_id and p.entry_id = new.entry_id and p.source_kind in ('purchase_receipt', 'purchase_return')))
      into new.warehouse_id;
  end if;
  if new.warehouse_id is null then new.warehouse_id := acc.current_warehouse(new.company_id); end if;
  return new;
end $$;
create trigger inventory_movements_warehouse before insert on acc.inventory_movements
  for each row execute function acc.inventory_movement_warehouse();

-- เอกสารขาย/ซื้อจำคลังที่เลือก (ใบลด/เพิ่มหนี้ = คลังของใบที่อ้าง)
create function acc.document_warehouse() returns trigger
language plpgsql security definer set search_path = acc, pg_temp as $$
begin
  if new.warehouse_id is not null then return new; end if;
  if new.ref_document_id is not null and nullif(current_setting('acc.warehouse', true), '') is null then
    if tg_table_name = 'documents' then
      select warehouse_id into new.warehouse_id from acc.documents where company_id = new.company_id and id = new.ref_document_id;
    else
      select warehouse_id into new.warehouse_id from acc.purchase_documents where company_id = new.company_id and id = new.ref_document_id;
    end if;
  end if;
  if new.warehouse_id is null then new.warehouse_id := acc.current_warehouse(new.company_id); end if;
  return new;
end $$;
create trigger documents_warehouse before insert on acc.documents for each row execute function acc.document_warehouse();
create trigger purchase_documents_warehouse before insert on acc.purchase_documents for each row execute function acc.document_warehouse();

-- ---- โอนย้ายระหว่างคลัง (TR) ไม่ลงบัญชี ----
create table acc.inventory_transfers (
  id            uuid not null default gen_random_uuid(),
  company_id    uuid not null references acc.companies(id),
  doc_no        text not null,
  doc_date      date not null,
  from_id       uuid not null,
  to_id         uuid not null,
  description   text not null default '' check (length(description) <= 300),
  idem_key      text not null,
  created_by    uuid not null references acc.users(id),
  created_at    timestamptz not null default now(),
  cancelled_at  timestamptz,
  cancel_reason text check (length(cancel_reason) <= 300),
  primary key (company_id, id),
  unique (company_id, doc_no),
  unique (company_id, idem_key),
  foreign key (company_id, from_id) references acc.warehouses (company_id, id),
  foreign key (company_id, to_id) references acc.warehouses (company_id, id),
  check (from_id <> to_id),
  check ((cancelled_at is null) = (cancel_reason is null))
);
create table acc.inventory_transfer_lines (
  company_id  uuid not null,
  transfer_id uuid not null,
  line_no     int not null check (line_no between 1 and 200),
  item_id     uuid not null,
  qty         numeric(14,3) not null check (qty > 0),
  primary key (company_id, transfer_id, line_no),
  unique (company_id, transfer_id, item_id),
  foreign key (company_id, transfer_id) references acc.inventory_transfers (company_id, id),
  foreign key (company_id, item_id) references acc.items (company_id, id)
);
create trigger inventory_transfers_guard before update or delete on acc.inventory_transfers for each row execute function acc.guard_cancel_only();
create trigger inventory_transfer_lines_immutable before update or delete on acc.inventory_transfer_lines for each row execute function acc.forbid_mutation();
create trigger inventory_transfers_locked before insert or update on acc.inventory_transfers for each row execute function acc.guard_locked_company();
create trigger audit_inventory_transfers after insert or update on acc.inventory_transfers for each row execute function acc.audit_row();
alter table acc.inventory_transfers enable row level security;
alter table acc.inventory_transfer_lines enable row level security;
grant select on acc.inventory_transfers, acc.inventory_transfer_lines to app_rw, app_ro;
create policy inventory_transfers_read on acc.inventory_transfers for select to app_rw, app_ro using (company_id in (select app.readable_company_ids()));
create policy inventory_transfer_lines_read on acc.inventory_transfer_lines for select to app_rw, app_ro using (company_id in (select app.readable_company_ids()));

-- ความเคลื่อนไหวรายคลัง: บรรทัดบัตรสต็อก (ไม่นับที่ยกเลิก) + โอนออก/โอนเข้า (ไม่นับที่ยกเลิก)
create function acc.warehouse_movements(p_company uuid, p_item uuid)
returns table (warehouse_id uuid, movement_date date, quantity numeric, seq timestamptz, reference text)
language sql stable security definer set search_path = acc, pg_temp as $$
  select coalesce(m.warehouse_id, acc.main_warehouse(p_company)), m.movement_date, m.quantity, m.created_at, m.reference
    from acc.inventory_movements m   -- view inventory_movements_effective สร้างก่อนมีคอลัมน์คลัง: ใช้เงื่อนไข live เดียวกัน
   where m.company_id = p_company and m.item_id = p_item
     and not (m.idem_key like '%:void' or exists (
       select 1 from acc.inventory_movements v where v.company_id = m.company_id and v.idem_key = m.idem_key || ':void'))
  union all
  select x.wh, t.doc_date, x.q, t.created_at, t.doc_no
    from acc.inventory_transfers t
    join acc.inventory_transfer_lines l on l.company_id = t.company_id and l.transfer_id = t.id
    cross join lateral (values (t.from_id, -l.qty), (t.to_id, l.qty)) x(wh, q)
   where t.company_id = p_company and l.item_id = p_item and t.cancelled_at is null
$$;

-- คงเหลือรายคลัง ณ สิ้นวันใด ๆ ต้องไม่ติดลบ (เรียงตามวันที่ รายการวันเดียวกันนับรวมทั้งวัน)
create function acc.check_warehouse_stock(p_company uuid, p_item uuid) returns void
language plpgsql security definer set search_path = acc, pg_temp as $$
declare r record;
begin
  select w.code, w.name, i.name as item_name, x.d, x.bal into r
    from (select wm.warehouse_id, wm.movement_date as d,
                 sum(sum(wm.quantity)) over (partition by wm.warehouse_id order by wm.movement_date) as bal
            from acc.warehouse_movements(p_company, p_item) wm group by wm.warehouse_id, wm.movement_date) x
    join acc.warehouses w on w.company_id = p_company and w.id = x.warehouse_id
    join acc.items i on i.company_id = p_company and i.id = p_item
   where x.bal < 0 order by x.d limit 1;
  if found then
    raise exception 'สินค้า % ใน % (%) คงเหลือ ณ สิ้นวันที่ % ติดลบ (%) ตรวจคลังที่เลือกหรือโอนย้ายก่อน',
      r.item_name, r.name, r.code, acc.thai_date(r.d), r.bal using errcode = 'ACC15';
  end if;
end $$;

create function acc.check_warehouse_stock_movement() returns trigger
language plpgsql security definer set search_path = acc, pg_temp as $$
begin
  perform acc.check_warehouse_stock(new.company_id, new.item_id);
  return null;
end $$;
create constraint trigger inventory_movements_warehouse_stock after insert on acc.inventory_movements
  deferrable initially deferred for each row execute function acc.check_warehouse_stock_movement();

create function acc.check_warehouse_stock_transfer() returns trigger
language plpgsql security definer set search_path = acc, pg_temp as $$
declare l record;
begin
  for l in select item_id from acc.inventory_transfer_lines where company_id = new.company_id and transfer_id = new.id loop
    perform acc.check_warehouse_stock(new.company_id, l.item_id);
  end loop;
  return null;
end $$;
create constraint trigger inventory_transfers_stock after insert or update of cancelled_at on acc.inventory_transfers
  deferrable initially deferred for each row execute function acc.check_warehouse_stock_transfer();

-- p: {date, from, to, description?, lines: [{item_code, qty}]}
create function acc.post_inventory_transfer(p_company uuid, p jsonb, p_idem text) returns uuid
language plpgsql security definer set search_path = acc, pg_temp as $$
declare
  v_id uuid; v_date date; wf acc.warehouses; wt acc.warehouses; it acc.items; v_qty numeric; r record;
begin
  if not app.can_write_company(p_company) then raise exception 'ไม่มีสิทธิ์บันทึกเอกสารในบริษัทนี้' using errcode = '42501'; end if;
  if p_idem is null or length(p_idem) < 8 then raise exception 'ต้องมี idempotency key' using errcode = 'ACC03'; end if;
  perform pg_advisory_xact_lock(hashtextextended('inventory-transfer:' || p_company::text, 0));
  select id into v_id from acc.inventory_transfers where company_id = p_company and idem_key = p_idem;
  if found then return v_id; end if;
  perform acc.main_warehouse(p_company);
  begin v_date := (p->>'date')::date; exception when others then v_date := null; end;
  if v_date is null then raise exception 'ต้องมีวันที่เอกสาร' using errcode = '22023'; end if;
  if exists (select 1 from acc.periods where company_id = p_company and v_date between start_date and end_date and closed) then
    raise exception 'งวด % ปิดแล้ว ลงรายการไม่ได้', to_char(v_date, 'YYYY-MM') using errcode = 'ACC02';
  end if;
  select * into wf from acc.warehouses where company_id = p_company and code = upper(p->>'from') and active;
  select * into wt from acc.warehouses where company_id = p_company and code = upper(p->>'to') and active;
  if wf.id is null or wt.id is null then raise exception 'ไม่พบคลังต้นทางหรือปลายทางที่เปิดใช้' using errcode = 'ACC04'; end if;
  if wf.id = wt.id then raise exception 'คลังต้นทางและปลายทางต้องต่างกัน' using errcode = '22023'; end if;
  if jsonb_typeof(p->'lines') is distinct from 'array' or jsonb_array_length(p->'lines') not between 1 and 200 then
    raise exception 'ต้องมีรายการ 1–200 บรรทัด' using errcode = '22023';
  end if;
  insert into acc.inventory_transfers (company_id, doc_no, doc_date, from_id, to_id, description, idem_key, created_by)
  values (p_company, acc.next_doc_no(p_company, 'TR'), v_date, wf.id, wt.id, coalesce(btrim(p->>'description'), ''), p_idem, app.current_user_id())
  returning id into v_id;
  for r in select l.ord::int as ord, l.value as j from jsonb_array_elements(p->'lines') with ordinality as l(value, ord) loop
    select * into it from acc.items where company_id = p_company and code = upper(coalesce(r.j->>'item_code', '')) and track_inventory;
    if not found then raise exception 'บรรทัดที่ %: ไม่พบสินค้าที่ติดตามสต็อกรหัส %', r.ord, r.j->>'item_code' using errcode = 'ACC04'; end if;
    begin v_qty := (r.j->>'qty')::numeric; exception when others then v_qty := null; end;
    if v_qty is null or v_qty <= 0 or v_qty <> round(v_qty, 3) then
      raise exception 'บรรทัดที่ %: จำนวนต้องมากกว่า 0 ทศนิยมไม่เกิน 3 ตำแหน่ง', r.ord using errcode = 'ACC05';
    end if;
    if exists (select 1 from acc.inventory_transfer_lines where company_id = p_company and transfer_id = v_id and item_id = it.id) then
      raise exception 'บรรทัดที่ %: สินค้า % ซ้ำ รวมเป็นบรรทัดเดียว', r.ord, it.code using errcode = '22023';
    end if;
    insert into acc.inventory_transfer_lines (company_id, transfer_id, line_no, item_id, qty) values (p_company, v_id, r.ord, it.id, v_qty);
  end loop;
  return v_id;
end $$;

create function acc.cancel_inventory_transfer(p_company uuid, p_transfer uuid, p_reason text) returns void
language plpgsql security definer set search_path = acc, pg_temp as $$
declare t acc.inventory_transfers;
begin
  if not app.can_write_company(p_company) then raise exception 'ไม่มีสิทธิ์' using errcode = '42501'; end if;
  select * into t from acc.inventory_transfers where company_id = p_company and id = p_transfer for update;
  if not found then raise exception 'ไม่พบเอกสาร' using errcode = 'ACC04'; end if;
  if t.cancelled_at is not null then return; end if;
  if length(btrim(coalesce(p_reason, ''))) = 0 then raise exception 'ต้องระบุเหตุผลที่ยกเลิก' using errcode = '22023'; end if;
  update acc.inventory_transfers set cancelled_at = now(), cancel_reason = btrim(p_reason) where company_id = p_company and id = t.id;
end $$;

-- คลัง: เพิ่ม / แก้ชื่อ / ปิดใช้ (คลังหลักปิดไม่ได้ · ปิดได้เมื่อไม่มีของเหลือ)
create function acc.save_warehouse(p_company uuid, p_code text, p_name text, p_active boolean) returns uuid
language plpgsql security definer set search_path = acc, pg_temp as $$
declare w acc.warehouses; v_id uuid;
begin
  if not app.can_write_company(p_company) then raise exception 'ไม่มีสิทธิ์แก้บริษัทนี้' using errcode = '42501'; end if;
  perform acc.main_warehouse(p_company);
  select * into w from acc.warehouses where company_id = p_company and code = upper(p_code) for update;
  if not found then
    if upper(coalesce(p_code, '')) !~ '^[A-Z0-9-]{1,20}$' then raise exception 'รหัสคลังใช้ A–Z 0–9 - ไม่เกิน 20 ตัว' using errcode = '22023'; end if;
    if length(btrim(coalesce(p_name, ''))) = 0 then raise exception 'ต้องมีชื่อคลัง' using errcode = '22023'; end if;
    insert into acc.warehouses (company_id, code, name) values (p_company, upper(p_code), btrim(p_name)) returning id into v_id;
    return v_id;
  end if;
  if p_active is false and w.active then
    if w.is_main then raise exception 'คลังหลักปิดใช้ไม่ได้' using errcode = 'ACC15'; end if;
    if exists (select 1 from acc.items i cross join lateral acc.warehouse_movements(p_company, i.id) m
                where i.company_id = p_company and i.track_inventory and m.warehouse_id = w.id
                group by i.id having sum(m.quantity) <> 0) then
      raise exception '% ยังมีสินค้าคงเหลือ โอนย้ายออกก่อนปิดใช้', w.name using errcode = 'ACC15';
    end if;
  end if;
  update acc.warehouses set name = coalesce(nullif(btrim(p_name), ''), name), active = coalesce(p_active, active), version = version + 1
   where company_id = p_company and id = w.id;
  return w.id;
end $$;

revoke all on function acc.main_warehouse(uuid), acc.current_warehouse(uuid), acc.check_warehouse_stock(uuid, uuid),
  acc.post_inventory_transfer(uuid, jsonb, text), acc.cancel_inventory_transfer(uuid, uuid, text),
  acc.save_warehouse(uuid, text, text, boolean), acc.warehouse_movements(uuid, uuid) from public;
grant execute on function acc.post_inventory_transfer(uuid, jsonb, text), acc.cancel_inventory_transfer(uuid, uuid, text),
  acc.save_warehouse(uuid, text, text, boolean) to app_rw;
grant execute on function acc.warehouse_movements(uuid, uuid) to app_rw, app_ro;

-- migrate:down
drop function acc.save_warehouse(uuid, text, text, boolean), acc.cancel_inventory_transfer(uuid, uuid, text),
  acc.post_inventory_transfer(uuid, jsonb, text);
drop trigger inventory_transfers_stock on acc.inventory_transfers;
drop trigger inventory_movements_warehouse_stock on acc.inventory_movements;
drop function acc.check_warehouse_stock_transfer(), acc.check_warehouse_stock_movement(), acc.check_warehouse_stock(uuid, uuid),
  acc.warehouse_movements(uuid, uuid);
drop table acc.inventory_transfer_lines, acc.inventory_transfers;
drop trigger documents_warehouse on acc.documents;
drop trigger purchase_documents_warehouse on acc.purchase_documents;
drop trigger inventory_movements_warehouse on acc.inventory_movements;
drop function acc.document_warehouse(), acc.inventory_movement_warehouse();
alter table acc.purchase_documents drop constraint purchase_documents_warehouse_fk, drop column warehouse_id;
alter table acc.documents drop constraint documents_warehouse_fk, drop column warehouse_id;
alter table acc.inventory_movements drop constraint inventory_movements_warehouse_fk, drop column warehouse_id;
drop function acc.current_warehouse(uuid), acc.main_warehouse(uuid);
drop table acc.warehouses;
