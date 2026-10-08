-- migrate:up
-- เฟส 2.3 ซื้อ: ซื้อเชื่อ (PI) ซื้อสด (CP) ใบลดหนี้จากผู้ขาย (PN) จ่ายชำระ (PV) หนังสือรับรองหัก ณ ที่จ่าย 50 ทวิ (WT) ยกเลิก
-- แยกตารางจากเอกสารขาย: ฝั่งซื้อเก็บเลขที่ใบกำกับของผู้ขาย ภาษีซื้อขอคืนได้หรือไม่ และหัก ณ ที่จ่ายที่เราเป็นผู้จ่าย
-- ทุกเอกสารลงบัญชีผ่าน acc.post_journal: ดุลแน่นอน เลขที่ไม่ข้าม กันกดซ้ำ ปิดงวด ล็อกตอนส่งงาน (docs/phase2-spec.md ข้อ 5)

create table acc.purchase_documents (
  id               uuid not null default gen_random_uuid(),
  company_id       uuid not null references acc.companies(id),
  kind             text not null check (kind in ('purchase_invoice', 'cash_purchase', 'purchase_credit_note', 'payment')),
  doc_no           text not null,
  doc_date         date not null,  -- วันที่ในใบกำกับของผู้ขาย: ภาษีซื้อขอคืนในเดือนนี้ (T6)
  vendor_doc_no    text check (length(btrim(vendor_doc_no)) between 1 and 40),
  party_id         uuid not null,
  party_code       text not null,
  party_name       text not null,
  party_tax_id     text,
  party_branch_no  text not null,
  party_address    text not null,
  is_service       boolean not null,  -- บริการ: ภาษีซื้อถึงกำหนดเมื่อจ่ายเงิน (T4)
  vat_claimable    boolean not null,  -- บริษัทจด VAT และใบมีภาษี: ลงภาษีซื้อ ไม่อย่างนั้นภาษีรวมเป็นต้นทุน (T7)
  price_mode       text not null check (price_mode in ('exclusive', 'inclusive', 'none')),
  vat_rate         numeric(5,2) not null,
  gross            numeric(18,2) not null check (gross >= 0),
  discount         numeric(18,2) not null default 0 check (discount >= 0),
  base             numeric(18,2) not null check (base >= 0),
  vat              numeric(18,2) not null check (vat >= 0),
  total            numeric(18,2) not null check (total > 0),
  wht_kind         text check (wht_kind in ('transport', 'advertising', 'service', 'professional', 'rent', 'other')),
  wht_rate         numeric(5,2) check (wht_rate > 0 and wht_rate <= 15),
  wht_base         numeric(18,2) not null default 0 check (wht_base >= 0),
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
  foreign key (company_id, ref_document_id) references acc.purchase_documents (company_id, id),
  check (base + vat = total and gross - discount in (base, total)),
  check ((voided_at is null) = (void_entry_id is null)),
  check ((wht_amount > 0) = (wht_kind is not null) and (wht_kind is null) = (wht_rate is null)),
  check ((kind = 'payment') = (vendor_doc_no is null))
);
create index purchase_documents_party on acc.purchase_documents (company_id, party_id, doc_date);
create index purchase_documents_ref on acc.purchase_documents (company_id, ref_document_id) where ref_document_id is not null;
-- ใบของผู้ขายใบเดียวบันทึกซ้ำไม่ได้ (ซื้อเชื่อ/ซื้อสดใช้ชุดเดียวกัน ใบลดหนี้อีกชุด) ยกเลิกแล้วบันทึกใหม่ได้
create unique index purchase_documents_vendor_doc on acc.purchase_documents
  (company_id, party_id, (kind = 'purchase_credit_note'), upper(btrim(vendor_doc_no)))
  where voided_at is null and kind <> 'payment';

create table acc.purchase_document_lines (
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
  foreign key (company_id, document_id) references acc.purchase_documents (company_id, id),
  foreign key (company_id, item_id) references acc.items (company_id, id),
  foreign key (company_id, account_id) references acc.chart_of_accounts (company_id, id)
);

-- จ่ายชำระ/ใบลดหนี้ตัดใบซื้อเชื่อใบไหนเท่าไร · vat_transfer = ภาษีซื้อบริการที่ถึงกำหนดด้วยการจ่ายนี้
create table acc.purchase_allocations (
  id           bigint generated always as identity primary key,
  company_id   uuid not null,
  source_id    uuid not null,
  target_id    uuid not null,
  amount       numeric(18,2) not null check (amount > 0),
  vat_transfer numeric(18,2) not null default 0 check (vat_transfer >= 0),
  wht_base     numeric(18,2) not null default 0 check (wht_base >= 0),
  foreign key (company_id, source_id) references acc.purchase_documents (company_id, id),
  foreign key (company_id, target_id) references acc.purchase_documents (company_id, id)
);
create index purchase_allocations_target on acc.purchase_allocations (company_id, target_id);
create index purchase_allocations_source on acc.purchase_allocations (company_id, source_id);

-- หนังสือรับรองการหักภาษี ณ ที่จ่าย (50 ทวิ) หนึ่งใบต่อการจ่าย เก็บสำเนาผู้จ่าย/ผู้ถูกหัก ณ วันที่ออก
-- แบบ: เลขผู้เสียภาษีขึ้นต้น 0 = นิติบุคคล (ภ.ง.ด.53) นอกนั้นบุคคลธรรมดา (ภ.ง.ด.3)
create table acc.wht_certificates (
  id             uuid not null default gen_random_uuid(),
  company_id     uuid not null references acc.companies(id),
  cert_no        text not null,
  document_id    uuid not null,
  cert_date      date not null,
  form           text not null check (form in ('pnd3', 'pnd53')),
  payer_name     text not null,
  payer_tax_id   text,
  payer_branch_no text not null,
  payer_address  text not null,
  payee_name     text not null,
  payee_tax_id   text not null,
  payee_branch_no text not null,
  payee_address  text not null,
  wht_kind       text not null check (wht_kind in ('transport', 'advertising', 'service', 'professional', 'rent', 'other')),
  wht_rate       numeric(5,2) not null check (wht_rate > 0 and wht_rate <= 15),
  base           numeric(18,2) not null check (base > 0),
  amount         numeric(18,2) not null check (amount > 0 and amount < base),
  voided_at      timestamptz,
  created_at     timestamptz not null default now(),
  primary key (company_id, id),
  unique (company_id, cert_no),
  unique (company_id, document_id),
  foreign key (company_id, document_id) references acc.purchase_documents (company_id, id)
);

create function acc.guard_purchase_update() returns trigger
language plpgsql as $$
begin
  if old.voided_at is not null
     or (to_jsonb(new) - '{voided_at,void_entry_id,void_reason}'::text[])
        <> (to_jsonb(old) - '{voided_at,void_entry_id,void_reason}'::text[]) then
    raise exception 'เอกสารที่บันทึกแล้วแก้ไม่ได้ ถ้าผิดให้ยกเลิกแล้วบันทึกใหม่' using errcode = 'ACC06';
  end if;
  return new;
end $$;
create function acc.guard_certificate_update() returns trigger
language plpgsql as $$
begin
  if old.voided_at is not null or (to_jsonb(new) - 'voided_at') <> (to_jsonb(old) - 'voided_at') then
    raise exception 'หนังสือรับรองที่ออกแล้วแก้ไม่ได้' using errcode = 'ACC06';
  end if;
  return new;
end $$;
create trigger purchase_documents_guard before update on acc.purchase_documents for each row execute function acc.guard_purchase_update();
create trigger purchase_documents_no_delete before delete on acc.purchase_documents for each row execute function acc.forbid_mutation();
create trigger purchase_lines_immutable before update or delete on acc.purchase_document_lines for each row execute function acc.forbid_mutation();
create trigger purchase_allocations_immutable before update or delete on acc.purchase_allocations for each row execute function acc.forbid_mutation();
create trigger wht_certificates_guard before update on acc.wht_certificates for each row execute function acc.guard_certificate_update();
create trigger wht_certificates_no_delete before delete on acc.wht_certificates for each row execute function acc.forbid_mutation();
create trigger purchase_documents_locked before insert or update on acc.purchase_documents for each row execute function acc.guard_locked_company();
create trigger audit_purchase_documents after insert or update on acc.purchase_documents for each row execute function acc.audit_row();
create trigger audit_wht_certificates after insert or update on acc.wht_certificates for each row execute function acc.audit_row();

alter table acc.purchase_documents enable row level security;
alter table acc.purchase_document_lines enable row level security;
alter table acc.purchase_allocations enable row level security;
alter table acc.wht_certificates enable row level security;
grant select on acc.purchase_documents, acc.purchase_document_lines, acc.purchase_allocations, acc.wht_certificates to app_rw, app_ro;
create policy purchase_documents_read on acc.purchase_documents for select to app_rw, app_ro using (app.can_read_company(company_id));
create policy purchase_lines_read on acc.purchase_document_lines for select to app_rw, app_ro using (app.can_read_company(company_id));
create policy purchase_allocations_read on acc.purchase_allocations for select to app_rw, app_ro using (app.can_read_company(company_id));
create policy wht_certificates_read on acc.wht_certificates for select to app_rw, app_ro using (app.can_read_company(company_id));

-- บัญชีที่ฝั่งซื้อใช้ (บริษัทที่ลบหรือไม่เคยมีรหัสเหล่านี้ได้คืนจากแม่แบบเมื่อบันทึกครั้งแรก)
create function acc.ensure_purchase_accounts(p_company uuid) returns void
language sql security definer set search_path = acc, pg_temp as $$
  insert into acc.chart_of_accounts (company_id, code, name, type)
  select p_company, t.code, t.name, t.type from acc.coa_template t
   where t.code in ('1110', '1410', '1411', '2110', '2230', '5110', '5140', '5260')
  on conflict (company_id, code) do nothing
$$;

-- อัตรามาตรฐานหัก ณ ที่จ่าย (T5) ประเภท other ต้องใส่อัตราเอง
create function acc.wht_standard_rate(p_kind text) returns numeric
language sql immutable as $$
  select case p_kind when 'transport' then 1 when 'advertising' then 2 when 'service' then 3
                     when 'professional' then 3 when 'rent' then 5 end::numeric
$$;

create function acc.purchase_settled(p_company uuid, p_target uuid, out amount numeric, out vat numeric)
language sql stable as $$
  select coalesce(sum(a.amount), 0), coalesce(sum(a.vat_transfer), 0)
    from acc.purchase_allocations a join acc.purchase_documents s on s.company_id = a.company_id and s.id = a.source_id
   where a.company_id = p_company and a.target_id = p_target and s.voided_at is null
$$;

create function acc.ap_open_items(p_company uuid)
returns table (document_id uuid, doc_no text, vendor_doc_no text, doc_date date, due_date date, party_code text, party_name text,
               is_service boolean, total numeric, settled numeric, open numeric, undue_vat numeric)
language sql stable as $$
  select d.id, d.doc_no, d.vendor_doc_no, d.doc_date, d.due_date, d.party_code, d.party_name, d.is_service, d.total,
         s.amount, d.total - s.amount, case when d.is_service and d.vat_claimable then d.vat - s.vat else 0 end
    from acc.purchase_documents d cross join lateral acc.purchase_settled(d.company_id, d.id) s
   where d.company_id = p_company and d.kind = 'purchase_invoice' and d.voided_at is null
     and d.total - s.amount > 0
   order by d.due_date, d.doc_no
$$;

-- ออก 50 ทวิ ให้เอกสารที่จ่ายเงิน (ซื้อสด/จ่ายชำระ) เลข WT ต่อเนื่องในทรานแซกชันเดียวกับเอกสาร
create function acc.issue_wht_certificate(p_company uuid, p_document uuid) returns void
language plpgsql security definer set search_path = acc, pg_temp as $$
declare
  d    acc.purchase_documents;
  co   acc.companies;
  v_no bigint;
begin
  select * into d from acc.purchase_documents where company_id = p_company and id = p_document;
  select * into co from acc.companies where id = p_company;
  insert into acc.document_sequences (company_id, prefix, last_no) values (p_company, 'WT', 1)
  on conflict (company_id, prefix) do update set last_no = acc.document_sequences.last_no + 1
  returning last_no into v_no;
  insert into acc.wht_certificates (company_id, cert_no, document_id, cert_date, form, payer_name, payer_tax_id, payer_branch_no,
      payer_address, payee_name, payee_tax_id, payee_branch_no, payee_address, wht_kind, wht_rate, base, amount)
  values (p_company, 'WT-' || lpad(v_no::text, 4, '0'), d.id, d.doc_date,
          case when d.party_tax_id like '0%' then 'pnd53' else 'pnd3' end,
          co.name, co.tax_id, co.branch_no, co.address, d.party_name, d.party_tax_id, d.party_branch_no, d.party_address,
          d.wht_kind, d.wht_rate, d.wht_base, d.wht_amount);
end $$;

-- อัตราหัก ณ ที่จ่ายจาก payload: ไม่ระบุประเภท = ไม่หัก · ไม่ระบุอัตรา = อัตรามาตรฐานของประเภท
create function acc.wht_rate_from(p jsonb, out kind text, out rate numeric)
language plpgsql immutable as $$
begin
  kind := nullif(p->>'wht_kind', '');
  if kind is null then rate := null; return; end if;
  if kind not in ('transport', 'advertising', 'service', 'professional', 'rent', 'other') then
    raise exception 'ไม่รู้จักประเภทหัก ณ ที่จ่าย %', kind using errcode = '22023';
  end if;
  begin
    rate := coalesce(nullif(p->>'wht_rate', '')::numeric, acc.wht_standard_rate(kind));
  exception when others then
    raise exception 'อัตราหัก ณ ที่จ่ายไม่ถูกต้อง' using errcode = 'ACC05';
  end;
  if rate is null or rate <= 0 or rate > 15 or rate <> round(rate, 2) then
    raise exception 'อัตราหัก ณ ที่จ่ายต้องมากกว่า 0 ไม่เกิน 15%% ทศนิยมไม่เกิน 2 ตำแหน่ง' using errcode = 'ACC05';
  end if;
end $$;

-- ---- บันทึกซื้อ: purchase_invoice (PI) / cash_purchase (CP) / purchase_credit_note (PN) ----
-- p: {date, party_code, vendor_doc_no, is_service?, price_mode?, discount?, description?, credit_days?, cash_account?,
--     wht_kind?, wht_rate?, ref_document_id?, reason?, lines: [{item_code?, description?, qty, unit?, unit_price, account_code?}]}
create function acc.post_purchase_document(p_company uuid, p_kind text, p jsonb, p_idem text) returns uuid
language plpgsql security definer set search_path = acc, pg_temp as $$
declare
  co       acc.companies;
  pa       acc.parties;
  tgt      acc.purchase_documents;
  it       acc.items;
  v_id     uuid;
  v_date   date;
  v_vdoc   text;
  v_mode   text;
  v_rate   numeric;
  v_svc    boolean;
  v_line_svc boolean;
  v_claim  boolean;
  v_lines  jsonb := '[]';
  v_gross  numeric := 0;
  v_disc   numeric;
  v_base   numeric; v_vat numeric; v_total numeric;
  v_open   numeric; v_undue numeric;
  v_wkind  text; v_wrate numeric; v_wbase numeric := 0; v_wht numeric := 0;
  v_cash   acc.chart_of_accounts;
  v_acc    acc.chart_of_accounts;
  v_ref_acc uuid;
  v_split  numeric;
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
    raise exception 'ไม่มีสิทธิ์บันทึกเอกสารในบริษัทนี้' using errcode = '42501';
  end if;
  if p_kind not in ('purchase_invoice', 'cash_purchase', 'purchase_credit_note') then
    raise exception 'ไม่รู้จักประเภทเอกสาร %', p_kind using errcode = '22023';
  end if;
  select id into v_id from acc.purchase_documents where company_id = p_company and idem_key = p_idem;
  if found then return v_id; end if; -- กดซ้ำ/เน็ตหลุดแล้วส่งใหม่ได้เอกสารเดิม
  perform acc.ensure_purchase_accounts(p_company);
  select * into co from acc.companies where id = p_company;
  v_date := nullif(p->>'date', '')::date;
  if v_date is null then raise exception 'ต้องมีวันที่เอกสาร' using errcode = '22023'; end if;
  v_vdoc := nullif(btrim(coalesce(p->>'vendor_doc_no', '')), '');
  if v_vdoc is null or length(v_vdoc) > 40 then
    raise exception 'ต้องใส่เลขที่เอกสารของผู้ขาย (ไม่เกิน 40 ตัว)' using errcode = '22023';
  end if;

  if p_kind = 'purchase_credit_note' then
    select * into tgt from acc.purchase_documents
     where company_id = p_company and id = nullif(p->>'ref_document_id', '')::uuid for update;
    if not found or tgt.kind <> 'purchase_invoice' or tgt.voided_at is not null then
      raise exception 'ใบลดหนี้ต้องอ้างใบซื้อเชื่อที่ยังไม่ยกเลิก' using errcode = 'ACC15';
    end if;
    if length(btrim(coalesce(p->>'reason', ''))) = 0 then
      raise exception 'ใบลดหนี้ต้องระบุเหตุผล' using errcode = '22023';
    end if;
    if v_date < tgt.doc_date then
      raise exception 'วันที่ต้องไม่ก่อนวันที่ของ %', tgt.doc_no using errcode = '22023';
    end if;
    select * into pa from acc.parties where company_id = p_company and id = tgt.party_id;
    v_mode := tgt.price_mode; v_rate := tgt.vat_rate; v_svc := tgt.is_service;
    select l.account_id into v_ref_acc from acc.purchase_document_lines l
     where l.company_id = p_company and l.document_id = tgt.id order by l.line_no limit 1;
  else
    select * into pa from acc.parties where company_id = p_company and code = upper(p->>'party_code');
    if not found or not pa.is_vendor or not pa.active then
      raise exception 'ไม่พบผู้ขายรหัส %', coalesce(p->>'party_code', '(ว่าง)') using errcode = 'ACC04';
    end if;
    -- ผู้ขายไม่จด VAT เรียกเก็บภาษีไม่ได้
    if pa.vat_registered then
      v_mode := coalesce(nullif(p->>'price_mode', ''), 'exclusive');
      if v_mode not in ('exclusive', 'inclusive') then
        raise exception 'แบบราคาต้องเป็นแยกภาษีหรือรวมภาษี' using errcode = '22023';
      end if;
      v_rate := co.vat_rate;
    else
      v_mode := 'none'; v_rate := 0;
    end if;
    select i.is_service into v_svc from acc.items i
     where i.company_id = p_company and i.code = upper(p->'lines'->0->>'item_code');
    v_svc := coalesce((p->>'is_service')::boolean, v_svc, false);
  end if;

  if exists (select 1 from acc.purchase_documents x
              where x.company_id = p_company and x.party_id = pa.id and x.voided_at is null and x.kind <> 'payment'
                and (x.kind = 'purchase_credit_note') = (p_kind = 'purchase_credit_note')
                and upper(btrim(x.vendor_doc_no)) = upper(v_vdoc)) then
    raise exception 'บันทึกเอกสารเลขที่ % ของผู้ขายรายนี้ไปแล้ว', v_vdoc using errcode = 'ACC15';
  end if;

  -- รายการ: จำนวน × ราคา ปัดสตางค์ ทั้งใบเป็นสินค้าหรือบริการอย่างเดียว
  -- บัญชี: ที่ระบุ > ของสินค้า > ใบลดหนี้ (สินค้า 5140 / บริการ บัญชีเดิม) > ซื้อสินค้า 5110 / ค่าใช้จ่ายเบ็ดเตล็ด 5260
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
     where company_id = p_company and active
       and (type = 'expense' or (type = 'asset' and left(code, 2) in ('13', '15', '16')))
       and (case when nullif(r.j->>'account_code', '') is not null then code = r.j->>'account_code'
                 when it.purchase_account_id is not null and p_kind <> 'purchase_credit_note' then id = it.purchase_account_id
                 when p_kind = 'purchase_credit_note' and not v_svc then code = '5140'
                 when p_kind = 'purchase_credit_note' then id = v_ref_acc
                 when v_svc then code = '5260' else code = '5110' end);
    if not found then
      raise exception 'บรรทัดที่ %: บัญชีต้องเป็นค่าใช้จ่าย หรือสินทรัพย์ (สินค้า 13xx / จ่ายล่วงหน้า 15xx / ถาวร 16xx) ที่เปิดใช้', r.ord using errcode = 'ACC04';
    end if;
    if coalesce(nullif(btrim(r.j->>'description'), ''), it.name) is null then
      raise exception 'บรรทัดที่ %: ต้องมีรายละเอียดสินค้า/บริการ', r.ord using errcode = '22023';
    end if;
    v_lines := v_lines || jsonb_build_object(
      'line_no', r.ord, 'item_id', it.id,
      'description', coalesce(nullif(btrim(r.j->>'description'), ''), it.name),
      'qty', v_qty, 'unit', coalesce(nullif(r.j->>'unit', ''), it.unit, ''), 'unit_price', v_price,
      'amount', v_amt, 'account_id', v_acc.id, 'account_code', v_acc.code);
    v_gross := v_gross + v_amt;
  end loop;

  v_disc := coalesce(nullif(p->>'discount', '')::numeric, 0);
  if v_disc < 0 or v_disc <> round(v_disc, 2) or v_disc >= v_gross then
    raise exception 'ส่วนลดต้องไม่ติดลบ ทศนิยมไม่เกิน 2 ตำแหน่ง และน้อยกว่ายอดรวม' using errcode = 'ACC05';
  end if;
  select c.base, c.vat, c.total into v_base, v_vat, v_total from app.vat_calc(v_gross, v_disc, v_rate, v_mode) c;
  v_claim := co.vat_registered and v_vat > 0;
  if p_kind = 'purchase_credit_note' then
    v_claim := tgt.vat_claimable and v_vat > 0;
    select tgt.total - s.amount, tgt.vat - s.vat into v_open, v_undue from acc.purchase_settled(p_company, tgt.id) s;
    if v_total > v_open then
      raise exception 'ลดหนี้ % ได้ไม่เกินยอดค้าง %', v_total, v_open using errcode = 'ACC15';
    end if;
    if tgt.is_service and v_claim and v_vat > v_undue then
      raise exception 'ภาษีที่ลด % เกินภาษีซื้อยังไม่ถึงกำหนดที่เหลือ %', v_vat, v_undue using errcode = 'ACC15';
    end if;
  end if;

  if p_kind = 'cash_purchase' then
    select * into v_cash from acc.chart_of_accounts
     where company_id = p_company and code = coalesce(nullif(p->>'cash_account', ''), '1110') and active and type = 'asset' and code like '11%';
    if not found then raise exception 'บัญชีจ่ายเงินต้องเป็นบัญชีเงินสด/เงินฝาก (11xx)' using errcode = 'ACC04'; end if;
    select w.kind, w.rate into v_wkind, v_wrate from acc.wht_rate_from(p) w;
    if v_wkind is not null then
      if pa.tax_id is null then
        raise exception 'ผู้ขายต้องมีเลขประจำตัวผู้เสียภาษีจึงหักภาษี ณ ที่จ่ายและออก 50 ทวิ ได้ (แก้ที่ ลูกค้า / ผู้ขาย)' using errcode = 'ACC14';
      end if;
      v_wbase := v_base; -- ฐานคือยอดก่อนภาษีมูลค่าเพิ่ม (T5)
      v_wht := round(v_wbase * v_wrate / 100, 2);
      if v_wht <= 0 or v_wht >= v_total then
        raise exception 'ภาษีหัก ณ ที่จ่ายคิดได้ % ต้องมากกว่า 0 และน้อยกว่ายอดจ่าย', v_wht using errcode = 'ACC05';
      end if;
    end if;
  elsif nullif(p->>'wht_kind', '') is not null then
    raise exception 'หัก ณ ที่จ่ายตอนจ่ายเงิน (ซื้อสดหรือจ่ายชำระ) ไม่ใช่ตอนบันทึกซื้อเชื่อ' using errcode = '22023';
  end if;

  -- แบ่งยอดลงบัญชีตามสัดส่วนรายการ เศษไปบัญชีที่ยอดมากสุด · ภาษีขอคืนไม่ได้ (T7) รวมเข้าต้นทุน
  v_split := case when v_claim then v_base else v_total end;
  select coalesce(jsonb_agg(x), '[]') into v_share from (
    select a.code, trunc(v_split * a.amt / v_gross, 2)
             + case when a.rn = 1 then v_split - sum(trunc(v_split * a.amt / v_gross, 2)) over () else 0 end as share
      from (select l->>'account_code' as code, sum((l->>'amount')::numeric) as amt,
                   row_number() over (order by sum((l->>'amount')::numeric) desc, l->>'account_code') as rn
              from jsonb_array_elements(v_lines) l group by 1) a) x
   where x.share > 0;

  v_desc := coalesce(nullif(btrim(p->>'description'), ''), case p_kind
    when 'purchase_invoice' then 'ซื้อเชื่อ ' || pa.name || ' ' || v_vdoc
    when 'cash_purchase' then 'ซื้อสด ' || pa.name || ' ' || v_vdoc
    else 'ลดหนี้ ' || tgt.doc_no || ' ' || pa.name || ' ' || v_vdoc end);
  v_prefix := case p_kind when 'purchase_invoice' then 'PI' when 'cash_purchase' then 'CP' else 'PN' end;
  if p_kind = 'purchase_credit_note' then
    v_je := jsonb_build_array(jsonb_build_object('account_code', '2110', 'debit', v_total::text, 'memo', pa.name));
    select v_je || coalesce(jsonb_agg(jsonb_build_object('account_code', x->>'code', 'credit', x->>'share')), '[]') into v_je from jsonb_array_elements(v_share) x;
    if v_claim then v_je := v_je || jsonb_build_object('account_code', case when v_svc then '1411' else '1410' end, 'credit', v_vat::text); end if;
  else
    select coalesce(jsonb_agg(jsonb_build_object('account_code', x->>'code', 'debit', x->>'share', 'memo', pa.name)), '[]') into v_je from jsonb_array_elements(v_share) x;
    if v_claim then
      v_je := v_je || jsonb_build_object('account_code',
        case when v_svc and p_kind = 'purchase_invoice' then '1411' else '1410' end, 'debit', v_vat::text);
    end if;
    if p_kind = 'cash_purchase' then
      v_je := v_je || jsonb_build_object('account_code', v_cash.code, 'credit', (v_total - v_wht)::text, 'memo', pa.name);
      if v_wht > 0 then v_je := v_je || jsonb_build_object('account_code', '2230', 'credit', v_wht::text, 'memo', pa.name); end if;
    else
      v_je := v_je || jsonb_build_object('account_code', '2110', 'credit', v_total::text, 'memo', pa.name);
    end if;
  end if;

  v_eid := acc.post_journal(p_company, v_date, v_desc, v_je, p_idem, v_prefix, null);
  select id into v_id from acc.purchase_documents where company_id = p_company and entry_id = v_eid;
  if found then return v_id; end if; -- คำขอซ้ำที่รอคำขอแรกจบ

  v_credit := case when p_kind = 'purchase_invoice' then coalesce(nullif(p->>'credit_days', '')::int, pa.credit_days) end;
  insert into acc.purchase_documents (company_id, kind, doc_no, doc_date, vendor_doc_no, party_id, party_code, party_name,
      party_tax_id, party_branch_no, party_address, is_service, vat_claimable, price_mode, vat_rate, gross, discount, base, vat,
      total, wht_kind, wht_rate, wht_base, wht_amount, cash_account_id, credit_days, due_date, ref_document_id, reason,
      description, entry_id, idem_key, created_by)
  select p_company, p_kind, e.doc_no, v_date, v_vdoc, pa.id, pa.code, pa.name, pa.tax_id, pa.branch_no, pa.address,
         v_svc, v_claim, v_mode, v_rate, v_gross, v_disc, v_base, v_vat, v_total, v_wkind, v_wrate, v_wbase, v_wht,
         v_cash.id, v_credit, v_date + v_credit, tgt.id, nullif(btrim(p->>'reason'), ''), coalesce(btrim(p->>'description'), ''),
         v_eid, p_idem, app.current_user_id()
    from acc.journal_entries e where e.company_id = p_company and e.id = v_eid
  returning id into v_id;

  insert into acc.purchase_document_lines (company_id, document_id, line_no, item_id, description, qty, unit, unit_price, amount, account_id)
  select p_company, v_id, (l->>'line_no')::int, nullif(l->>'item_id', '')::uuid, l->>'description', (l->>'qty')::numeric,
         l->>'unit', (l->>'unit_price')::numeric, (l->>'amount')::numeric, (l->>'account_id')::uuid
    from jsonb_array_elements(v_lines) l;

  if p_kind = 'purchase_credit_note' then
    insert into acc.purchase_allocations (company_id, source_id, target_id, amount, vat_transfer)
    values (p_company, v_id, tgt.id, v_total, case when tgt.is_service and v_claim then v_vat else 0 end);
  end if;
  if v_wht > 0 then perform acc.issue_wht_certificate(p_company, v_id); end if;
  return v_id;
end $$;

-- ---- จ่ายชำระ (PV): ตัดใบซื้อเชื่อหลายใบ หัก ณ ที่จ่ายจากมูลค่าก่อน VAT ของส่วนที่จ่าย ภาษีซื้อบริการถึงกำหนดตามสัดส่วน ----
-- p: {date, party_code, cash_account?, wht_kind?, wht_rate?, description?, allocations: [{document_id, amount}]}
create function acc.post_payment(p_company uuid, p jsonb, p_idem text) returns uuid
language plpgsql security definer set search_path = acc, pg_temp as $$
declare
  co      acc.companies;
  pa      acc.parties;
  tgt     acc.purchase_documents;
  v_cash  acc.chart_of_accounts;
  v_id    uuid;
  v_date  date;
  v_amt   numeric;
  v_open  numeric; v_undue numeric; v_tr numeric; v_wb numeric;
  v_total numeric := 0; v_vat numeric := 0;
  v_wkind text; v_wrate numeric; v_wbase numeric := 0; v_wht numeric := 0;
  v_svc   boolean := false;
  v_allocs jsonb := '[]';
  v_je    jsonb;
  v_eid   uuid;
  r record;
begin
  if not app.can_write_company(p_company) then
    raise exception 'ไม่มีสิทธิ์บันทึกเอกสารในบริษัทนี้' using errcode = '42501';
  end if;
  select id into v_id from acc.purchase_documents where company_id = p_company and idem_key = p_idem;
  if found then return v_id; end if;
  perform acc.ensure_purchase_accounts(p_company);
  select * into co from acc.companies where id = p_company;
  v_date := nullif(p->>'date', '')::date;
  if v_date is null then raise exception 'ต้องมีวันที่เอกสาร' using errcode = '22023'; end if;
  select * into pa from acc.parties where company_id = p_company and code = upper(p->>'party_code');
  if not found or not pa.is_vendor then
    raise exception 'ไม่พบผู้ขายรหัส %', coalesce(p->>'party_code', '(ว่าง)') using errcode = 'ACC04';
  end if;
  select * into v_cash from acc.chart_of_accounts
   where company_id = p_company and code = coalesce(nullif(p->>'cash_account', ''), '1110') and active and type = 'asset' and code like '11%';
  if not found then raise exception 'บัญชีจ่ายเงินต้องเป็นบัญชีเงินสด/เงินฝาก (11xx)' using errcode = 'ACC04'; end if;
  if jsonb_typeof(p->'allocations') is distinct from 'array' or jsonb_array_length(p->'allocations') not between 1 and 50 then
    raise exception 'ต้องเลือกใบที่จ่ายชำระ 1–50 ใบ' using errcode = '22023';
  end if;

  -- ล็อกใบที่ตัดตามลำดับ id กันจ่ายเกินยอดค้างเมื่อกดพร้อมกัน (และกัน deadlock)
  for r in select (a->>'document_id')::uuid as did, a->>'amount' as amt, count(*) over (partition by a->>'document_id') as dup
             from jsonb_array_elements(p->'allocations') a order by 1 loop
    if r.dup > 1 then raise exception 'เลือกใบเดียวกันซ้ำ' using errcode = '22023'; end if;
    select * into tgt from acc.purchase_documents where company_id = p_company and id = r.did for update;
    if not found or tgt.kind <> 'purchase_invoice' or tgt.voided_at is not null or tgt.party_id <> pa.id then
      raise exception 'จ่ายชำระได้เฉพาะใบซื้อเชื่อของผู้ขายรายนี้ที่ยังไม่ยกเลิก' using errcode = 'ACC15';
    end if;
    if tgt.doc_date > v_date then
      raise exception 'วันที่จ่ายชำระต้องไม่ก่อนวันที่ของ %', tgt.doc_no using errcode = '22023';
    end if;
    begin v_amt := r.amt::numeric; exception when others then v_amt := null; end;
    if v_amt is null or v_amt <= 0 or v_amt <> round(v_amt, 2) then
      raise exception '%: จำนวนเงินต้องมากกว่า 0 ทศนิยมไม่เกิน 2 ตำแหน่ง', tgt.doc_no using errcode = 'ACC05';
    end if;
    select tgt.total - s.amount, tgt.vat - s.vat into v_open, v_undue from acc.purchase_settled(p_company, tgt.id) s;
    if v_amt > v_open then
      raise exception '% ค้างอยู่ % จ่ายเกินยอดค้างไม่ได้', tgt.doc_no, v_open using errcode = 'ACC15';
    end if;
    v_tr := 0;
    if tgt.is_service and tgt.vat_claimable and v_undue > 0 then
      v_tr := case when v_amt = v_open then v_undue else round(v_amt * v_undue / v_open, 2) end;
      v_svc := true;
    end if;
    v_wb := round(v_amt * tgt.base / tgt.total, 2); -- ส่วนของมูลค่าก่อนภาษีในยอดที่จ่าย
    v_total := v_total + v_amt; v_vat := v_vat + v_tr; v_wbase := v_wbase + v_wb;
    v_allocs := v_allocs || jsonb_build_object('target', tgt.id, 'doc_no', tgt.doc_no, 'amount', v_amt, 'vat', v_tr, 'wb', v_wb);
  end loop;

  select w.kind, w.rate into v_wkind, v_wrate from acc.wht_rate_from(p) w;
  if v_wkind is not null then
    if pa.tax_id is null then
      raise exception 'ผู้ขายต้องมีเลขประจำตัวผู้เสียภาษีจึงหักภาษี ณ ที่จ่ายและออก 50 ทวิ ได้ (แก้ที่ ลูกค้า / ผู้ขาย)' using errcode = 'ACC14';
    end if;
    v_wht := round(v_wbase * v_wrate / 100, 2);
    if v_wht <= 0 or v_wht >= v_total then
      raise exception 'ภาษีหัก ณ ที่จ่ายคิดได้ % ต้องมากกว่า 0 และน้อยกว่ายอดจ่าย', v_wht using errcode = 'ACC05';
    end if;
  else
    v_wbase := 0;
  end if;

  v_je := jsonb_build_array(jsonb_build_object('account_code', '2110', 'debit', v_total::text, 'memo', pa.name));
  if v_vat > 0 then v_je := v_je || jsonb_build_object('account_code', '1410', 'debit', v_vat::text); end if;
  v_je := v_je || jsonb_build_object('account_code', v_cash.code, 'credit', (v_total - v_wht)::text, 'memo', pa.name);
  if v_wht > 0 then v_je := v_je || jsonb_build_object('account_code', '2230', 'credit', v_wht::text, 'memo', pa.name); end if;
  if v_vat > 0 then v_je := v_je || jsonb_build_object('account_code', '1411', 'credit', v_vat::text); end if;
  v_eid := acc.post_journal(p_company, v_date, coalesce(nullif(btrim(p->>'description'), ''), 'จ่ายชำระ ' || pa.name), v_je, p_idem, 'PV', null);
  select id into v_id from acc.purchase_documents where company_id = p_company and entry_id = v_eid;
  if found then return v_id; end if;

  insert into acc.purchase_documents (company_id, kind, doc_no, doc_date, party_id, party_code, party_name, party_tax_id,
      party_branch_no, party_address, is_service, vat_claimable, price_mode, vat_rate, gross, discount, base, vat, total,
      wht_kind, wht_rate, wht_base, wht_amount, cash_account_id, description, entry_id, idem_key, created_by)
  select p_company, 'payment', e.doc_no, v_date, pa.id, pa.code, pa.name, pa.tax_id, pa.branch_no, pa.address,
         v_svc, v_vat > 0, case when v_vat > 0 then 'inclusive' else 'none' end, co.vat_rate,
         v_total, 0, v_total - v_vat, v_vat, v_total, v_wkind, v_wrate, v_wbase, v_wht, v_cash.id,
         coalesce(btrim(p->>'description'), ''), v_eid, p_idem, app.current_user_id()
    from acc.journal_entries e where e.company_id = p_company and e.id = v_eid
  returning id into v_id;
  insert into acc.purchase_document_lines (company_id, document_id, line_no, description, qty, unit_price, amount, account_id)
  select p_company, v_id, a.ord::int, 'จ่ายชำระ ' || (a.value->>'doc_no'), 1, (a.value->>'amount')::numeric, (a.value->>'amount')::numeric,
         (select id from acc.chart_of_accounts where company_id = p_company and code = '2110')
    from jsonb_array_elements(v_allocs) with ordinality a(value, ord);
  insert into acc.purchase_allocations (company_id, source_id, target_id, amount, vat_transfer, wht_base)
  select p_company, v_id, (a->>'target')::uuid, (a->>'amount')::numeric, (a->>'vat')::numeric,
         case when v_wht > 0 then (a->>'wb')::numeric else 0 end
    from jsonb_array_elements(v_allocs) a;
  if v_wht > 0 then perform acc.issue_wht_certificate(p_company, v_id); end if;
  return v_id;
end $$;

-- ---- ยกเลิกเอกสารซื้อ: กลับรายการบัญชี (RV) ทำเครื่องหมายยกเลิกพร้อมเหตุผล 50 ทวิ ของเอกสารนั้นยกเลิกด้วย ----
create function acc.void_purchase_document(p_company uuid, p_document uuid, p_date date, p_reason text, p_idem text) returns uuid
language plpgsql security definer set search_path = acc, pg_temp as $$
declare
  d    acc.purchase_documents;
  v_rv uuid;
begin
  if not app.can_write_company(p_company) then
    raise exception 'ไม่มีสิทธิ์ยกเลิกเอกสารในบริษัทนี้' using errcode = '42501';
  end if;
  select * into d from acc.purchase_documents where company_id = p_company and id = p_document for update;
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
  if exists (select 1 from acc.purchase_allocations a join acc.purchase_documents s on s.company_id = a.company_id and s.id = a.source_id
              where a.company_id = p_company and a.target_id = d.id and s.voided_at is null)
     or exists (select 1 from acc.purchase_documents x where x.company_id = p_company and x.ref_document_id = d.id and x.voided_at is null) then
    raise exception '% มีจ่ายชำระ/ใบลดหนี้อ้างอยู่ ยกเลิกใบเหล่านั้นก่อน', d.doc_no using errcode = 'ACC16';
  end if;
  v_rv := acc.reverse_journal(p_company, d.entry_id, p_date, p_idem, 'ยกเลิก ' || d.doc_no || ': ' || btrim(p_reason));
  update acc.purchase_documents set voided_at = now(), void_entry_id = v_rv, void_reason = btrim(p_reason)
   where company_id = p_company and id = d.id;
  update acc.wht_certificates set voided_at = now() where company_id = p_company and document_id = d.id;
  return v_rv;
end $$;

revoke all on function acc.ensure_purchase_accounts(uuid), acc.issue_wht_certificate(uuid, uuid),
  acc.post_purchase_document(uuid, text, jsonb, text), acc.post_payment(uuid, jsonb, text),
  acc.void_purchase_document(uuid, uuid, date, text, text) from public;
grant execute on function acc.post_purchase_document(uuid, text, jsonb, text), acc.post_payment(uuid, jsonb, text),
  acc.void_purchase_document(uuid, uuid, date, text, text) to app_rw;
grant execute on function acc.purchase_settled(uuid, uuid), acc.ap_open_items(uuid), acc.wht_standard_rate(text),
  acc.wht_rate_from(jsonb) to app_rw, app_ro;

-- migrate:down
drop function acc.void_purchase_document(uuid, uuid, date, text, text), acc.post_payment(uuid, jsonb, text),
  acc.post_purchase_document(uuid, text, jsonb, text), acc.wht_rate_from(jsonb), acc.issue_wht_certificate(uuid, uuid),
  acc.ap_open_items(uuid), acc.purchase_settled(uuid, uuid), acc.wht_standard_rate(text), acc.ensure_purchase_accounts(uuid);
drop table acc.wht_certificates, acc.purchase_allocations, acc.purchase_document_lines, acc.purchase_documents;
drop function acc.guard_certificate_update(), acc.guard_purchase_update();
