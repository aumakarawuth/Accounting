-- migrate:up
-- แก้บั๊กสินค้าคงเหลือ: รายการรับเข้าคลัง (IM) และตัดต้นทุนขาย (CG) เคยตั้ง reverses_entry_id ชี้ไปที่รายการของใบซื้อ/ใบขาย
-- ทำให้ระบบเห็นว่าใบนั้นถูกกลับรายการแล้ว ยกเลิกใบไม่ได้ (unique journal_entries_reverses)
-- ตอนนี้: IM/CG ไม่ผูก reverses · ยกเลิกใบซื้อ/ใบขาย = กลับรายการ IM/CG ด้วย และลงความเคลื่อนไหวสต็อกกลับทาง

update acc.journal_entries set reverses_entry_id = null where doc_prefix in ('IM', 'CG') and reverses_entry_id is not null;

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
           round((case when d.vat_claimable then d.base else d.total end) * l.amount / d.gross, 2) as cost
      from acc.purchase_document_lines l
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
           round((case when d.vat_claimable then d.base else d.total end) * l.amount / d.gross, 2) as cost
      from acc.purchase_document_lines l join acc.items i on i.company_id = l.company_id and i.id = l.item_id and i.track_inventory
     where l.company_id = d.company_id and l.document_id = d.id order by l.line_no
  loop
    insert into acc.inventory_movements(company_id, item_id, movement_date, kind, quantity, unit_cost, value, entry_id, idem_key, reference, created_by)
    values (d.company_id, r.stock_item_id, d.doc_date, 'adjustment_in', r.qty, round(r.cost / r.qty, 6), r.cost, eid,
            'inventory-purchase:' || d.id::text || ':' || r.line_no::text, d.doc_no, d.created_by);
  end loop;
  return null;
end $$;

create or replace function acc.post_sales_inventory_cogs() returns trigger
language plpgsql security definer set search_path = acc, pg_temp as $$
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
    select * into b from acc.inventory_balance(d.company_id, r.stock_item_id);
    if b.quantity < r.qty then
      raise exception 'สินค้า % คงเหลือ % ไม่พอสำหรับขาย %', r.item_name, b.quantity, r.qty using errcode = 'ACC15';
    end if;
    cost := round(r.qty * b.unit_cost, 2);
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
    select * into b from acc.inventory_balance(d.company_id, r.stock_item_id);
    -- balance หลังตรวจด้านบนยังเป็นก่อนตัดของแต่ละสินค้า (หนึ่งบรรทัดต่อสินค้าตาม UI ปัจจุบัน)
    cost := round(r.qty * b.unit_cost, 2);
    insert into acc.inventory_movements(company_id,item_id,movement_date,kind,quantity,unit_cost,value,entry_id,idem_key,reference,created_by)
    values(d.company_id,r.stock_item_id,d.doc_date,'adjustment_out',-r.qty,b.unit_cost,-cost,eid,
           'inventory-sales:' || d.id::text || ':' || r.line_no::text,d.doc_no,d.created_by);
  end loop;
  return null;
end $$;

-- ยกเลิกเอกสาร: กลับรายการสต็อกของเอกสารนั้น ลงวันที่เดียวกับการยกเลิก
-- ใบซื้อที่สินค้าถูกขาย/ตัดออกไปแล้วจนคงเหลือไม่พอ ยกเลิกไม่ได้ (ต้องยกเลิกใบขายก่อน)
create function acc.reverse_inventory_on_void() returns trigger
language plpgsql security definer set search_path = acc, pg_temp as $$
declare
  v_kind text := case tg_table_name when 'purchase_documents' then 'purchase_receipt' else 'sales_cogs' end;
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
create trigger purchase_documents_inventory_void after update of voided_at on acc.purchase_documents
  for each row execute function acc.reverse_inventory_on_void();
create trigger documents_inventory_void after update of voided_at on acc.documents
  for each row execute function acc.reverse_inventory_on_void();

-- migrate:down
drop trigger documents_inventory_void on acc.documents;
drop trigger purchase_documents_inventory_void on acc.purchase_documents;
drop function acc.reverse_inventory_on_void();
