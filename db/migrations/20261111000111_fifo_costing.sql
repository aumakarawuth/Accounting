-- migrate:up
-- ต้นทุนสินค้าแบบเข้าก่อนออกก่อน (FIFO) คู่กับถัวเฉลี่ยเคลื่อนที่ (docs/phase5-spec.md ข้อ 7, docs/assumptions.md ข้อ 46)
-- เลือกได้ทั้งบริษัท (ตั้งต้นถัวเฉลี่ย) และรายสินค้า (ทับค่าของบริษัท) เปลี่ยนได้เมื่อยังไม่มีความเคลื่อนไหวในบัตรสต็อก
-- FIFO ใช้ชั้นต้นทุนตามลำดับวันที่เดียวกับการคำนวณใหม่ (migration 104): ลงย้อนวันที่/ยกเลิก → คำนวณต้นทุนรายการหลังจากนั้นใหม่

alter table acc.companies add column inventory_method text not null default 'average' check (inventory_method in ('average', 'fifo'));
alter table acc.items add column cost_method text check (cost_method in ('average', 'fifo'));
grant update (cost_method) on acc.items to app_rw;

create function acc.item_cost_method(p_company uuid, p_item uuid) returns text
language sql stable set search_path = acc, pg_temp as $$
  select coalesce(i.cost_method, c.inventory_method)
    from acc.items i join acc.companies c on c.id = i.company_id
   where i.company_id = p_company and i.id = p_item
$$;

-- เปลี่ยนวิธีของสินค้าที่มีความเคลื่อนไหวแล้วไม่ได้ (ต้นทุนเดิมคิดด้วยอีกวิธี)
create function acc.guard_item_cost_method() returns trigger
language plpgsql set search_path = acc, pg_temp as $$
begin
  if new.cost_method is distinct from old.cost_method
     and exists (select 1 from acc.inventory_movements m where m.company_id = new.company_id and m.item_id = new.id) then
    raise exception 'สินค้า % มีความเคลื่อนไหวในบัตรสต็อกแล้ว เปลี่ยนวิธีคิดต้นทุนไม่ได้', new.code using errcode = 'ACC15';
  end if;
  return new;
end $$;
create trigger items_cost_method_guard before update of cost_method on acc.items
  for each row execute function acc.guard_item_cost_method();

-- วิธีตั้งต้นของบริษัท: เปลี่ยนได้เมื่อยังไม่มีความเคลื่อนไหวของสินค้าที่ใช้วิธีของบริษัท
create function acc.set_inventory_method(p_company uuid, p_method text) returns void
language plpgsql security definer set search_path = acc, pg_temp as $$
begin
  if not app.can_write_company(p_company) then raise exception 'ไม่มีสิทธิ์แก้บริษัทนี้' using errcode = '42501'; end if;
  if p_method not in ('average', 'fifo') then raise exception 'วิธีคิดต้นทุนต้องเป็นถัวเฉลี่ยหรือ FIFO' using errcode = '22023'; end if;
  if exists (select 1 from acc.inventory_movements m join acc.items i on i.company_id = m.company_id and i.id = m.item_id
              where m.company_id = p_company and i.cost_method is null) then
    raise exception 'มีสินค้าที่ใช้วิธีของบริษัทเคลื่อนไหวในบัตรสต็อกแล้ว เปลี่ยนวิธีตั้งต้นไม่ได้ (ตั้งรายสินค้าได้กับสินค้าที่ยังไม่เคลื่อนไหว)'
      using errcode = 'ACC15';
  end if;
  update acc.companies set inventory_method = p_method, version = version + 1 where id = p_company and inventory_method <> p_method;
end $$;

-- เดินบัตรสต็อกตามลำดับวันที่แบบ FIFO (เฉพาะรายการที่ไม่ยกเลิก ถึงวันที่ p_until ถ้าระบุ)
-- vals: id บรรทัด → [มูลค่าใหม่, ต้นทุนต่อหน่วยใหม่] · ขาย/ตัดออกจากการปรับสต็อก = ชั้นเก่าสุดก่อน
-- รับคืนจากลูกค้า = ชั้นใหม่ตามต้นทุนต่อหน่วยของใบขายที่อ้าง · ซื้อ/รับเข้า/ยกมา = ชั้นใหม่ตามมูลค่าเอกสาร
-- ส่งคืนผู้ขาย = ตัดจำนวนจากชั้นเก่าสุด มูลค่าตามเอกสาร ส่วนต่างกับมูลค่าชั้นที่ตัดปรับเข้าชั้นเก่าสุดที่เหลือ
-- take_value: มูลค่าถ้าตัดออกอีก p_take หน่วยต่อท้าย · layers: ชั้นที่เหลือ [{date, qty, value}]
create function acc.fifo_walk(p_company uuid, p_item uuid, p_until date, p_take numeric,
  out vals jsonb, out take_value numeric, out layers jsonb)
language plpgsql stable security definer set search_path = acc, pg_temp as $$
declare
  it acc.items; m record;
  lq numeric[] := '{}'; lv numeric[] := '{}'; ld date[] := '{}';
  h int := 1; q numeric := 0; pend numeric := 0;
  nv numeric; nu numeric; need numeric; got numeric; part numeric; ref uuid;
begin
  vals := '{}';
  select * into it from acc.items where company_id = p_company and id = p_item;
  for m in
    select x.*, p.source_kind, p.source_id, j.doc_prefix
      from acc.inventory_movements_effective x
      join acc.journal_entries j on j.company_id = x.company_id and j.id = x.entry_id
      left join acc.inventory_document_posts p on p.company_id = x.company_id and p.entry_id = x.entry_id
     where x.company_id = p_company and x.item_id = p_item and x.live and (p_until is null or x.movement_date <= p_until)
     order by x.movement_date, x.created_at, x.id
  loop
    if m.quantity < 0 then
      if q < -m.quantity then
        raise exception 'สินค้า % คงเหลือ ณ วันที่ % มี % ไม่พอตัดออก % ตาม % (เรียงตามวันที่)',
          it.name, acc.thai_date(m.movement_date), q, -m.quantity, m.reference using errcode = 'ACC15';
      end if;
      need := -m.quantity; got := 0;
      while need > 0 loop
        if lq[h] <= need then
          got := got + lv[h]; need := need - lq[h]; lq[h] := 0; lv[h] := 0; h := h + 1;
        else
          part := round(lv[h] * need / lq[h], 2);
          got := got + part; lv[h] := lv[h] - part; lq[h] := lq[h] - need; need := 0;
        end if;
      end loop;
      q := q + m.quantity;
      if m.source_kind = 'sales_cogs' or (m.source_kind is null and m.doc_prefix = 'IA') then
        if q = 0 then got := got + pend; pend := 0; end if;   -- ตัดหมด = มูลค่าที่เหลือทั้งหมด
        nv := -got; nu := round(got / -m.quantity, 6);
      else
        nv := m.eff_value; nu := m.eff_unit_cost;
        if q > 0 then lv[h] := lv[h] + got + nv; else pend := pend + got + nv; end if;
      end if;
    else
      if m.source_kind = 'sales_return' then
        select mv.id into ref
          from acc.documents cn
          join acc.inventory_document_posts sp on sp.company_id = cn.company_id and sp.source_kind = 'sales_cogs' and sp.source_id = cn.ref_document_id
          join acc.inventory_movements mv on mv.company_id = sp.company_id and mv.entry_id = sp.entry_id and mv.item_id = p_item and mv.quantity < 0
         where cn.company_id = p_company and cn.id = m.source_id
         order by mv.created_at limit 1;
        nu := coalesce((vals->ref::text->>1)::numeric,
                       (select x.eff_unit_cost from acc.inventory_movements_effective x where x.company_id = p_company and x.id = ref), m.eff_unit_cost);
        nv := round(m.quantity * nu, 2);
      else
        nv := m.eff_value; nu := m.eff_unit_cost;
      end if;
      lq := lq || m.quantity; lv := lv || (nv + pend); ld := ld || m.movement_date; pend := 0;
      q := q + m.quantity;
    end if;
    vals := vals || jsonb_build_object(m.id::text, jsonb_build_array(nv, nu));
  end loop;

  if p_take is not null then
    if q < p_take then
      raise exception 'สินค้า % คงเหลือ ณ วันที่ % มี % ไม่พอ', it.name, acc.thai_date(p_until), q using errcode = 'ACC15';
    end if;
    need := p_take; got := 0;
    while need > 0 loop
      if lq[h] <= need then
        got := got + lv[h]; need := need - lq[h]; lq[h] := 0; lv[h] := 0; h := h + 1;
      else
        part := round(lv[h] * need / lq[h], 2);
        got := got + part; lv[h] := lv[h] - part; lq[h] := lq[h] - need; need := 0;
      end if;
    end loop;
    q := q - p_take;
    if q = 0 then got := got + pend; pend := 0; end if;
    take_value := got;
  end if;

  layers := '[]';
  for i in h .. coalesce(array_length(lq, 1), 0) loop
    if lq[i] > 0 then
      layers := layers || jsonb_build_object('date', ld[i], 'qty', lq[i], 'value', lv[i] + case when jsonb_array_length(layers) = 0 then pend else 0 end);
    end if;
  end loop;
end $$;
revoke all on function acc.fifo_walk(uuid, uuid, date, numeric) from public;
grant execute on function acc.fifo_walk(uuid, uuid, date, numeric) to app_rw, app_ro;

-- มูลค่าตัดออก p_qty หน่วย ณ วันที่ ตามวิธีของสินค้า (ถัวเฉลี่ย: สูตรเดิม · FIFO: ชั้นเก่าสุดก่อน)
create function acc.inventory_out_value(p_company uuid, p_item uuid, p_date date, p_qty numeric,
  out value numeric, out unit_cost numeric)
language plpgsql stable security definer set search_path = acc, pg_temp as $$
declare b record;
begin
  if acc.item_cost_method(p_company, p_item) = 'fifo' then
    select w.take_value into value from acc.fifo_walk(p_company, p_item, p_date, p_qty) w;
    unit_cost := round(value / p_qty, 6);
  else
    select * into b from acc.inventory_balance_at(p_company, p_item, p_date);
    value := case when p_qty = b.quantity then b.value else round(p_qty * b.unit_cost, 2) end;
    unit_cost := b.unit_cost;
  end if;
end $$;
revoke all on function acc.inventory_out_value(uuid, uuid, date, numeric) from public;

grant execute on function acc.item_cost_method(uuid, uuid) to app_rw, app_ro;
grant execute on function acc.set_inventory_method(uuid, text) to app_rw;
revoke all on function acc.set_inventory_method(uuid, text) from public;

-- ตัดต้นทุนขาย / ปรับสต็อกตัดออก / คำนวณใหม่: ใช้วิธีของสินค้า (แก้จากนิยามปัจจุบันใน migration 104)
CREATE OR REPLACE FUNCTION acc.post_sales_inventory_cogs()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'acc', 'pg_temp'
AS $function$
declare
  d acc.documents;
  r record;
  b record;
  cost numeric;
  ucost numeric;
  total_cost numeric := 0;
  je jsonb := '[]';
  eid uuid;
begin
  if exists (select 1 from acc.inventory_document_posts
             where company_id = new.company_id and source_kind = 'sales_cogs' and source_id = new.document_id) then
    return null;
  end if;
  select * into d from acc.documents where company_id = new.company_id and id = new.document_id;
  if d.kind not in ('sales_invoice', 'cash_sale') or d.is_service then return null; end if;
  perform 1 from acc.items i where i.company_id = d.company_id and i.track_inventory
    and exists (select 1 from acc.document_lines l where l.company_id=d.company_id and l.document_id=d.id and l.item_id=i.id)
    order by i.id for update;
  if exists (
    select 1 from acc.document_lines l join acc.items i on i.company_id=l.company_id and i.id=l.item_id and i.track_inventory
     where l.company_id=d.company_id and l.document_id=d.id group by l.item_id having count(*) > 1
  ) then
    raise exception 'สินค้าคงเหลือรหัสเดียวกันต้องรวมเป็นหนึ่งบรรทัดต่อใบขาย' using errcode = 'ACC15';
  end if;
  for r in select l.*, i.id stock_item_id, i.name item_name from acc.document_lines l
             join acc.items i on i.company_id=l.company_id and i.id=l.item_id and i.track_inventory
            where l.company_id=d.company_id and l.document_id=d.id order by l.line_no
  loop
    select * into b from acc.inventory_balance_at(d.company_id, r.stock_item_id, d.doc_date);
    if b.quantity < r.qty then
      raise exception 'สินค้า % คงเหลือ ณ วันที่ % มี % ไม่พอสำหรับขาย %', r.item_name, acc.thai_date(d.doc_date), b.quantity, r.qty using errcode = 'ACC15';
    end if;
    select o.value, o.unit_cost into cost, ucost from acc.inventory_out_value(d.company_id, r.stock_item_id, d.doc_date, r.qty) o; -- ถัวเฉลี่ย/FIFO ตามสินค้า
    if cost <= 0 then raise exception 'สินค้า % ไม่มีต้นทุนคงเหลือ', r.item_name using errcode = 'ACC15'; end if;
    total_cost := total_cost + cost;
    je := je || jsonb_build_array(jsonb_build_object('account_code','5130','debit',cost::text,'memo',r.item_name),
                                  jsonb_build_object('account_code','1310','credit',cost::text,'memo',r.item_name));
  end loop;
  if total_cost = 0 then return null; end if;
  eid := acc.post_journal(d.company_id, d.doc_date, 'ตัดต้นทุนขาย ' || d.doc_no, je,
                          'inventory-sales:' || d.id::text, 'CG', null);
  insert into acc.inventory_document_posts(company_id,source_kind,source_id,entry_id)
  values(d.company_id,'sales_cogs',d.id,eid);
  for r in select l.*, i.id stock_item_id from acc.document_lines l join acc.items i
             on i.company_id=l.company_id and i.id=l.item_id and i.track_inventory
            where l.company_id=d.company_id and l.document_id=d.id order by l.line_no
  loop
    select * into b from acc.inventory_balance_at(d.company_id, r.stock_item_id, d.doc_date);
    -- balance หลังตรวจด้านบนยังเป็นก่อนตัดของแต่ละสินค้า (หนึ่งบรรทัดต่อสินค้าตาม UI ปัจจุบัน)
    select o.value, o.unit_cost into cost, ucost from acc.inventory_out_value(d.company_id, r.stock_item_id, d.doc_date, r.qty) o; -- ถัวเฉลี่ย/FIFO ตามสินค้า
    insert into acc.inventory_movements(company_id,item_id,movement_date,kind,quantity,unit_cost,value,entry_id,idem_key,reference,created_by)
    values(d.company_id,r.stock_item_id,d.doc_date,'adjustment_out',-r.qty,ucost,-cost,eid,
           'inventory-sales:' || d.id::text || ':' || r.line_no::text,d.doc_no,d.created_by);
  end loop;
  return null;
end $function$;

CREATE OR REPLACE FUNCTION acc.post_inventory_adjustment(p_company uuid, p_item_code text, p_date date, p_quantity numeric, p_unit_cost numeric, p_offset_account_code text, p_description text, p_idem text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'acc', 'pg_temp'
AS $function$
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
  select quantity, value into old_qty, old_value from acc.inventory_balance_at(p_company, it.id, p_date);
  if p_quantity < 0 and old_qty + p_quantity < 0 then
    raise exception 'จำนวนสินค้าคงเหลือ ณ วันที่ % ไม่พอ (คงเหลือ %)', acc.thai_date(p_date), old_qty using errcode = 'ACC15';
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
  amount := case when p_quantity < 0 and -p_quantity = old_qty then old_value -- ตัดออกหมด = มูลค่าที่เหลือทั้งหมด
                 else round(abs(p_quantity) * use_cost, 2) end;
  if p_quantity < 0 then -- ตัดออก: ถัวเฉลี่ย/FIFO ตามสินค้า
    select o.value, o.unit_cost into amount, use_cost from acc.inventory_out_value(p_company, it.id, p_date, -p_quantity) o;
  end if;
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
end $function$;

CREATE OR REPLACE FUNCTION acc.restate_inventory_item(p_company uuid, p_item uuid, p_cause text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'acc', 'pg_temp'
AS $function$
declare
  it acc.items;
  m record; mm record;
  q numeric := 0; v numeric := 0;
  nv numeric; nu numeric;
  ref uuid; ref_unit numeric;
  vals jsonb := '{}';   -- movement id → [ค่าใหม่, ต้นทุนต่อหน่วยใหม่]
  changed uuid[] := '{}';
  ce uuid; e acc.journal_entries; ctr text[];
  rv uuid; ne uuid; je jsonb; lns jsonb; rid uuid; n int := 0;
begin
  select * into it from acc.items where company_id = p_company and id = p_item;
  if acc.item_cost_method(p_company, p_item) = 'fifo' then
    vals := (acc.fifo_walk(p_company, p_item, null, null)).vals;
    for m in
      select x.* from acc.inventory_movements_effective x
       where x.company_id = p_company and x.item_id = p_item and x.live
       order by x.movement_date, x.created_at, x.id
    loop
      nv := (vals->m.id::text->>0)::numeric; nu := (vals->m.id::text->>1)::numeric;
      if (nv <> m.eff_value or nu <> m.eff_unit_cost) and not (m.cur_entry_id = any (changed)) then
        changed := changed || m.cur_entry_id;
      end if;
    end loop;
  else
  for m in
    select x.*, p.source_kind, p.source_id, j.doc_prefix
      from acc.inventory_movements_effective x
      join acc.journal_entries j on j.company_id = x.company_id and j.id = x.entry_id
      left join acc.inventory_document_posts p on p.company_id = x.company_id and p.entry_id = x.entry_id
     where x.company_id = p_company and x.item_id = p_item and x.live
     order by x.movement_date, x.created_at, x.id
  loop
    if m.source_kind = 'sales_cogs' or (m.source_kind is null and m.doc_prefix = 'IA' and m.quantity < 0) then
      if q < -m.quantity then
        raise exception 'สินค้า % คงเหลือ ณ วันที่ % มี % ไม่พอตัดออก % ตาม % (เรียงตามวันที่)',
          it.name, acc.thai_date(m.movement_date), q, -m.quantity, m.reference using errcode = 'ACC15';
      end if;
      nu := round(v / q, 6);
      nv := case when -m.quantity = q then -v else -round(-m.quantity * nu, 2) end;
    elsif m.source_kind = 'sales_return' then
      select mv.id into ref
        from acc.documents cn
        join acc.inventory_document_posts sp on sp.company_id = cn.company_id and sp.source_kind = 'sales_cogs' and sp.source_id = cn.ref_document_id
        join acc.inventory_movements mv on mv.company_id = sp.company_id and mv.entry_id = sp.entry_id and mv.item_id = p_item and mv.quantity < 0
       where cn.company_id = p_company and cn.id = m.source_id
       order by mv.created_at limit 1;
      ref_unit := coalesce((vals->ref::text->>1)::numeric,
                           (select x.eff_unit_cost from acc.inventory_movements_effective x where x.company_id = p_company and x.id = ref), m.eff_unit_cost);
      nu := ref_unit;
      nv := round(m.quantity * nu, 2);
    else
      nv := m.eff_value; nu := m.eff_unit_cost;
    end if;
    q := q + m.quantity; v := v + nv;
    if q < 0 then
      raise exception 'สินค้า % คงเหลือ ณ วันที่ % ติดลบ (%) หลัง % (เรียงตามวันที่)',
        it.name, acc.thai_date(m.movement_date), q, m.reference using errcode = 'ACC15';
    end if;
    vals := vals || jsonb_build_object(m.id::text, jsonb_build_array(nv, nu));
    if (nv <> m.eff_value or nu <> m.eff_unit_cost) and not (m.cur_entry_id = any (changed)) then
      changed := changed || m.cur_entry_id;
    end if;
  end loop;
  end if;

  foreach ce in array changed loop
    select * into e from acc.journal_entries where company_id = p_company and id = ce;
    select array_agg(distinct a.code) into ctr
      from acc.journal_lines l join acc.chart_of_accounts a on a.company_id = l.company_id and a.id = l.account_id
     where l.company_id = p_company and l.entry_id = ce and a.code <> '1310';
    if coalesce(array_length(ctr, 1), 0) <> 1 then
      raise exception 'คำนวณต้นทุนใหม่ของ % ไม่ได้ (มีบัญชีคู่มากกว่าหนึ่งบัญชี)', e.doc_no using errcode = 'ACC15';
    end if;
    je := '[]'; lns := '[]';
    for mm in
      select x.id, x.quantity, i.name,
             coalesce((vals->x.id::text->>0)::numeric, x.eff_value) as nv,
             coalesce((vals->x.id::text->>1)::numeric, x.eff_unit_cost) as nu
        from acc.inventory_movements_effective x join acc.items i on i.company_id = x.company_id and i.id = x.item_id
       where x.company_id = p_company and x.cur_entry_id = ce
       order by x.created_at, x.id
    loop
      if mm.nv > 0 then
        je := je || jsonb_build_array(jsonb_build_object('account_code', '1310', 'debit', mm.nv::text, 'memo', mm.name),
                                      jsonb_build_object('account_code', ctr[1], 'credit', mm.nv::text, 'memo', mm.name));
      elsif mm.nv < 0 then
        je := je || jsonb_build_array(jsonb_build_object('account_code', ctr[1], 'debit', (-mm.nv)::text, 'memo', mm.name),
                                      jsonb_build_object('account_code', '1310', 'credit', (-mm.nv)::text, 'memo', mm.name));
      end if;
      lns := lns || jsonb_build_object('m', mm.id, 'v', mm.nv, 'u', mm.nu);
    end loop;
    if jsonb_array_length(je) = 0 then
      raise exception 'คำนวณต้นทุนใหม่ของ % ได้ศูนย์ ตรวจต้นทุนสินค้า %', e.doc_no, it.name using errcode = 'ACC15';
    end if;
    rv := acc.reverse_journal(p_company, ce, e.entry_date, 'inventory-restate:' || ce::text || ':rv',
                              'กลับรายการ ' || e.doc_no || ' (คำนวณต้นทุนใหม่ตามลำดับวันที่)');
    ne := acc.post_journal(p_company, e.entry_date, left('คำนวณต้นทุนใหม่ ' || e.doc_no || ' (' || p_cause || ')', 300), je,
                           'inventory-restate:' || ce::text || ':new', 'CG', null);
    insert into acc.inventory_restatements (company_id, entry_id, reversal_entry_id, new_entry_id, cause, created_by)
    values (p_company, ce, rv, ne, left(p_cause, 300), app.current_user_id()) returning id into rid;
    insert into acc.inventory_restatement_lines (company_id, restatement_id, movement_id, new_value, new_unit_cost)
    select p_company, rid, (x->>'m')::uuid, (x->>'v')::numeric, (x->>'u')::numeric from jsonb_array_elements(lns) x;
    n := n + 1;
  end loop;
  return n;
end $function$;

-- migrate:down
CREATE OR REPLACE FUNCTION acc.post_sales_inventory_cogs()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'acc', 'pg_temp'
AS $function$
declare
  d acc.documents;
  r record;
  b record;
  cost numeric;
  total_cost numeric := 0;
  je jsonb := '[]';
  eid uuid;
begin
  if exists (select 1 from acc.inventory_document_posts
             where company_id = new.company_id and source_kind = 'sales_cogs' and source_id = new.document_id) then
    return null;
  end if;
  select * into d from acc.documents where company_id = new.company_id and id = new.document_id;
  if d.kind not in ('sales_invoice', 'cash_sale') or d.is_service then return null; end if;
  perform 1 from acc.items i where i.company_id = d.company_id and i.track_inventory
    and exists (select 1 from acc.document_lines l where l.company_id=d.company_id and l.document_id=d.id and l.item_id=i.id)
    order by i.id for update;
  if exists (
    select 1 from acc.document_lines l join acc.items i on i.company_id=l.company_id and i.id=l.item_id and i.track_inventory
     where l.company_id=d.company_id and l.document_id=d.id group by l.item_id having count(*) > 1
  ) then
    raise exception 'สินค้าคงเหลือรหัสเดียวกันต้องรวมเป็นหนึ่งบรรทัดต่อใบขาย' using errcode = 'ACC15';
  end if;
  for r in select l.*, i.id stock_item_id, i.name item_name from acc.document_lines l
             join acc.items i on i.company_id=l.company_id and i.id=l.item_id and i.track_inventory
            where l.company_id=d.company_id and l.document_id=d.id order by l.line_no
  loop
    select * into b from acc.inventory_balance_at(d.company_id, r.stock_item_id, d.doc_date);
    if b.quantity < r.qty then
      raise exception 'สินค้า % คงเหลือ ณ วันที่ % มี % ไม่พอสำหรับขาย %', r.item_name, acc.thai_date(d.doc_date), b.quantity, r.qty using errcode = 'ACC15';
    end if;
    cost := case when r.qty = b.quantity then b.value else round(r.qty * b.unit_cost, 2) end; -- ขายหมด = มูลค่าที่เหลือทั้งหมด
    if cost <= 0 then raise exception 'สินค้า % ไม่มีต้นทุนคงเหลือ', r.item_name using errcode = 'ACC15'; end if;
    total_cost := total_cost + cost;
    je := je || jsonb_build_array(jsonb_build_object('account_code','5130','debit',cost::text,'memo',r.item_name),
                                  jsonb_build_object('account_code','1310','credit',cost::text,'memo',r.item_name));
  end loop;
  if total_cost = 0 then return null; end if;
  eid := acc.post_journal(d.company_id, d.doc_date, 'ตัดต้นทุนขาย ' || d.doc_no, je,
                          'inventory-sales:' || d.id::text, 'CG', null);
  insert into acc.inventory_document_posts(company_id,source_kind,source_id,entry_id)
  values(d.company_id,'sales_cogs',d.id,eid);
  for r in select l.*, i.id stock_item_id from acc.document_lines l join acc.items i
             on i.company_id=l.company_id and i.id=l.item_id and i.track_inventory
            where l.company_id=d.company_id and l.document_id=d.id order by l.line_no
  loop
    select * into b from acc.inventory_balance_at(d.company_id, r.stock_item_id, d.doc_date);
    -- balance หลังตรวจด้านบนยังเป็นก่อนตัดของแต่ละสินค้า (หนึ่งบรรทัดต่อสินค้าตาม UI ปัจจุบัน)
    cost := case when r.qty = b.quantity then b.value else round(r.qty * b.unit_cost, 2) end; -- ขายหมด = มูลค่าที่เหลือทั้งหมด
    insert into acc.inventory_movements(company_id,item_id,movement_date,kind,quantity,unit_cost,value,entry_id,idem_key,reference,created_by)
    values(d.company_id,r.stock_item_id,d.doc_date,'adjustment_out',-r.qty,b.unit_cost,-cost,eid,
           'inventory-sales:' || d.id::text || ':' || r.line_no::text,d.doc_no,d.created_by);
  end loop;
  return null;
end $function$;

CREATE OR REPLACE FUNCTION acc.post_inventory_adjustment(p_company uuid, p_item_code text, p_date date, p_quantity numeric, p_unit_cost numeric, p_offset_account_code text, p_description text, p_idem text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'acc', 'pg_temp'
AS $function$
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
  select quantity, value into old_qty, old_value from acc.inventory_balance_at(p_company, it.id, p_date);
  if p_quantity < 0 and old_qty + p_quantity < 0 then
    raise exception 'จำนวนสินค้าคงเหลือ ณ วันที่ % ไม่พอ (คงเหลือ %)', acc.thai_date(p_date), old_qty using errcode = 'ACC15';
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
  amount := case when p_quantity < 0 and -p_quantity = old_qty then old_value -- ตัดออกหมด = มูลค่าที่เหลือทั้งหมด
                 else round(abs(p_quantity) * use_cost, 2) end;
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
end $function$;

CREATE OR REPLACE FUNCTION acc.restate_inventory_item(p_company uuid, p_item uuid, p_cause text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'acc', 'pg_temp'
AS $function$
declare
  it acc.items;
  m record; mm record;
  q numeric := 0; v numeric := 0;
  nv numeric; nu numeric;
  ref uuid; ref_unit numeric;
  vals jsonb := '{}';   -- movement id → [ค่าใหม่, ต้นทุนต่อหน่วยใหม่]
  changed uuid[] := '{}';
  ce uuid; e acc.journal_entries; ctr text[];
  rv uuid; ne uuid; je jsonb; lns jsonb; rid uuid; n int := 0;
begin
  select * into it from acc.items where company_id = p_company and id = p_item;
  for m in
    select x.*, p.source_kind, p.source_id, j.doc_prefix
      from acc.inventory_movements_effective x
      join acc.journal_entries j on j.company_id = x.company_id and j.id = x.entry_id
      left join acc.inventory_document_posts p on p.company_id = x.company_id and p.entry_id = x.entry_id
     where x.company_id = p_company and x.item_id = p_item and x.live
     order by x.movement_date, x.created_at, x.id
  loop
    if m.source_kind = 'sales_cogs' or (m.source_kind is null and m.doc_prefix = 'IA' and m.quantity < 0) then
      if q < -m.quantity then
        raise exception 'สินค้า % คงเหลือ ณ วันที่ % มี % ไม่พอตัดออก % ตาม % (เรียงตามวันที่)',
          it.name, acc.thai_date(m.movement_date), q, -m.quantity, m.reference using errcode = 'ACC15';
      end if;
      nu := round(v / q, 6);
      nv := case when -m.quantity = q then -v else -round(-m.quantity * nu, 2) end;
    elsif m.source_kind = 'sales_return' then
      select mv.id into ref
        from acc.documents cn
        join acc.inventory_document_posts sp on sp.company_id = cn.company_id and sp.source_kind = 'sales_cogs' and sp.source_id = cn.ref_document_id
        join acc.inventory_movements mv on mv.company_id = sp.company_id and mv.entry_id = sp.entry_id and mv.item_id = p_item and mv.quantity < 0
       where cn.company_id = p_company and cn.id = m.source_id
       order by mv.created_at limit 1;
      ref_unit := coalesce((vals->ref::text->>1)::numeric,
                           (select x.eff_unit_cost from acc.inventory_movements_effective x where x.company_id = p_company and x.id = ref), m.eff_unit_cost);
      nu := ref_unit;
      nv := round(m.quantity * nu, 2);
    else
      nv := m.eff_value; nu := m.eff_unit_cost;
    end if;
    q := q + m.quantity; v := v + nv;
    if q < 0 then
      raise exception 'สินค้า % คงเหลือ ณ วันที่ % ติดลบ (%) หลัง % (เรียงตามวันที่)',
        it.name, acc.thai_date(m.movement_date), q, m.reference using errcode = 'ACC15';
    end if;
    vals := vals || jsonb_build_object(m.id::text, jsonb_build_array(nv, nu));
    if (nv <> m.eff_value or nu <> m.eff_unit_cost) and not (m.cur_entry_id = any (changed)) then
      changed := changed || m.cur_entry_id;
    end if;
  end loop;

  foreach ce in array changed loop
    select * into e from acc.journal_entries where company_id = p_company and id = ce;
    select array_agg(distinct a.code) into ctr
      from acc.journal_lines l join acc.chart_of_accounts a on a.company_id = l.company_id and a.id = l.account_id
     where l.company_id = p_company and l.entry_id = ce and a.code <> '1310';
    if coalesce(array_length(ctr, 1), 0) <> 1 then
      raise exception 'คำนวณต้นทุนใหม่ของ % ไม่ได้ (มีบัญชีคู่มากกว่าหนึ่งบัญชี)', e.doc_no using errcode = 'ACC15';
    end if;
    je := '[]'; lns := '[]';
    for mm in
      select x.id, x.quantity, i.name,
             coalesce((vals->x.id::text->>0)::numeric, x.eff_value) as nv,
             coalesce((vals->x.id::text->>1)::numeric, x.eff_unit_cost) as nu
        from acc.inventory_movements_effective x join acc.items i on i.company_id = x.company_id and i.id = x.item_id
       where x.company_id = p_company and x.cur_entry_id = ce
       order by x.created_at, x.id
    loop
      if mm.nv > 0 then
        je := je || jsonb_build_array(jsonb_build_object('account_code', '1310', 'debit', mm.nv::text, 'memo', mm.name),
                                      jsonb_build_object('account_code', ctr[1], 'credit', mm.nv::text, 'memo', mm.name));
      elsif mm.nv < 0 then
        je := je || jsonb_build_array(jsonb_build_object('account_code', ctr[1], 'debit', (-mm.nv)::text, 'memo', mm.name),
                                      jsonb_build_object('account_code', '1310', 'credit', (-mm.nv)::text, 'memo', mm.name));
      end if;
      lns := lns || jsonb_build_object('m', mm.id, 'v', mm.nv, 'u', mm.nu);
    end loop;
    if jsonb_array_length(je) = 0 then
      raise exception 'คำนวณต้นทุนใหม่ของ % ได้ศูนย์ ตรวจต้นทุนสินค้า %', e.doc_no, it.name using errcode = 'ACC15';
    end if;
    rv := acc.reverse_journal(p_company, ce, e.entry_date, 'inventory-restate:' || ce::text || ':rv',
                              'กลับรายการ ' || e.doc_no || ' (คำนวณต้นทุนใหม่ตามลำดับวันที่)');
    ne := acc.post_journal(p_company, e.entry_date, left('คำนวณต้นทุนใหม่ ' || e.doc_no || ' (' || p_cause || ')', 300), je,
                           'inventory-restate:' || ce::text || ':new', 'CG', null);
    insert into acc.inventory_restatements (company_id, entry_id, reversal_entry_id, new_entry_id, cause, created_by)
    values (p_company, ce, rv, ne, left(p_cause, 300), app.current_user_id()) returning id into rid;
    insert into acc.inventory_restatement_lines (company_id, restatement_id, movement_id, new_value, new_unit_cost)
    select p_company, rid, (x->>'m')::uuid, (x->>'v')::numeric, (x->>'u')::numeric from jsonb_array_elements(lns) x;
    n := n + 1;
  end loop;
  return n;
end $function$;

drop function acc.inventory_out_value(uuid, uuid, date, numeric), acc.fifo_walk(uuid, uuid, date, numeric),
  acc.set_inventory_method(uuid, text);
drop trigger items_cost_method_guard on acc.items;
drop function acc.guard_item_cost_method(), acc.item_cost_method(uuid, uuid);
alter table acc.items drop column cost_method;
alter table acc.companies drop column inventory_method;
