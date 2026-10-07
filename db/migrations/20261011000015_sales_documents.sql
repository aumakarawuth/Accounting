-- migrate:up
-- เฟส 2.2 ขาย: ขายเชื่อ (ใบกำกับภาษี/ใบแจ้งหนี้) ขายสด รับชำระ ใบลดหนี้ ใบเพิ่มหนี้ ยกเลิก (docs/phase2-spec.md)
-- ทุกเอกสารลงบัญชีผ่าน acc.post_journal: ดุลแน่นอน เลขที่ไม่ข้าม (เลขเอกสาร = เลขรายการบัญชี) กันกดซ้ำ ปิดงวด ล็อกตอนส่งงาน

-- ภาษีมูลค่าเพิ่มจากยอดรวมทั้งใบ ปัดครึ่งขึ้นที่สตางค์ (T2, T3) สูตรเดียวกับ apps/web/lib/vat.ts
-- exclusive: ภาษี = ฐาน × อัตรา · inclusive: ภาษี = รวม × อัตรา / (100 + อัตรา) · none: ไม่จด VAT
create function app.vat_calc(p_gross numeric, p_discount numeric, p_rate numeric, p_mode text,
                             out base numeric, out vat numeric, out total numeric)
language plpgsql immutable as $$
begin
  if p_mode = 'exclusive' then
    base := p_gross - p_discount; vat := round(base * p_rate / 100, 2); total := base + vat;
  elsif p_mode = 'inclusive' then
    total := p_gross - p_discount; vat := round(total * p_rate / (100 + p_rate), 2); base := total - vat;
  else
    base := p_gross - p_discount; vat := 0.00; total := base;
  end if;
end $$;
grant execute on function app.vat_calc(numeric, numeric, numeric, text) to app_rw, app_ro;

create table acc.documents (
  id               uuid not null default gen_random_uuid(),
  company_id       uuid not null references acc.companies(id),
  kind             text not null check (kind in ('sales_invoice', 'cash_sale', 'receipt', 'credit_note', 'debit_note')),
  doc_no           text not null,
  doc_date         date not null,
  party_id         uuid not null,
  -- สำเนาข้อมูลคู่ค้าและผู้ขาย ณ วันออก (แก้ข้อมูลหลักภายหลังไม่เปลี่ยนเอกสารที่ออกแล้ว)
  party_code       text not null,
  party_name       text not null,
  party_tax_id     text,
  party_branch_no  text not null,
  party_address    text not null,
  seller_name      text not null,
  seller_tax_id    text,
  seller_branch_no text not null,
  seller_address   text not null,
  is_service       boolean not null,  -- จุดความรับผิดภาษีเมื่อรับเงิน (T4) ทั้งใบเป็นสินค้าหรือบริการอย่างเดียว
  is_tax_invoice   boolean not null,
  price_mode       text not null check (price_mode in ('exclusive', 'inclusive', 'none')),
  vat_rate         numeric(5,2) not null,
  gross            numeric(18,2) not null check (gross >= 0),   -- รวมจำนวนเงินรายการ (ก่อนหักส่วนลด)
  discount         numeric(18,2) not null default 0 check (discount >= 0),
  base             numeric(18,2) not null check (base >= 0),    -- มูลค่าก่อนภาษี
  vat              numeric(18,2) not null check (vat >= 0),
  total            numeric(18,2) not null check (total > 0),
  wht_amount       numeric(18,2) not null default 0 check (wht_amount >= 0 and wht_amount < total),
  cash_account_id  uuid,
  credit_days      int check (credit_days between 0 and 365),
  due_date         date,
  ref_document_id  uuid,
  reason           text check (length(reason) <= 300),
  description      text not null default '' check (length(description) <= 300),
  entry_id         uuid not null,
  idem_key         text not null,
  voided_at        timestamptz,
  void_entry_id    uuid,
  void_reason      text check (length(void_reason) <= 300),
  created_by       uuid not null references acc.users(id),
  created_at       timestamptz not null default now(),
  primary key (company_id, id),
  unique (company_id, doc_no),
  unique (company_id, idem_key),
  foreign key (company_id, party_id) references acc.parties (company_id, id),
  foreign key (company_id, entry_id) references acc.journal_entries (company_id, id),
  foreign key (company_id, void_entry_id) references acc.journal_entries (company_id, id),
  foreign key (company_id, cash_account_id) references acc.chart_of_accounts (company_id, id),
  foreign key (company_id, ref_document_id) references acc.documents (company_id, id),
  check (base + vat = total and gross - discount in (base, total)),
  check ((voided_at is null) = (void_entry_id is null))
);
create index documents_party on acc.documents (company_id, party_id, doc_date);
create index documents_ref on acc.documents (company_id, ref_document_id) where ref_document_id is not null;

create table acc.document_lines (
  company_id  uuid not null,
  document_id uuid not null,
  line_no     int not null check (line_no between 1 and 200),
  item_id     uuid,
  description text not null check (length(btrim(description)) between 1 and 200),
  qty         numeric(14,3) not null check (qty > 0),
  unit        text not null default '' check (length(unit) <= 20),
  unit_price  numeric(18,2) not null check (unit_price >= 0),
  amount      numeric(18,2) not null check (amount >= 0),
  account_id  uuid not null,
  primary key (company_id, document_id, line_no),
  foreign key (company_id, document_id) references acc.documents (company_id, id),
  foreign key (company_id, item_id) references acc.items (company_id, id),
  foreign key (company_id, account_id) references acc.chart_of_accounts (company_id, id)
);

-- รับชำระ/ใบลดหนี้ ตัดยอดค้างของใบไหนเท่าไร vat_transfer = ภาษีขายยังไม่ถึงกำหนดที่ถึงกำหนด (รับชำระ) หรือถูกลด (ลดหนี้)
create table acc.allocations (
  id           bigint generated always as identity primary key,
  company_id   uuid not null,
  source_id    uuid not null,
  target_id    uuid not null,
  amount       numeric(18,2) not null check (amount > 0),
  vat_transfer numeric(18,2) not null default 0 check (vat_transfer >= 0),
  foreign key (company_id, source_id) references acc.documents (company_id, id),
  foreign key (company_id, target_id) references acc.documents (company_id, id)
);
create index allocations_target on acc.allocations (company_id, target_id);
create index allocations_source on acc.allocations (company_id, source_id);

-- เอกสารที่ออกแล้วแก้ไม่ได้ เปลี่ยนได้อย่างเดียวคือบันทึกการยกเลิกครั้งเดียว (ผ่าน acc.void_document)
create function acc.guard_document_update() returns trigger
language plpgsql as $$
begin
  if old.voided_at is not null
     or (to_jsonb(new) - '{voided_at,void_entry_id,void_reason}'::text[])
        <> (to_jsonb(old) - '{voided_at,void_entry_id,void_reason}'::text[]) then
    raise exception 'เอกสารที่ออกแล้วแก้ไม่ได้ ถ้าผิดให้ยกเลิกแล้วออกใหม่' using errcode = 'ACC06';
  end if;
  return new;
end $$;
create trigger documents_guard before update on acc.documents for each row execute function acc.guard_document_update();
create trigger documents_no_delete before delete on acc.documents for each row execute function acc.forbid_mutation();
create trigger document_lines_immutable before update or delete on acc.document_lines for each row execute function acc.forbid_mutation();
create trigger allocations_immutable before update or delete on acc.allocations for each row execute function acc.forbid_mutation();
create trigger documents_locked before insert or update on acc.documents for each row execute function acc.guard_locked_company();
create trigger audit_documents after insert or update on acc.documents for each row execute function acc.audit_row();

alter table acc.documents enable row level security;
alter table acc.document_lines enable row level security;
alter table acc.allocations enable row level security;
grant select on acc.documents, acc.document_lines, acc.allocations to app_rw, app_ro;
create policy documents_read on acc.documents for select to app_rw, app_ro using (app.can_read_company(company_id));
create policy document_lines_read on acc.document_lines for select to app_rw, app_ro using (app.can_read_company(company_id));
create policy allocations_read on acc.allocations for select to app_rw, app_ro using (app.can_read_company(company_id));

-- บริษัทที่ถูกล็อกตอน migration 014 ยังไม่มีบัญชีภาษีใหม่: เพิ่มจากผังตั้งต้นตอนออกเอกสารครั้งแรก
create function acc.ensure_tax_accounts(p_company uuid) returns void
language sql security definer set search_path = acc, pg_temp as $$
  insert into acc.chart_of_accounts (company_id, code, name, type)
  select p_company, t.code, t.name, t.type from acc.coa_template t
   where t.code in ('1110', '1210', '1410', '1411', '1420', '1430', '2210', '2211', '2230', '4110', '4120', '4210', '4220', '5140')
  on conflict (company_id, code) do nothing
$$;

-- ยอดค้างของใบขายเชื่อ/ใบเพิ่มหนี้: รวม − ตัดด้วยรับชำระ/ลดหนี้ที่ยังไม่ยกเลิก
create function acc.document_settled(p_company uuid, p_target uuid, out amount numeric, out vat numeric)
language sql stable as $$
  select coalesce(sum(a.amount), 0), coalesce(sum(a.vat_transfer), 0)
    from acc.allocations a join acc.documents s on s.company_id = a.company_id and s.id = a.source_id
   where a.company_id = p_company and a.target_id = p_target and s.voided_at is null
$$;

create function acc.ar_open_items(p_company uuid)
returns table (document_id uuid, doc_no text, kind text, doc_date date, due_date date, party_code text, party_name text,
               is_service boolean, total numeric, settled numeric, open numeric, undue_vat numeric)
language sql stable as $$
  select d.id, d.doc_no, d.kind, d.doc_date, d.due_date, d.party_code, d.party_name, d.is_service, d.total,
         s.amount, d.total - s.amount, case when d.is_service then d.vat - s.vat else 0 end
    from acc.documents d cross join lateral acc.document_settled(d.company_id, d.id) s
   where d.company_id = p_company and d.kind in ('sales_invoice', 'debit_note') and d.voided_at is null
     and d.total - s.amount > 0
   order by d.due_date, d.doc_no
$$;

-- ---- ออกเอกสารขาย: sales_invoice (IV) / cash_sale (CS) / credit_note (CN) / debit_note (DN) ----
-- p: {date, party_code, is_service?, price_mode?, discount?, description?, credit_days?, cash_account?, wht_amount?,
--     ref_document_id? (ลด/เพิ่มหนี้), reason?, lines: [{item_code?, description?, qty, unit?, unit_price, account_code?}]}
create function acc.post_sales_document(p_company uuid, p_kind text, p jsonb, p_idem text) returns uuid
language plpgsql security definer set search_path = acc, pg_temp as $$
declare
  co       acc.companies;
  pa       acc.parties;
  tgt      acc.documents;
  it       acc.items;
  v_id     uuid;
  v_date   date;
  v_mode   text;
  v_rate   numeric;
  v_svc    boolean;
  v_line_svc boolean;
  v_lines  jsonb := '[]';
  v_gross  numeric := 0;
  v_disc   numeric;
  v_base   numeric; v_vat numeric; v_total numeric;
  v_open   numeric; v_undue numeric;
  v_wht    numeric := 0;
  v_cash   acc.chart_of_accounts;
  v_acc    acc.chart_of_accounts;
  v_tax    boolean;
  v_je     jsonb := '[]';
  v_share  jsonb;
  v_prefix text;
  v_desc   text;
  v_eid    uuid;
  v_credit int;
  v_qty numeric; v_price numeric; v_amt numeric;
  r record;
begin
  if not app.can_write_company(p_company) then
    raise exception 'ไม่มีสิทธิ์ออกเอกสารในบริษัทนี้' using errcode = '42501';
  end if;
  if p_kind not in ('sales_invoice', 'cash_sale', 'credit_note', 'debit_note') then
    raise exception 'ไม่รู้จักประเภทเอกสาร %', p_kind using errcode = '22023';
  end if;
  select id into v_id from acc.documents where company_id = p_company and idem_key = p_idem;
  if found then return v_id; end if; -- กดซ้ำ/เน็ตหลุดแล้วส่งใหม่ได้เอกสารเดิม
  perform acc.ensure_tax_accounts(p_company);
  select * into co from acc.companies where id = p_company;
  v_date := nullif(p->>'date', '')::date;
  if v_date is null then raise exception 'ต้องมีวันที่เอกสาร' using errcode = '22023'; end if;

  if p_kind in ('credit_note', 'debit_note') then
    select * into tgt from acc.documents
     where company_id = p_company and id = nullif(p->>'ref_document_id', '')::uuid for update;
    if not found or tgt.kind not in ('sales_invoice', 'debit_note') or tgt.voided_at is not null then
      raise exception 'ใบลด/เพิ่มหนี้ต้องอ้างใบขายเชื่อที่ยังไม่ยกเลิก' using errcode = 'ACC15';
    end if;
    if p_kind = 'debit_note' and tgt.kind <> 'sales_invoice' then
      raise exception 'ใบเพิ่มหนี้ต้องอ้างใบขายเชื่อ' using errcode = 'ACC15';
    end if;
    if length(btrim(coalesce(p->>'reason', ''))) = 0 then
      raise exception 'ใบลด/เพิ่มหนี้ต้องระบุเหตุผล' using errcode = '22023';
    end if;
    if v_date < tgt.doc_date then
      raise exception 'วันที่ต้องไม่ก่อนวันที่ของ %', tgt.doc_no using errcode = '22023';
    end if;
    select * into pa from acc.parties where company_id = p_company and id = tgt.party_id;
    v_mode := tgt.price_mode; v_rate := tgt.vat_rate; v_svc := tgt.is_service;
  else
    select * into pa from acc.parties where company_id = p_company and code = upper(p->>'party_code');
    if not found or not pa.is_customer or not pa.active then
      raise exception 'ไม่พบลูกค้ารหัส %', coalesce(p->>'party_code', '(ว่าง)') using errcode = 'ACC04';
    end if;
    if co.vat_registered then
      v_mode := coalesce(nullif(p->>'price_mode', ''), 'exclusive');
      if v_mode not in ('exclusive', 'inclusive') then
        raise exception 'แบบราคาต้องเป็นแยกภาษีหรือรวมภาษี' using errcode = '22023';
      end if;
      v_rate := co.vat_rate;
    else
      v_mode := 'none'; v_rate := 0;
    end if;
    -- ไม่ระบุ = ตามสินค้า/บริการของบรรทัดแรก (บรรทัดอื่นต้องเป็นแบบเดียวกัน)
    select i.is_service into v_svc from acc.items i
     where i.company_id = p_company and i.code = upper(p->'lines'->0->>'item_code');
    v_svc := coalesce((p->>'is_service')::boolean, v_svc, false);
  end if;

  -- รายการ: จำนวน × ราคา ปัดสตางค์ บัญชีจากรายการ/สินค้า/ค่าเริ่มต้น ทั้งใบต้องเป็นสินค้าหรือบริการอย่างเดียว
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
    exception when others then
      raise exception 'บรรทัดที่ %: จำนวนหรือราคาไม่ถูกต้อง', r.ord using errcode = 'ACC05';
    end;
    if v_qty is null or v_qty <= 0 or v_qty <> round(v_qty, 3) or v_price is null or v_price < 0 or v_price <> round(v_price, 2) then
      raise exception 'บรรทัดที่ %: จำนวนต้องมากกว่า 0 (ทศนิยมไม่เกิน 3) ราคาไม่ติดลบ (ทศนิยมไม่เกิน 2)', r.ord using errcode = 'ACC05';
    end if;
    v_amt := round(v_qty * v_price, 2);
    select * into v_acc from acc.chart_of_accounts
     where company_id = p_company and active and type = 'revenue'
       and (case when nullif(r.j->>'account_code', '') is not null then code = r.j->>'account_code'
                 when it.sales_account_id is not null and p_kind <> 'credit_note' then id = it.sales_account_id
                 when p_kind = 'credit_note' then code = '4220'
                 when v_svc then code = '4120' else code = '4110' end);
    if not found then
      raise exception 'บรรทัดที่ %: บัญชีต้องเป็นบัญชีหมวดรายได้ที่เปิดใช้', r.ord using errcode = 'ACC04';
    end if;
    v_lines := v_lines || jsonb_build_object(
      'line_no', r.ord, 'item_id', it.id,
      'description', coalesce(nullif(btrim(r.j->>'description'), ''), it.name),
      'qty', v_qty, 'unit', coalesce(nullif(r.j->>'unit', ''), it.unit, ''), 'unit_price', v_price,
      'amount', v_amt, 'account_id', v_acc.id, 'account_code', v_acc.code);
    if coalesce(nullif(btrim(r.j->>'description'), ''), it.name) is null then
      raise exception 'บรรทัดที่ %: ต้องมีรายละเอียดสินค้า/บริการ', r.ord using errcode = '22023';
    end if;
    v_gross := v_gross + v_amt;
  end loop;

  v_disc := coalesce(nullif(p->>'discount', '')::numeric, 0);
  if v_disc < 0 or v_disc <> round(v_disc, 2) or v_disc >= v_gross then
    raise exception 'ส่วนลดต้องไม่ติดลบ ทศนิยมไม่เกิน 2 ตำแหน่ง และน้อยกว่ายอดรวม' using errcode = 'ACC05';
  end if;
  select c.base, c.vat, c.total into v_base, v_vat, v_total from app.vat_calc(v_gross, v_disc, v_rate, v_mode) c;

  if p_kind = 'credit_note' then
    select tgt.total - s.amount, tgt.vat - s.vat into v_open, v_undue from acc.document_settled(p_company, tgt.id) s;
    if v_total > v_open then
      raise exception 'ลดหนี้ % ได้ไม่เกินยอดค้าง %', v_total, v_open using errcode = 'ACC15';
    end if;
    if tgt.is_service and v_vat > v_undue then
      raise exception 'ภาษีที่ลด % เกินภาษีขายยังไม่ถึงกำหนดที่เหลือ %', v_vat, v_undue using errcode = 'ACC15';
    end if;
  end if;

  if p_kind = 'cash_sale' then
    select * into v_cash from acc.chart_of_accounts
     where company_id = p_company and code = coalesce(nullif(p->>'cash_account', ''), '1110') and active and type = 'asset' and code like '11%';
    if not found then raise exception 'บัญชีรับเงินต้องเป็นบัญชีเงินสด/เงินฝาก (11xx)' using errcode = 'ACC04'; end if;
    v_wht := coalesce(nullif(p->>'wht_amount', '')::numeric, 0);
    if v_wht < 0 or v_wht <> round(v_wht, 2) or v_wht >= v_total then
      raise exception 'ภาษีที่ลูกค้าหัก ณ ที่จ่ายต้องไม่ติดลบและน้อยกว่ายอดรวม' using errcode = 'ACC05';
    end if;
  end if;

  -- ใบกำกับภาษี: บริษัทจด VAT; ขายเชื่อบริการ/ลดหรือเพิ่มหนี้ของบริการยังไม่ใช่ (ออกตอนรับเงิน)
  v_tax := co.vat_registered and (p_kind = 'cash_sale' or not v_svc);
  if v_tax and co.tax_id is null then
    raise exception 'กรอกเลขประจำตัวผู้เสียภาษีของบริษัทก่อนออกใบกำกับภาษี (ข้อมูลบริษัทและภาษี)' using errcode = 'ACC14';
  end if;

  -- ฐานภาษีกระจายเข้าบัญชีรายได้ตามสัดส่วน เศษสตางค์ให้บัญชีที่ยอดมากที่สุด รวมเท่าฐานพอดี
  select coalesce(jsonb_agg(x), '[]') into v_share from (
    select a.code, trunc(v_base * a.amt / v_gross, 2)
             + case when a.rn = 1 then v_base - sum(trunc(v_base * a.amt / v_gross, 2)) over () else 0 end as share
      from (select l->>'account_code' as code, sum((l->>'amount')::numeric) as amt,
                   row_number() over (order by sum((l->>'amount')::numeric) desc, l->>'account_code') as rn
              from jsonb_array_elements(v_lines) l group by 1) a) x
   where x.share > 0;

  v_desc := coalesce(nullif(btrim(p->>'description'), ''), case p_kind
    when 'sales_invoice' then 'ขายเชื่อ ' || pa.name when 'cash_sale' then 'ขายสด ' || pa.name
    when 'credit_note' then 'ลดหนี้ ' || tgt.doc_no || ' ' || pa.name else 'เพิ่มหนี้ ' || tgt.doc_no || ' ' || pa.name end);
  v_prefix := case p_kind when 'sales_invoice' then 'IV' when 'cash_sale' then 'CS' when 'credit_note' then 'CN' else 'DN' end;

  if p_kind = 'credit_note' then
    select jsonb_agg(jsonb_build_object('account_code', x->>'code', 'debit', x->>'share', 'memo', pa.name)) into v_je from jsonb_array_elements(v_share) x;
    if v_vat > 0 then v_je := v_je || jsonb_build_object('account_code', case when v_svc then '2211' else '2210' end, 'debit', v_vat::text); end if;
    v_je := v_je || jsonb_build_object('account_code', '1210', 'credit', v_total::text, 'memo', pa.name);
  else
    if p_kind = 'cash_sale' then
      v_je := jsonb_build_array(jsonb_build_object('account_code', v_cash.code, 'debit', (v_total - v_wht)::text, 'memo', pa.name));
      if v_wht > 0 then v_je := v_je || jsonb_build_object('account_code', '1420', 'debit', v_wht::text, 'memo', pa.name); end if;
    else
      v_je := jsonb_build_array(jsonb_build_object('account_code', '1210', 'debit', v_total::text, 'memo', pa.name));
    end if;
    select v_je || coalesce(jsonb_agg(jsonb_build_object('account_code', x->>'code', 'credit', x->>'share')), '[]') into v_je from jsonb_array_elements(v_share) x;
    if v_vat > 0 then
      v_je := v_je || jsonb_build_object('account_code',
        case when v_svc and p_kind <> 'cash_sale' then '2211' else '2210' end, 'credit', v_vat::text);
    end if;
  end if;

  v_eid := acc.post_journal(p_company, v_date, v_desc, v_je, p_idem, v_prefix, null);
  select id into v_id from acc.documents where company_id = p_company and entry_id = v_eid;
  if found then return v_id; end if; -- คำขอซ้ำที่รอคำขอแรกจบ

  v_credit := case when p_kind in ('sales_invoice', 'debit_note')
                   then coalesce(nullif(p->>'credit_days', '')::int, pa.credit_days) end;
  insert into acc.documents (company_id, kind, doc_no, doc_date, party_id, party_code, party_name, party_tax_id, party_branch_no,
      party_address, seller_name, seller_tax_id, seller_branch_no, seller_address, is_service, is_tax_invoice, price_mode, vat_rate,
      gross, discount, base, vat, total, wht_amount, cash_account_id, credit_days, due_date, ref_document_id, reason, description,
      entry_id, idem_key, created_by)
  select p_company, p_kind, e.doc_no, v_date, pa.id, pa.code, pa.name, pa.tax_id, pa.branch_no, pa.address,
         co.name, co.tax_id, co.branch_no, co.address, v_svc, v_tax, v_mode, v_rate,
         v_gross, v_disc, v_base, v_vat, v_total, v_wht, v_cash.id, v_credit, v_date + v_credit, tgt.id,
         nullif(btrim(p->>'reason'), ''), coalesce(btrim(p->>'description'), ''), v_eid, p_idem, app.current_user_id()
    from acc.journal_entries e where e.company_id = p_company and e.id = v_eid
  returning id into v_id;

  insert into acc.document_lines (company_id, document_id, line_no, item_id, description, qty, unit, unit_price, amount, account_id)
  select p_company, v_id, (l->>'line_no')::int, nullif(l->>'item_id', '')::uuid, l->>'description', (l->>'qty')::numeric,
         l->>'unit', (l->>'unit_price')::numeric, (l->>'amount')::numeric, (l->>'account_id')::uuid
    from jsonb_array_elements(v_lines) l;

  if p_kind = 'credit_note' then
    insert into acc.allocations (company_id, source_id, target_id, amount, vat_transfer)
    values (p_company, v_id, tgt.id, v_total, case when tgt.is_service then v_vat else 0 end);
  end if;
  return v_id;
end $$;

-- ---- รับชำระ (RE): ตัดใบขายเชื่อ/ใบเพิ่มหนี้ ลูกค้าหัก ณ ที่จ่ายได้ บริการ: ภาษีขายยังไม่ถึงกำหนด → ภาษีขาย ตามสัดส่วนเงินที่รับ ----
-- p: {date, party_code, cash_account?, wht_amount?, description?, allocations: [{document_id, amount}]}
create function acc.post_receipt(p_company uuid, p jsonb, p_idem text) returns uuid
language plpgsql security definer set search_path = acc, pg_temp as $$
declare
  co      acc.companies;
  pa      acc.parties;
  tgt     acc.documents;
  v_cash  acc.chart_of_accounts;
  v_id    uuid;
  v_date  date;
  v_amt   numeric;
  v_open  numeric; v_undue numeric; v_tr numeric;
  v_total numeric := 0; v_vat numeric := 0; v_wht numeric;
  v_svc   boolean := false;
  v_tax   boolean;
  v_allocs jsonb := '[]';
  v_je    jsonb;
  v_eid   uuid;
  r record;
begin
  if not app.can_write_company(p_company) then
    raise exception 'ไม่มีสิทธิ์ออกเอกสารในบริษัทนี้' using errcode = '42501';
  end if;
  select id into v_id from acc.documents where company_id = p_company and idem_key = p_idem;
  if found then return v_id; end if;
  perform acc.ensure_tax_accounts(p_company);
  select * into co from acc.companies where id = p_company;
  v_date := nullif(p->>'date', '')::date;
  if v_date is null then raise exception 'ต้องมีวันที่เอกสาร' using errcode = '22023'; end if;
  select * into pa from acc.parties where company_id = p_company and code = upper(p->>'party_code');
  if not found or not pa.is_customer then
    raise exception 'ไม่พบลูกค้ารหัส %', coalesce(p->>'party_code', '(ว่าง)') using errcode = 'ACC04';
  end if;
  select * into v_cash from acc.chart_of_accounts
   where company_id = p_company and code = coalesce(nullif(p->>'cash_account', ''), '1110') and active and type = 'asset' and code like '11%';
  if not found then raise exception 'บัญชีรับเงินต้องเป็นบัญชีเงินสด/เงินฝาก (11xx)' using errcode = 'ACC04'; end if;
  if jsonb_typeof(p->'allocations') is distinct from 'array' or jsonb_array_length(p->'allocations') not between 1 and 50 then
    raise exception 'ต้องเลือกใบที่รับชำระ 1–50 ใบ' using errcode = '22023';
  end if;

  -- ล็อกใบที่ถูกตัดตามลำดับ id (กันตัดเกินเมื่อรับพร้อมกัน และกัน deadlock)
  for r in select (a->>'document_id')::uuid as did, a->>'amount' as amt, count(*) over (partition by a->>'document_id') as dup
             from jsonb_array_elements(p->'allocations') a order by 1 loop
    if r.dup > 1 then raise exception 'เลือกใบเดียวกันซ้ำ' using errcode = '22023'; end if;
    select * into tgt from acc.documents where company_id = p_company and id = r.did for update;
    if not found or tgt.kind not in ('sales_invoice', 'debit_note') or tgt.voided_at is not null or tgt.party_id <> pa.id then
      raise exception 'รับชำระได้เฉพาะใบขายเชื่อ/ใบเพิ่มหนี้ของลูกค้ารายนี้ที่ยังไม่ยกเลิก' using errcode = 'ACC15';
    end if;
    if tgt.doc_date > v_date then
      raise exception 'วันที่รับชำระต้องไม่ก่อนวันที่ของ %', tgt.doc_no using errcode = '22023';
    end if;
    begin v_amt := r.amt::numeric; exception when others then v_amt := null; end;
    if v_amt is null or v_amt <= 0 or v_amt <> round(v_amt, 2) then
      raise exception '%: จำนวนเงินต้องมากกว่า 0 ทศนิยมไม่เกิน 2 ตำแหน่ง', tgt.doc_no using errcode = 'ACC05';
    end if;
    select tgt.total - s.amount, tgt.vat - s.vat into v_open, v_undue from acc.document_settled(p_company, tgt.id) s;
    if v_amt > v_open then
      raise exception '% ค้างอยู่ % รับเกินยอดค้างไม่ได้', tgt.doc_no, v_open using errcode = 'ACC15';
    end if;
    v_tr := 0;
    if tgt.is_service and v_undue > 0 then
      v_tr := case when v_amt = v_open then v_undue else round(v_amt * v_undue / v_open, 2) end;
      v_svc := true;
    end if;
    v_total := v_total + v_amt; v_vat := v_vat + v_tr;
    v_allocs := v_allocs || jsonb_build_object('target', tgt.id, 'doc_no', tgt.doc_no, 'amount', v_amt, 'vat', v_tr);
  end loop;

  v_wht := coalesce(nullif(p->>'wht_amount', '')::numeric, 0);
  if v_wht < 0 or v_wht <> round(v_wht, 2) or v_wht >= v_total then
    raise exception 'ภาษีที่ลูกค้าหัก ณ ที่จ่ายต้องไม่ติดลบและน้อยกว่ายอดรับชำระ' using errcode = 'ACC05';
  end if;
  -- รับชำระค่าบริการ = ใบเสร็จรับเงิน/ใบกำกับภาษี
  v_tax := co.vat_registered and v_svc;
  if v_tax and co.tax_id is null then
    raise exception 'กรอกเลขประจำตัวผู้เสียภาษีของบริษัทก่อนออกใบกำกับภาษี (ข้อมูลบริษัทและภาษี)' using errcode = 'ACC14';
  end if;

  v_je := jsonb_build_array(jsonb_build_object('account_code', v_cash.code, 'debit', (v_total - v_wht)::text, 'memo', pa.name));
  if v_wht > 0 then v_je := v_je || jsonb_build_object('account_code', '1420', 'debit', v_wht::text, 'memo', pa.name); end if;
  if v_vat > 0 then v_je := v_je || jsonb_build_object('account_code', '2211', 'debit', v_vat::text); end if;
  v_je := v_je || jsonb_build_object('account_code', '1210', 'credit', v_total::text, 'memo', pa.name);
  if v_vat > 0 then v_je := v_je || jsonb_build_object('account_code', '2210', 'credit', v_vat::text); end if;

  v_eid := acc.post_journal(p_company, v_date, coalesce(nullif(btrim(p->>'description'), ''), 'รับชำระ ' || pa.name), v_je, p_idem, 'RE', null);
  select id into v_id from acc.documents where company_id = p_company and entry_id = v_eid;
  if found then return v_id; end if;

  insert into acc.documents (company_id, kind, doc_no, doc_date, party_id, party_code, party_name, party_tax_id, party_branch_no,
      party_address, seller_name, seller_tax_id, seller_branch_no, seller_address, is_service, is_tax_invoice, price_mode, vat_rate,
      gross, discount, base, vat, total, wht_amount, cash_account_id, description, entry_id, idem_key, created_by)
  select p_company, 'receipt', e.doc_no, v_date, pa.id, pa.code, pa.name, pa.tax_id, pa.branch_no, pa.address,
         co.name, co.tax_id, co.branch_no, co.address, v_svc, v_tax, case when v_vat > 0 then 'inclusive' else 'none' end, co.vat_rate,
         v_total, 0, v_total - v_vat, v_vat, v_total, v_wht, v_cash.id, coalesce(btrim(p->>'description'), ''), v_eid, p_idem,
         app.current_user_id()
    from acc.journal_entries e where e.company_id = p_company and e.id = v_eid
  returning id into v_id;

  insert into acc.document_lines (company_id, document_id, line_no, description, qty, unit_price, amount, account_id)
  select p_company, v_id, a.ord::int, 'รับชำระ ' || (a.value->>'doc_no'), 1, (a.value->>'amount')::numeric, (a.value->>'amount')::numeric,
         (select id from acc.chart_of_accounts where company_id = p_company and code = '1210')
    from jsonb_array_elements(v_allocs) with ordinality a(value, ord);
  insert into acc.allocations (company_id, source_id, target_id, amount, vat_transfer)
  select p_company, v_id, (a->>'target')::uuid, (a->>'amount')::numeric, (a->>'vat')::numeric from jsonb_array_elements(v_allocs) a;
  return v_id;
end $$;

-- ---- ยกเลิกเอกสาร: กลับรายการบัญชี (RV) แล้วทำเครื่องหมาย ใบที่ถูกรับชำระ/ลดหนี้/เพิ่มหนี้อยู่ ต้องยกเลิกใบเหล่านั้นก่อน ----
create function acc.void_document(p_company uuid, p_document uuid, p_date date, p_reason text, p_idem text) returns uuid
language plpgsql security definer set search_path = acc, pg_temp as $$
declare
  d    acc.documents;
  v_rv uuid;
begin
  if not app.can_write_company(p_company) then
    raise exception 'ไม่มีสิทธิ์ยกเลิกเอกสารในบริษัทนี้' using errcode = '42501';
  end if;
  select * into d from acc.documents where company_id = p_company and id = p_document for update;
  if not found then raise exception 'ไม่พบเอกสาร' using errcode = 'ACC04'; end if;
  if d.voided_at is not null then
    if exists (select 1 from acc.idempotency_keys where company_id = p_company and key = p_idem and entry_id = d.void_entry_id) then
      return d.void_entry_id; -- คำขอซ้ำ
    end if;
    raise exception '% ยกเลิกไปแล้ว', d.doc_no using errcode = 'ACC16';
  end if;
  if length(btrim(coalesce(p_reason, ''))) = 0 then
    raise exception 'ต้องระบุเหตุผลที่ยกเลิก' using errcode = '22023';
  end if;
  if exists (select 1 from acc.allocations a join acc.documents s on s.company_id = a.company_id and s.id = a.source_id
              where a.company_id = p_company and a.target_id = d.id and s.voided_at is null)
     or exists (select 1 from acc.documents x where x.company_id = p_company and x.ref_document_id = d.id and x.voided_at is null) then
    raise exception '% มีรับชำระ/ใบลดหนี้/ใบเพิ่มหนี้อ้างอยู่ ยกเลิกใบเหล่านั้นก่อน', d.doc_no using errcode = 'ACC16';
  end if;
  v_rv := acc.reverse_journal(p_company, d.entry_id, p_date, p_idem, 'ยกเลิก ' || d.doc_no || ': ' || btrim(p_reason));
  update acc.documents set voided_at = now(), void_entry_id = v_rv, void_reason = btrim(p_reason)
   where company_id = p_company and id = d.id;
  return v_rv;
end $$;

revoke all on function acc.ensure_tax_accounts(uuid), acc.post_sales_document(uuid, text, jsonb, text),
  acc.post_receipt(uuid, jsonb, text), acc.void_document(uuid, uuid, date, text, text) from public;
grant execute on function acc.post_sales_document(uuid, text, jsonb, text), acc.post_receipt(uuid, jsonb, text),
  acc.void_document(uuid, uuid, date, text, text) to app_rw;
grant execute on function acc.document_settled(uuid, uuid), acc.ar_open_items(uuid) to app_rw, app_ro;

-- migrate:down
drop function acc.void_document(uuid, uuid, date, text, text), acc.post_receipt(uuid, jsonb, text),
  acc.post_sales_document(uuid, text, jsonb, text), acc.ar_open_items(uuid), acc.document_settled(uuid, uuid),
  acc.ensure_tax_accounts(uuid), acc.guard_document_update();
drop table acc.allocations, acc.document_lines, acc.documents;
drop function app.vat_calc(numeric, numeric, numeric, text);
