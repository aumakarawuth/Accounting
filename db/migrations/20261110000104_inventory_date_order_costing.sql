-- migrate:up
-- ต้นทุนสินค้าถัวเฉลี่ยเคลื่อนที่ตามลำดับวันที่ (แบบ Express) — docs/accounting-audit.md ข้อ 3 #2, docs/assumptions.md ข้อ 39
-- เดิม: เอกสารที่ลงย้อนวันที่ใช้ยอดคงเหลือ "ปัจจุบัน" (ขายก่อนวันที่ของเข้าได้ สต็อกติดลบตามวันที่ ต้นทุนผิด)
-- ใหม่:
--  1) ตัดต้นทุน/ตรวจจำนวนจากยอด ณ วันที่ของเอกสาร (acc.inventory_balance_at)
--  2) ลงรายการที่เคลื่อนไหวสต็อกย้อนวันที่ หรือยกเลิกเอกสาร → คำนวณต้นทุนของรายการหลังจากนั้นใหม่ตามลำดับวันที่
--     รายการต้นทุนที่ยอดเปลี่ยน: กลับรายการเดิม (RV ผ่าน acc.reverse_journal) แล้วลงใหม่ (CG) วันที่เดิม — สมุดรายวัน/บัตรสต็อกยังแก้ไม่ได้
--     ค่าใหม่ของแต่ละบรรทัดบัตรสต็อกเก็บใน acc.inventory_restatement_lines (append-only)
--  3) ลงแล้วทำให้สต็อก ณ วันใดติดลบ → ปฏิเสธทั้งรายการ
--  4) เอกสารที่ยกเลิกแล้ว (และรายการยกเลิกของมัน) ไม่นับในการคำนวณ เหมือนไม่เคยเกิด
--  5) ขาย/ตัดสต็อกจนหมด = ตัดมูลค่าที่เหลือทั้งหมด (เดิมเหลือเศษ 0.01 เมื่อเหลือตั้งแต่ 10,000 หน่วย)
--     เงื่อนไขมูลค่า = จำนวน × ต้นทุนต่อหน่วย ยอมให้คลาดได้เท่าที่เกิดจากการปัดต้นทุนต่อหน่วย 6 ตำแหน่ง

create function acc.thai_date(p date) returns text
language sql immutable set search_path = acc, pg_temp as $$
  select to_char(p, 'DD/MM/') || (extract(year from p)::int + 543)::text
$$;

alter table acc.inventory_movements drop constraint inventory_movements_check;
alter table acc.inventory_movements add constraint inventory_movements_value_check
  check (abs(value - quantity * unit_cost) <= 0.005 + abs(quantity) * 0.0000005);

-- คำนวณต้นทุนใหม่หนึ่งครั้ง = หนึ่งรายการต้นทุน (เอกสารหนึ่งใบ) ถูกกลับและลงใหม่
create table acc.inventory_restatements (
  seq               bigint generated always as identity,
  id                uuid not null default gen_random_uuid(),
  company_id        uuid not null references acc.companies(id),
  entry_id          uuid not null,          -- รายการต้นทุนที่ถูกแทน
  reversal_entry_id uuid not null,          -- RV ที่กลับรายการนั้น
  new_entry_id      uuid not null,          -- CG ที่ลงใหม่
  cause             text not null default '' check (length(cause) <= 300),
  created_by        uuid not null references acc.users(id),
  created_at        timestamptz not null default now(),
  primary key (company_id, id),
  unique (company_id, entry_id),
  foreign key (company_id, entry_id) references acc.journal_entries(company_id, id),
  foreign key (company_id, reversal_entry_id) references acc.journal_entries(company_id, id),
  foreign key (company_id, new_entry_id) references acc.journal_entries(company_id, id)
);
create table acc.inventory_restatement_lines (
  company_id     uuid not null,
  restatement_id uuid not null,
  movement_id    uuid not null,
  new_value      numeric(18,2) not null,
  new_unit_cost  numeric(18,6) not null check (new_unit_cost >= 0),
  primary key (company_id, restatement_id, movement_id),
  foreign key (company_id, restatement_id) references acc.inventory_restatements(company_id, id),
  foreign key (company_id, movement_id) references acc.inventory_movements(company_id, id)
);
create index inventory_restatement_lines_movement on acc.inventory_restatement_lines(company_id, movement_id);
create index inventory_restatements_new_entry on acc.inventory_restatements(company_id, new_entry_id);

create trigger inventory_restatements_immutable before update or delete on acc.inventory_restatements
  for each row execute function acc.forbid_mutation();
create trigger inventory_restatement_lines_immutable before update or delete on acc.inventory_restatement_lines
  for each row execute function acc.forbid_mutation();
create trigger inventory_restatements_locked before insert on acc.inventory_restatements
  for each row execute function acc.guard_locked_company();
create trigger audit_inventory_restatements after insert on acc.inventory_restatements
  for each row execute function acc.audit_row();

alter table acc.inventory_restatements enable row level security;
alter table acc.inventory_restatement_lines enable row level security;
grant select on acc.inventory_restatements, acc.inventory_restatement_lines to app_rw, app_ro;
create policy inventory_restatements_read on acc.inventory_restatements for select to app_rw, app_ro
  using (company_id in (select app.readable_company_ids()));
create policy inventory_restatement_lines_read on acc.inventory_restatement_lines for select to app_rw, app_ro
  using (company_id in (select app.readable_company_ids()));

-- บัตรสต็อกตามค่าล่าสุด: eff_value/eff_unit_cost = ค่าหลังคำนวณใหม่ครั้งล่าสุด · cur_entry_id = รายการต้นทุนปัจจุบัน
-- live = ไม่ใช่เอกสารที่ยกเลิกแล้วหรือรายการยกเลิก (คู่นี้รวมกันเป็นศูนย์เสมอ)
create view acc.inventory_movements_effective with (security_invoker = true) as
  select m.*,
         coalesce(x.new_value, m.value) as eff_value,
         coalesce(x.new_unit_cost, m.unit_cost) as eff_unit_cost,
         coalesce(x.new_entry_id, m.entry_id) as cur_entry_id,
         x.new_entry_id is not null as restated,
         not (m.idem_key like '%:void' or exists (
           select 1 from acc.inventory_movements v where v.company_id = m.company_id and v.idem_key = m.idem_key || ':void')) as live
    from acc.inventory_movements m
    left join lateral (
      select l.new_value, l.new_unit_cost, r.new_entry_id
        from acc.inventory_restatement_lines l
        join acc.inventory_restatements r on r.company_id = l.company_id and r.id = l.restatement_id
       where l.company_id = m.company_id and l.movement_id = m.id
       order by r.seq desc limit 1) x on true;
grant select on acc.inventory_movements_effective to app_rw, app_ro;

create or replace function acc.inventory_balance(p_company uuid, p_item uuid, out quantity numeric, out value numeric, out unit_cost numeric)
language sql stable set search_path = acc, app, public, pg_temp as $$
  select coalesce(sum(m.quantity), 0), coalesce(sum(m.eff_value), 0),
         case when coalesce(sum(m.quantity), 0) = 0 then 0
              else round(coalesce(sum(m.eff_value), 0) / sum(m.quantity), 6) end
    from acc.inventory_movements_effective m
   where m.company_id = p_company and m.item_id = p_item
$$;

-- ยอด ณ สิ้นวันที่ (รวมรายการวันเดียวกันที่ลงไว้ก่อน) ไม่นับเอกสารที่ยกเลิก
create function acc.inventory_balance_at(p_company uuid, p_item uuid, p_date date,
  out quantity numeric, out value numeric, out unit_cost numeric)
language sql stable set search_path = acc, app, public, pg_temp as $$
  select coalesce(sum(m.quantity), 0), coalesce(sum(m.eff_value), 0),
         case when coalesce(sum(m.quantity), 0) = 0 then 0
              else round(coalesce(sum(m.eff_value), 0) / sum(m.quantity), 6) end
    from acc.inventory_movements_effective m
   where m.company_id = p_company and m.item_id = p_item and m.live and m.movement_date <= p_date
$$;
grant execute on function acc.inventory_balance_at(uuid, uuid, date) to app_rw, app_ro;

create or replace function acc.inventory_card(p_company uuid, p_item uuid)
returns table (movement_date date, kind text, quantity_in numeric, quantity_out numeric,
               unit_cost numeric, value_in numeric, value_out numeric, balance_qty numeric, balance_value numeric)
language sql stable set search_path = acc, app, public, pg_temp as $$
  select m.movement_date, m.kind,
         case when m.quantity > 0 then m.quantity else 0 end,
         case when m.quantity < 0 then -m.quantity else 0 end,
         m.eff_unit_cost,
         case when m.eff_value > 0 then m.eff_value else 0 end,
         case when m.eff_value < 0 then -m.eff_value else 0 end,
         sum(m.quantity) over w,
         sum(m.eff_value) over w
    from acc.inventory_movements_effective m
   where m.company_id = p_company and m.item_id = p_item
  window w as (order by m.movement_date, m.created_at, m.id rows between unbounded preceding and current row)
   order by m.movement_date, m.created_at, m.id
$$;

-- คำนวณต้นทุนของสินค้าหนึ่งตัวใหม่ทั้งบัตรตามลำดับวันที่ แล้วกลับ/ลงใหม่เฉพาะรายการต้นทุนที่ยอดเปลี่ยน
-- บทบาทของแต่ละบรรทัด: ขาย (CG) / ตัดออกจากการปรับสต็อก (IA ติดลบ) = ถัวเฉลี่ย ณ จุดนั้น
-- · รับคืนจากลูกค้า = ต้นทุนต่อหน่วยของใบขายที่อ้าง · ซื้อ/ส่งคืนผู้ขาย/รับเข้าจากการปรับสต็อก = มูลค่าตามเอกสาร (ไม่เปลี่ยน)
create function acc.restate_inventory_item(p_company uuid, p_item uuid, p_cause text) returns int
language plpgsql security definer set search_path = acc, pg_temp as $$
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
end $$;
revoke all on function acc.restate_inventory_item(uuid, uuid, text) from public;

-- หลังเพิ่มบรรทัดบัตรสต็อก: ถ้ามีรายการของสินค้านี้ลงวันที่หลังจากนั้น (ลงย้อนวันที่ หรือยกเลิกเอกสารที่มีรายการตามหลัง) คำนวณใหม่
create function acc.inventory_restate_after_insert() returns trigger
language plpgsql security definer set search_path = acc, pg_temp as $$
declare
  d date := new.movement_date;
  cause text;
begin
  if new.idem_key like '%:void' then
    select least(d, o.movement_date) into d from acc.inventory_movements o
     where o.company_id = new.company_id and o.idem_key = left(new.idem_key, -5);
    cause := new.reference;
  else
    cause := 'ลงย้อนวันที่ ' || new.reference;
  end if;
  if exists (select 1 from acc.inventory_movements x
              where x.company_id = new.company_id and x.item_id = new.item_id and x.movement_date > d and x.id <> new.id) then
    perform acc.restate_inventory_item(new.company_id, new.item_id, cause);
  end if;
  return null;
end $$;
create trigger inventory_movements_restate after insert on acc.inventory_movements
  for each row execute function acc.inventory_restate_after_insert();

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

CREATE OR REPLACE FUNCTION acc.post_sales_return_inventory()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'acc', 'pg_temp'
AS $function$
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
  -- ต้นทุนต่อหน่วยจากการตัดต้นทุนขายของใบที่อ้าง (ค่าล่าสุดหลังคำนวณต้นทุนใหม่) (ใบที่ขายก่อนเปิดติดตามสต็อกไม่มี movement → ไม่ปรับสต็อก)
  for r in
    select l.line_no, l.qty, i.id as item_id, i.name as item_name, m.unit_cost, round(l.qty * m.unit_cost, 2) as cost
      from acc.document_lines l
      join acc.items i on i.company_id = l.company_id and i.id = l.item_id and i.track_inventory
      join acc.inventory_document_posts p on p.company_id = l.company_id and p.source_kind = 'sales_cogs' and p.source_id = d.ref_document_id
      join lateral (select mv.eff_unit_cost as unit_cost from acc.inventory_movements_effective mv
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
    join lateral (select mv.eff_unit_cost as unit_cost from acc.inventory_movements_effective mv
                   where mv.company_id = l.company_id and mv.entry_id = p.entry_id and mv.item_id = i.id and mv.quantity < 0
                   order by mv.created_at limit 1) m on true
   where l.company_id = d.company_id and l.document_id = d.id and round(l.qty * m.unit_cost, 2) > 0;
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
    select * into b from acc.inventory_balance_at(d.company_id, r.item_id, d.doc_date);
    if b.quantity < r.qty then
      raise exception 'สินค้า % คงเหลือ ณ วันที่ % มี % ไม่พอสำหรับส่งคืน %', r.item_name, acc.thai_date(d.doc_date), b.quantity, r.qty using errcode = 'ACC15';
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

CREATE OR REPLACE FUNCTION acc.reverse_inventory_on_void()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'acc', 'pg_temp'
AS $function$
declare
  v_kind text := case tg_table_name
    when 'purchase_documents' then case when new.kind = 'purchase_credit_note' then 'purchase_return' else 'purchase_receipt' end
    else case when new.kind = 'credit_note' then 'sales_return' else 'sales_cogs' end end;
  p acc.inventory_document_posts;
  v_date date;
  v_rv uuid;
  v_cur uuid;
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
  -- รายการต้นทุนปัจจุบัน (ถ้าเคยคำนวณต้นทุนใหม่ รายการเดิมถูกกลับไปแล้ว)
  select distinct x.cur_entry_id into v_cur from acc.inventory_movements_effective x where x.company_id = new.company_id and x.entry_id = p.entry_id;
  v_rv := acc.reverse_journal(new.company_id, v_cur, coalesce(v_date, current_date), 'inventory-void:' || new.id::text,
                              'ยกเลิก ' || new.doc_no);
  insert into acc.inventory_movements(company_id, item_id, movement_date, kind, quantity, unit_cost, value, entry_id, idem_key, reference, created_by)
  select company_id, item_id, coalesce(v_date, current_date),
         case when quantity > 0 then 'adjustment_out' else 'adjustment_in' end,
         -quantity, eff_unit_cost, -eff_value, v_rv, idem_key || ':void', 'ยกเลิก ' || new.doc_no, app.current_user_id()
    from acc.inventory_movements_effective where company_id = new.company_id and entry_id = p.entry_id;
  return null;
end $function$;

-- migrate:down
drop trigger inventory_movements_restate on acc.inventory_movements;
drop function acc.inventory_restate_after_insert();
drop function acc.restate_inventory_item(uuid, uuid, text);
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
end $function$;

CREATE OR REPLACE FUNCTION acc.post_sales_return_inventory()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'acc', 'pg_temp'
AS $function$
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

CREATE OR REPLACE FUNCTION acc.reverse_inventory_on_void()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'acc', 'pg_temp'
AS $function$
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
end $function$;

CREATE OR REPLACE FUNCTION acc.inventory_balance(p_company uuid, p_item uuid, OUT quantity numeric, OUT value numeric, OUT unit_cost numeric)
 RETURNS record
 LANGUAGE sql
 STABLE
 SET search_path TO 'acc', 'app', 'public', 'pg_temp'
AS $function$
  select coalesce(sum(m.quantity), 0), coalesce(sum(m.value), 0),
         case when coalesce(sum(m.quantity), 0) = 0 then 0
              else round(coalesce(sum(m.value), 0) / sum(m.quantity), 6) end
    from acc.inventory_movements m
   where m.company_id = p_company and m.item_id = p_item
$function$;

CREATE OR REPLACE FUNCTION acc.inventory_card(p_company uuid, p_item uuid)
 RETURNS TABLE(movement_date date, kind text, quantity_in numeric, quantity_out numeric, unit_cost numeric, value_in numeric, value_out numeric, balance_qty numeric, balance_value numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'acc', 'app', 'public', 'pg_temp'
AS $function$
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
$function$;
drop function acc.inventory_balance_at(uuid, uuid, date);
drop view acc.inventory_movements_effective;
drop table acc.inventory_restatement_lines;
drop table acc.inventory_restatements;
alter table acc.inventory_movements drop constraint inventory_movements_value_check;
alter table acc.inventory_movements add constraint inventory_movements_check check (value = round(quantity * unit_cost, 2));
drop function acc.thai_date(date);
