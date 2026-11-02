-- migrate:up
-- เฟส 3.1: ใบขายสินค้า tracked ตัดต้นทุนขายตาม moving average

alter table acc.inventory_document_posts drop constraint inventory_document_posts_source_kind_check;
alter table acc.inventory_document_posts add constraint inventory_document_posts_source_kind_check
  check (source_kind in ('purchase_receipt', 'sales_cogs'));

create function acc.post_sales_inventory_cogs() returns trigger
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
                          'inventory-sales:' || d.id::text, 'CG', d.entry_id);
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

create constraint trigger sales_lines_inventory_cogs after insert on acc.document_lines deferrable initially deferred
for each row execute function acc.post_sales_inventory_cogs();

-- migrate:down
drop trigger sales_lines_inventory_cogs on acc.document_lines;
drop function acc.post_sales_inventory_cogs();
alter table acc.inventory_document_posts drop constraint inventory_document_posts_source_kind_check;
alter table acc.inventory_document_posts add constraint inventory_document_posts_source_kind_check check (source_kind in ('purchase_receipt'));
