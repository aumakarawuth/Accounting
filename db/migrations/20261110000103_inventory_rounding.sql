-- migrate:up
-- ตรวจความถูกต้องทางบัญชี (docs/accounting-audit.md): ซื้อสินค้าหลายบรรทัดที่มีส่วนลด ต้นทุนรายบรรทัดปัดแยกกัน
-- ผลรวมไม่เท่ายอดที่ลงบัญชีซื้อ (เช่น 3 × 100 ลด 1 → ลงซื้อ 299.00 แต่รับเข้าคลัง 299.01) บัญชีซื้อสินค้า 5110 ค้าง (0.01)
-- และสินค้าคงเหลือเกิน 0.01 · แก้ให้รับเข้าคลัง/ส่งคืนใช้การแบ่งแบบเดียวกับตอนลงบัญชีเอกสาร (ผลรวมเท่ากันพอดี)

-- ต้นทุนรายบรรทัดของเอกสารซื้อ: แบ่งแบบเดียวกับที่ post_purchase_document ลงบัญชี (ต่อบัญชี: ตัดสตางค์ เศษให้บัญชียอดมากสุด)
-- แล้วแบ่งยอดของบัญชีให้บรรทัดในบัญชีนั้นด้วยวิธีเดียวกัน (เศษให้บรรทัดยอดมากสุด) ผลรวมรายบรรทัด = ยอดที่ลงบัญชีพอดี
create function acc.purchase_line_costs(p_company uuid, p_document uuid)
returns table (line_no int, cost numeric)
language sql stable security definer set search_path = acc, pg_temp as $$
  with d as (
    select case when vat_claimable then base else total end as split, gross
      from acc.purchase_documents where company_id = p_company and id = p_document
  ), l as (
    select l.line_no, l.amount, a.code
      from acc.purchase_document_lines l join acc.chart_of_accounts a on a.company_id = l.company_id and a.id = l.account_id
     where l.company_id = p_company and l.document_id = p_document
  ), acc_amt as (
    select code, sum(amount) as amt, row_number() over (order by sum(amount) desc, code) as rn from l group by code
  ), acc_share as (
    select a.code, a.amt,
           trunc(d.split * a.amt / d.gross, 2)
             + case when a.rn = 1 then d.split - sum(trunc(d.split * a.amt / d.gross, 2)) over () else 0 end as share
      from acc_amt a cross join d
  ), line_part as (
    select l.line_no, l.code, s.share, s.amt, l.amount,
           trunc(case when s.amt = 0 then 0 else s.share * l.amount / s.amt end, 2) as part,
           row_number() over (partition by l.code order by l.amount desc, l.line_no) as rn
      from l join acc_share s on s.code = l.code
  )
  select line_no, part + case when rn = 1 then share - sum(part) over (partition by code) else 0 end
    from line_part
$$;
revoke all on function acc.purchase_line_costs(uuid, uuid) from public;

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

CREATE OR REPLACE FUNCTION acc.post_purchase_return_inventory()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'acc', 'pg_temp'
AS $function$
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
           pc.cost
      from acc.purchase_document_lines l
      join acc.purchase_line_costs(d.company_id, d.id) pc on pc.line_no = l.line_no
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
         round(pc.cost / l.qty, 6), -pc.cost, eid,
         'inventory-purchase-return:' || d.id::text || ':' || l.line_no::text, d.doc_no, d.created_by
    from acc.purchase_document_lines l
    join acc.purchase_line_costs(d.company_id, d.id) pc on pc.line_no = l.line_no
    join acc.items i on i.company_id = l.company_id and i.id = l.item_id and i.track_inventory
   where l.company_id = d.company_id and l.document_id = d.id and pc.cost > 0;
  return null;
end $function$;

-- migrate:down
-- คืนนิยามเดิม
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
end $function$

;

CREATE OR REPLACE FUNCTION acc.post_purchase_return_inventory()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'acc', 'pg_temp'
AS $function$
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
end $function$

;

drop function acc.purchase_line_costs(uuid, uuid);
