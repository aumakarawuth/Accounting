-- migrate:up
-- เฟส 3.1: ใบซื้อสินค้า tracked รับเข้า stock card และย้ายต้นทุนจากบัญชีซื้อไป 1310

create table acc.inventory_document_posts (
  company_id uuid not null references acc.companies(id),
  source_kind text not null check (source_kind in ('purchase_receipt')),
  source_id uuid not null,
  entry_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (company_id, source_kind, source_id),
  foreign key (company_id, entry_id) references acc.journal_entries(company_id, id)
);
alter table acc.inventory_document_posts enable row level security;
grant select on acc.inventory_document_posts to app_rw, app_ro;
create policy inventory_document_posts_read on acc.inventory_document_posts for select to app_rw, app_ro
  using (app.can_read_company(company_id));

create function acc.receive_purchase_inventory() returns trigger
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
                          'inventory-purchase:' || d.id::text, 'IM', d.entry_id);
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

create constraint trigger purchase_lines_inventory_receipt
after insert on acc.purchase_document_lines deferrable initially deferred
for each row execute function acc.receive_purchase_inventory();

-- migrate:down
drop trigger purchase_lines_inventory_receipt on acc.purchase_document_lines;
drop function acc.receive_purchase_inventory();
drop table acc.inventory_document_posts;
