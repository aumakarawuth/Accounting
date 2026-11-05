-- migrate:up
-- สินค้าคงเหลือ: ใบลดหนี้ (รับคืน/ส่งคืน) ปรับ stock card ตาม docs/phase3-spec.md
-- ("ใบลดหนี้ซื้อ, ใบลดหนี้ขาย ... สร้าง movement กลับด้าน โดยอ้างถึงเอกสารต้นทาง")
-- ก่อนหน้านี้ใบลดหนี้ไม่แตะสต็อก: รับคืนสินค้าแล้วจำนวนในบัตรสต็อกไม่เพิ่ม ส่งคืนผู้ขายแล้ว 1310 ไม่ลด
-- แต่ 5140 ส่งคืนสินค้าถูกเครดิต (นับซ้ำ กำไรสูงเกินจริง) พบตอนทดสอบทั้งระบบ docs/full-system-test.md
--
-- มูลค่า (สมมติฐาน docs/assumptions.md ข้อ 37 รอเจ้าของโปรเจกต์ยืนยัน):
--   รับคืนจากลูกค้า = ต้นทุนต่อหน่วยตอนขายใบที่อ้าง (กลับรายการต้นทุนขาย) Dr 1310 / Cr 5130
--   ส่งคืนผู้ขาย   = มูลค่าสุทธิในใบลดหนี้ (ไม่รวม VAT ที่ขอคืนได้ สูตรเดียวกับตอนรับเข้า) Dr 5140 / Cr 1310

alter table acc.inventory_document_posts drop constraint inventory_document_posts_source_kind_check;
alter table acc.inventory_document_posts add constraint inventory_document_posts_source_kind_check
  check (source_kind in ('purchase_receipt', 'sales_cogs', 'sales_return', 'purchase_return'));

create function acc.post_sales_return_inventory() returns trigger
language plpgsql security definer set search_path = acc, pg_temp as $$
declare
  d acc.documents;
  r record;
  je jsonb := '[]';
  total_cost numeric := 0;
  eid uuid;
begin
  if exists (select 1 from acc.inventory_document_posts
              where company_id = new.company_id and source_kind = 'sales_return' and source_id = new.document_id) then
    return null;
  end if;
  select * into d from acc.documents where company_id = new.company_id and id = new.document_id;
  if d.kind <> 'credit_note' or d.is_service or d.ref_document_id is null then return null; end if;
  perform 1 from acc.items i where i.company_id = d.company_id and i.track_inventory
    and exists (select 1 from acc.document_lines l where l.company_id = d.company_id and l.document_id = d.id and l.item_id = i.id)
    order by i.id for update;
  -- ต้นทุนต่อหน่วยจากการตัดต้นทุนขายของใบที่อ้าง (ใบที่ขายก่อนเปิดติดตามสต็อกไม่มี movement → ไม่ปรับสต็อก)
  for r in
    select l.line_no, l.qty, i.id as item_id, i.name as item_name, m.unit_cost, round(l.qty * m.unit_cost, 2) as cost
      from acc.document_lines l
      join acc.items i on i.company_id = l.company_id and i.id = l.item_id and i.track_inventory
      join acc.inventory_document_posts p on p.company_id = l.company_id and p.source_kind = 'sales_cogs' and p.source_id = d.ref_document_id
      join lateral (select mv.unit_cost from acc.inventory_movements mv
                     where mv.company_id = l.company_id and mv.entry_id = p.entry_id and mv.item_id = i.id and mv.quantity < 0
                     order by mv.created_at limit 1) m on true
     where l.company_id = d.company_id and l.document_id = d.id
     order by l.line_no
  loop
    if r.cost <= 0 then continue; end if;
    -- รับคืนเกินจำนวนที่ขายในใบนั้น (รวมใบลดหนี้ก่อนหน้า) ไม่ได้
    if r.qty > (select -coalesce(sum(mv.quantity), 0) from acc.inventory_movements mv
                 where mv.company_id = d.company_id and mv.item_id = r.item_id and mv.entry_id = (
                   select entry_id from acc.inventory_document_posts where company_id = d.company_id and source_kind = 'sales_cogs' and source_id = d.ref_document_id))
             - (select coalesce(sum(mv.quantity), 0) from acc.inventory_movements mv
                  join acc.inventory_document_posts p2 on p2.company_id = mv.company_id and p2.entry_id = mv.entry_id and p2.source_kind = 'sales_return'
                  join acc.documents cn on cn.company_id = p2.company_id and cn.id = p2.source_id and cn.voided_at is null
                 where mv.company_id = d.company_id and mv.item_id = r.item_id and cn.ref_document_id = d.ref_document_id) then
      raise exception 'รับคืน % เกินจำนวนที่ขายในใบที่อ้าง', r.item_name using errcode = 'ACC15';
    end if;
    je := je || jsonb_build_array(
      jsonb_build_object('account_code', '1310', 'debit', r.cost::text, 'memo', r.item_name),
      jsonb_build_object('account_code', '5130', 'credit', r.cost::text, 'memo', r.item_name));
    total_cost := total_cost + r.cost;
  end loop;
  if total_cost = 0 then return null; end if;
  eid := acc.post_journal(d.company_id, d.doc_date, 'รับคืนสินค้าเข้าคลัง ' || d.doc_no, je,
                          'inventory-sales-return:' || d.id::text, 'CG', null);
  insert into acc.inventory_document_posts(company_id, source_kind, source_id, entry_id) values (d.company_id, 'sales_return', d.id, eid);
  insert into acc.inventory_movements(company_id, item_id, movement_date, kind, quantity, unit_cost, value, entry_id, idem_key, reference, created_by)
  select d.company_id, i.id, d.doc_date, 'adjustment_in', l.qty, m.unit_cost, round(l.qty * m.unit_cost, 2), eid,
         'inventory-sales-return:' || d.id::text || ':' || l.line_no::text, d.doc_no, d.created_by
    from acc.document_lines l
    join acc.items i on i.company_id = l.company_id and i.id = l.item_id and i.track_inventory
    join acc.inventory_document_posts p on p.company_id = l.company_id and p.source_kind = 'sales_cogs' and p.source_id = d.ref_document_id
    join lateral (select mv.unit_cost from acc.inventory_movements mv
                   where mv.company_id = l.company_id and mv.entry_id = p.entry_id and mv.item_id = i.id and mv.quantity < 0
                   order by mv.created_at limit 1) m on true
   where l.company_id = d.company_id and l.document_id = d.id and round(l.qty * m.unit_cost, 2) > 0;
  return null;
end $$;
create constraint trigger sales_lines_inventory_return after insert on acc.document_lines deferrable initially deferred
  for each row execute function acc.post_sales_return_inventory();

create function acc.post_purchase_return_inventory() returns trigger
language plpgsql security definer set search_path = acc, pg_temp as $$
declare
  d acc.purchase_documents;
  r record;
  b record;
  je jsonb := '[]';
  total_cost numeric := 0;
  eid uuid;
begin
  if exists (select 1 from acc.inventory_document_posts
              where company_id = new.company_id and source_kind = 'purchase_return' and source_id = new.document_id) then
    return null;
  end if;
  select * into d from acc.purchase_documents where company_id = new.company_id and id = new.document_id;
  if d.kind <> 'purchase_credit_note' or d.is_service then return null; end if;
  perform 1 from acc.items i where i.company_id = d.company_id and i.track_inventory
    and exists (select 1 from acc.purchase_document_lines l where l.company_id = d.company_id and l.document_id = d.id and l.item_id = i.id)
    order by i.id for update;
  for r in
    select l.line_no, l.qty, i.id as item_id, i.name as item_name, a.code as return_code,
           round((case when d.vat_claimable then d.base else d.total end) * l.amount / d.gross, 2) as cost
      from acc.purchase_document_lines l
      join acc.items i on i.company_id = l.company_id and i.id = l.item_id and i.track_inventory
      join acc.chart_of_accounts a on a.company_id = l.company_id and a.id = l.account_id
     where l.company_id = d.company_id and l.document_id = d.id
     order by l.line_no
  loop
    if r.cost <= 0 then continue; end if;
    select * into b from acc.inventory_balance(d.company_id, r.item_id);
    if b.quantity < r.qty then
      raise exception 'สินค้า % คงเหลือ % ไม่พอสำหรับส่งคืน %', r.item_name, b.quantity, r.qty using errcode = 'ACC15';
    end if;
    if b.value < r.cost then
      raise exception 'มูลค่าส่งคืน % เกินมูลค่าคงเหลือของ % (%)', r.cost, r.item_name, b.value using errcode = 'ACC15';
    end if;
    je := je || jsonb_build_array(
      jsonb_build_object('account_code', r.return_code, 'debit', r.cost::text, 'memo', r.item_name),
      jsonb_build_object('account_code', '1310', 'credit', r.cost::text, 'memo', r.item_name));
    total_cost := total_cost + r.cost;
  end loop;
  if total_cost = 0 then return null; end if;
  eid := acc.post_journal(d.company_id, d.doc_date, 'ส่งคืนสินค้าออกจากคลัง ' || d.doc_no, je,
                          'inventory-purchase-return:' || d.id::text, 'IM', null);
  insert into acc.inventory_document_posts(company_id, source_kind, source_id, entry_id) values (d.company_id, 'purchase_return', d.id, eid);
  insert into acc.inventory_movements(company_id, item_id, movement_date, kind, quantity, unit_cost, value, entry_id, idem_key, reference, created_by)
  select d.company_id, i.id, d.doc_date, 'adjustment_out', -l.qty,
         round(round((case when d.vat_claimable then d.base else d.total end) * l.amount / d.gross, 2) / l.qty, 6),
         -round((case when d.vat_claimable then d.base else d.total end) * l.amount / d.gross, 2), eid,
         'inventory-purchase-return:' || d.id::text || ':' || l.line_no::text, d.doc_no, d.created_by
    from acc.purchase_document_lines l
    join acc.items i on i.company_id = l.company_id and i.id = l.item_id and i.track_inventory
   where l.company_id = d.company_id and l.document_id = d.id
     and round((case when d.vat_claimable then d.base else d.total end) * l.amount / d.gross, 2) > 0;
  return null;
end $$;
create constraint trigger purchase_lines_inventory_return after insert on acc.purchase_document_lines deferrable initially deferred
  for each row execute function acc.post_purchase_return_inventory();

-- ยกเลิกเอกสาร: รู้จักใบลดหนี้ด้วย (เดิมดูเฉพาะชนิดตาราง)
create or replace function acc.reverse_inventory_on_void() returns trigger
language plpgsql security definer set search_path = acc, pg_temp as $$
declare
  v_kind text := case tg_table_name
    when 'purchase_documents' then case when new.kind = 'purchase_credit_note' then 'purchase_return' else 'purchase_receipt' end
    else case when new.kind = 'credit_note' then 'sales_return' else 'sales_cogs' end end;
  p acc.inventory_document_posts;
  v_date date;
  v_rv uuid;
  m record;
  b record;
begin
  if old.voided_at is not null or new.voided_at is null then return null; end if;
  select * into p from acc.inventory_document_posts where company_id = new.company_id and source_kind = v_kind and source_id = new.id;
  if not found then return null; end if;
  select entry_date into v_date from acc.journal_entries where company_id = new.company_id and id = new.void_entry_id;
  for m in select * from acc.inventory_movements where company_id = new.company_id and entry_id = p.entry_id order by item_id loop
    perform 1 from acc.items where company_id = m.company_id and id = m.item_id for update;
    if m.quantity > 0 then
      select * into b from acc.inventory_balance(m.company_id, m.item_id);
      if b.quantity < m.quantity then
        raise exception 'สินค้าจาก % ถูกขาย/ตัดออกไปแล้ว (คงเหลือ %) ยกเลิกใบขายที่เกี่ยวข้องก่อน', new.doc_no, b.quantity using errcode = 'ACC16';
      end if;
    end if;
  end loop;
  v_rv := acc.reverse_journal(new.company_id, p.entry_id, coalesce(v_date, current_date), 'inventory-void:' || new.id::text,
                              'ยกเลิก ' || new.doc_no);
  insert into acc.inventory_movements(company_id, item_id, movement_date, kind, quantity, unit_cost, value, entry_id, idem_key, reference, created_by)
  select company_id, item_id, coalesce(v_date, current_date),
         case when quantity > 0 then 'adjustment_out' else 'adjustment_in' end,
         -quantity, unit_cost, -value, v_rv, idem_key || ':void', 'ยกเลิก ' || new.doc_no, app.current_user_id()
    from acc.inventory_movements where company_id = new.company_id and entry_id = p.entry_id;
  return null;
end $$;

-- เปิด/ปิดการติดตามสต็อกของสินค้า: ปิดไม่ได้เมื่อมีความเคลื่อนไหวแล้ว (ยอด 1310 จะค้างโดยไม่มีบัตรสต็อก)
create function acc.guard_item_tracking() returns trigger
language plpgsql security definer set search_path = acc, pg_temp as $$
begin
  if old.track_inventory and not new.track_inventory
     and exists (select 1 from acc.inventory_movements m where m.company_id = new.company_id and m.item_id = new.id) then
    raise exception 'สินค้า % มีความเคลื่อนไหวในบัตรสต็อกแล้ว ปิดการติดตามสต็อกไม่ได้', new.code using errcode = 'ACC18';
  end if;
  if new.track_inventory and new.is_service then
    raise exception 'บริการติดตามสต็อกไม่ได้' using errcode = 'ACC15';
  end if;
  return new;
end $$;
create trigger items_tracking_guard before update of track_inventory, is_service on acc.items
  for each row execute function acc.guard_item_tracking();

-- migrate:down
drop trigger items_tracking_guard on acc.items;
drop function acc.guard_item_tracking();
drop trigger purchase_lines_inventory_return on acc.purchase_document_lines;
drop function acc.post_purchase_return_inventory();
drop trigger sales_lines_inventory_return on acc.document_lines;
drop function acc.post_sales_return_inventory();
