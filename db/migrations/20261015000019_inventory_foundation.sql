-- migrate:up
-- เฟส 3.1 สินค้าคงเหลือ: ฐาน stock card และปรับปรุงสต็อกแบบ perpetual / moving average

alter table acc.items add column track_inventory boolean not null default false;
alter table acc.items add constraint items_inventory_not_service
  check (not track_inventory or not is_service);
grant update (name, unit, is_service, track_inventory, sale_price, purchase_price, sales_account_id, purchase_account_id,
              active, version) on acc.items to app_rw;

-- การเคลื่อนไหวเป็นสมุดย่อยที่แก้และลบไม่ได้ quantity/value มีเครื่องหมายตามทิศทาง
create table acc.inventory_movements (
  id            uuid not null default gen_random_uuid(),
  company_id    uuid not null references acc.companies(id),
  item_id       uuid not null,
  movement_date date not null,
  kind          text not null check (kind in ('opening', 'adjustment_in', 'adjustment_out')),
  quantity      numeric(14,3) not null check (quantity <> 0),
  unit_cost     numeric(18,6) not null check (unit_cost >= 0),
  value         numeric(18,2) not null,
  entry_id      uuid not null,
  idem_key      text not null,
  reference     text not null default '' check (length(reference) <= 300),
  created_by    uuid not null references acc.users(id),
  created_at    timestamptz not null default now(),
  primary key (company_id, id),
  unique (company_id, idem_key),
  foreign key (company_id, item_id) references acc.items(company_id, id),
  foreign key (company_id, entry_id) references acc.journal_entries(company_id, id),
  check (value = round(quantity * unit_cost, 2))
);
create index inventory_movements_card on acc.inventory_movements(company_id, item_id, movement_date, created_at);

create trigger inventory_movements_immutable before update or delete on acc.inventory_movements
  for each row execute function acc.forbid_mutation();
create trigger inventory_movements_locked before insert on acc.inventory_movements
  for each row execute function acc.guard_locked_company();
create trigger audit_inventory_movements after insert on acc.inventory_movements
  for each row execute function acc.audit_row();

alter table acc.inventory_movements enable row level security;
grant select on acc.inventory_movements to app_rw, app_ro;
create policy inventory_movements_read on acc.inventory_movements for select to app_rw, app_ro
  using (app.can_read_company(company_id));

-- ยอดและต้นทุนเฉลี่ย ณ ปัจจุบัน; เก็บจาก movement เสมอ จึงไม่เกิดยอดค้างจากการอัปเดตสองตาราง
create function acc.inventory_balance(p_company uuid, p_item uuid,
  out quantity numeric, out value numeric, out unit_cost numeric)
language sql stable as $$
  select coalesce(sum(m.quantity), 0), coalesce(sum(m.value), 0),
         case when coalesce(sum(m.quantity), 0) = 0 then 0
              else round(coalesce(sum(m.value), 0) / sum(m.quantity), 6) end
    from acc.inventory_movements m
   where m.company_id = p_company and m.item_id = p_item
$$;
grant execute on function acc.inventory_balance(uuid, uuid) to app_rw, app_ro;

-- บัตรสต็อก: ยอดคงเหลือหลังทุกรายการ ใช้เป็นแหล่งข้อมูลเดียวกับหน้ารายงาน
create function acc.inventory_card(p_company uuid, p_item uuid)
returns table (movement_date date, kind text, quantity_in numeric, quantity_out numeric,
               unit_cost numeric, value_in numeric, value_out numeric, balance_qty numeric, balance_value numeric)
language sql stable as $$
  select m.movement_date, m.kind,
         case when m.quantity > 0 then m.quantity else 0 end,
         case when m.quantity < 0 then -m.quantity else 0 end,
         m.unit_cost,
         case when m.value > 0 then m.value else 0 end,
         case when m.value < 0 then -m.value else 0 end,
         sum(m.quantity) over w,
         sum(m.value) over w
    from acc.inventory_movements m
   where m.company_id = p_company and m.item_id = p_item
  window w as (order by m.movement_date, m.created_at, m.id rows between unbounded preceding and current row)
   order by m.movement_date, m.created_at, m.id
$$;
grant execute on function acc.inventory_card(uuid, uuid) to app_rw, app_ro;

-- ปรับยอดเปิดหรือผลตรวจนับ: ล็อกแถวสินค้าเพื่อให้คำนวณต้นทุนเฉลี่ยและยอดคงเหลือพร้อมกันได้ถูกต้อง
create function acc.post_inventory_adjustment(
  p_company uuid, p_item_code text, p_date date, p_quantity numeric, p_unit_cost numeric,
  p_offset_account_code text, p_description text, p_idem text
) returns uuid
language plpgsql security definer set search_path = acc, pg_temp as $$
declare
  it acc.items;
  inv acc.chart_of_accounts;
  off acc.chart_of_accounts;
  old_qty numeric;
  old_value numeric;
  avg_cost numeric;
  use_cost numeric;
  amount numeric;
  lines jsonb;
  eid uuid;
  mid uuid;
begin
  if not app.can_write_company(p_company) then
    raise exception 'ไม่มีสิทธิ์ปรับสต็อกในบริษัทนี้' using errcode = '42501';
  end if;
  select id into mid from acc.inventory_movements where company_id = p_company and idem_key = p_idem;
  if found then return mid; end if;
  if p_date is null or p_quantity = 0 or p_quantity <> round(p_quantity, 3) then
    raise exception 'วันที่และจำนวนสต็อกไม่ถูกต้อง' using errcode = 'ACC05';
  end if;
  select * into it from acc.items where company_id = p_company and code = upper(p_item_code) for update;
  if not found or not it.active or not it.track_inventory then
    raise exception 'ไม่พบสินค้าคงเหลือรหัส %', coalesce(p_item_code, '(ว่าง)') using errcode = 'ACC04';
  end if;
  select * into inv from acc.chart_of_accounts where company_id = p_company and code = '1310' and active;
  select * into off from acc.chart_of_accounts where company_id = p_company and code = p_offset_account_code and active;
  if not found or off.code = inv.code then
    raise exception 'บัญชีคู่ปรับสต็อกไม่ถูกต้อง' using errcode = 'ACC04';
  end if;
  select quantity, value into old_qty, old_value from acc.inventory_balance(p_company, it.id);
  if p_quantity < 0 and old_qty + p_quantity < 0 then
    raise exception 'จำนวนสินค้าคงเหลือไม่พอ (คงเหลือ %)', old_qty using errcode = 'ACC15';
  end if;
  if p_quantity > 0 then
    if p_unit_cost is null or p_unit_cost <= 0 or p_unit_cost <> round(p_unit_cost, 6) then
      raise exception 'รับสินค้าเข้าต้องมีต้นทุนต่อหน่วยมากกว่า 0 ทศนิยมไม่เกิน 6 ตำแหน่ง' using errcode = 'ACC05';
    end if;
    use_cost := p_unit_cost;
  else
    avg_cost := case when old_qty = 0 then 0 else old_value / old_qty end;
    use_cost := round(avg_cost, 6);
  end if;
  amount := round(abs(p_quantity) * use_cost, 2);
  if amount <= 0 then raise exception 'มูลค่าสต็อกต้องมากกว่า 0' using errcode = 'ACC05'; end if;
  lines := case when p_quantity > 0 then jsonb_build_array(
    jsonb_build_object('account_code', '1310', 'debit', amount::text),
    jsonb_build_object('account_code', off.code, 'credit', amount::text)
  ) else jsonb_build_array(
    jsonb_build_object('account_code', off.code, 'debit', amount::text),
    jsonb_build_object('account_code', '1310', 'credit', amount::text)
  ) end;
  eid := acc.post_journal(p_company, p_date, coalesce(nullif(btrim(p_description), ''), 'ปรับสต็อก ' || it.name),
                          lines, p_idem, 'IA', null);
  insert into acc.inventory_movements(company_id, item_id, movement_date, kind, quantity, unit_cost, value, entry_id, idem_key, reference, created_by)
  values (p_company, it.id, p_date, case when p_quantity > 0 then 'adjustment_in' else 'adjustment_out' end,
          p_quantity, use_cost, case when p_quantity > 0 then amount else -amount end, eid, p_idem,
          coalesce(p_description, ''), app.current_user_id())
  returning id into mid;
  return mid;
end $$;
grant execute on function acc.post_inventory_adjustment(uuid, text, date, numeric, numeric, text, text, text) to app_rw;

-- migrate:down
drop function acc.post_inventory_adjustment(uuid, text, date, numeric, numeric, text, text, text);
drop function acc.inventory_card(uuid, uuid);
drop function acc.inventory_balance(uuid, uuid);
drop table acc.inventory_movements;
alter table acc.items drop constraint items_inventory_not_service;
alter table acc.items drop column track_inventory;
