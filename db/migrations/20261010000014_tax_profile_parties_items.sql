-- migrate:up
-- เฟส 2.1 ข้อมูลหลัก: โปรไฟล์ภาษีของบริษัท ลูกค้า/ผู้ขาย สินค้า/บริการ และบัญชีที่ใช้กับภาษี (docs/phase2-spec.md)

-- เลขประจำตัวผู้เสียภาษี 13 หลัก: หลักที่ 13 = (11 − (Σ หลักที่ i × (14 − i), i = 1..12) mod 11) mod 10
create function app.valid_tax_id(p text) returns boolean
language sql immutable as $$
  select p ~ '^[0-9]{13}$'
     and (11 - (select sum(substr(p, i, 1)::int * (14 - i)) from generate_series(1, 12) i) % 11) % 10
         = substr(p, 13, 1)::int
$$;
grant execute on function app.valid_tax_id(text) to app_rw, app_ro;

-- โปรไฟล์ภาษีของบริษัทจำลอง (ใช้พิมพ์บนใบกำกับภาษี) จด VAT เป็นค่าเริ่มต้น ปรับได้
alter table acc.companies
  add column tax_id         text check (tax_id is null or app.valid_tax_id(tax_id)),
  add column branch_no      text not null default '00000' check (branch_no ~ '^[0-9]{5}$'),
  add column address        text not null default '' check (length(address) <= 400),
  add column vat_registered boolean not null default true,
  add column vat_rate       numeric(5,2) not null default 7 check (vat_rate >= 0 and vat_rate < 100);
grant update (tax_id, branch_no, address, vat_registered, vat_rate) on acc.companies to app_rw;

-- ส่งงานแล้ว (ล็อก) แก้โปรไฟล์ไม่ได้ แก้ชื่ออย่างเดียวก็ไม่ได้เหมือนกัน
create function acc.guard_locked_company_row() returns trigger
language plpgsql as $$
begin
  if app.company_locked(new.id) then
    raise exception 'งานนี้ส่งตรวจแล้ว แก้ไขไม่ได้จนกว่าครูจะส่งกลับให้แก้' using errcode = 'ACC10';
  end if;
  return new;
end $$;
create trigger companies_locked before update on acc.companies
  for each row execute function acc.guard_locked_company_row();

-- ลูกค้า/ผู้ขาย: หนึ่งรายเป็นได้ทั้งสองแบบ เก็บค่าเริ่มต้นของเครดิตและหัก ณ ที่จ่าย
-- ใบกำกับภาษีเก็บสำเนาชื่อ/ที่อยู่/เลขภาษี ณ วันออกเอง (เฟส 2.2) แก้ที่นี่ไม่กระทบเอกสารเก่า
create table acc.parties (
  id             uuid not null default gen_random_uuid(),
  company_id     uuid not null references acc.companies(id),
  code           text not null check (code ~ '^[A-Z0-9][A-Z0-9-]{0,19}$'),
  name           text not null check (length(btrim(name)) between 1 and 160),
  is_customer    boolean not null default false,
  is_vendor      boolean not null default false,
  tax_id         text check (tax_id is null or app.valid_tax_id(tax_id)),
  branch_no      text not null default '00000' check (branch_no ~ '^[0-9]{5}$'),
  address        text not null default '' check (length(address) <= 400),
  vat_registered boolean not null default false,
  credit_days    int not null default 0 check (credit_days between 0 and 365),
  -- หัก ณ ที่จ่ายเริ่มต้นเมื่อจ่ายให้ผู้ขายรายนี้ (อัตรามาตรฐานหรือใส่เอง)
  wht_kind       text check (wht_kind in ('transport', 'advertising', 'service', 'professional', 'rent', 'other')),
  wht_rate       numeric(5,2) check (wht_rate > 0 and wht_rate <= 15),
  active         boolean not null default true,
  version        int not null default 1,
  created_at     timestamptz not null default now(),
  primary key (company_id, id),
  unique (company_id, code),
  check (is_customer or is_vendor),
  check ((wht_kind is null) = (wht_rate is null)),
  -- คู่ค้าที่จด VAT ต้องมีเลขผู้เสียภาษี (ใบกำกับภาษีต้องระบุ ม.86/4)
  check (not vat_registered or tax_id is not null)
);

-- สินค้า/บริการ: บริการกำหนดจุดความรับผิดภาษีเมื่อรับ/จ่ายเงิน (T4) จำนวนสต็อกมาในเฟส 3
create table acc.items (
  id                  uuid not null default gen_random_uuid(),
  company_id          uuid not null references acc.companies(id),
  code                text not null check (code ~ '^[A-Z0-9][A-Z0-9-]{0,19}$'),
  name                text not null check (length(btrim(name)) between 1 and 160),
  unit                text not null default '' check (length(unit) <= 20),
  is_service          boolean not null default false,
  sale_price          numeric(18,2) check (sale_price >= 0),
  purchase_price      numeric(18,2) check (purchase_price >= 0),
  sales_account_id    uuid,
  purchase_account_id uuid,
  active              boolean not null default true,
  version             int not null default 1,
  created_at          timestamptz not null default now(),
  primary key (company_id, id),
  unique (company_id, code),
  foreign key (company_id, sales_account_id) references acc.chart_of_accounts (company_id, id),
  foreign key (company_id, purchase_account_id) references acc.chart_of_accounts (company_id, id)
);

alter table acc.parties enable row level security;
alter table acc.items enable row level security;
grant select on acc.parties, acc.items to app_rw, app_ro;
grant insert on acc.parties, acc.items to app_rw;
grant update (name, is_customer, is_vendor, tax_id, branch_no, address, vat_registered, credit_days,
              wht_kind, wht_rate, active, version) on acc.parties to app_rw;
grant update (name, unit, is_service, sale_price, purchase_price, sales_account_id, purchase_account_id,
              active, version) on acc.items to app_rw;
create policy parties_read on acc.parties for select to app_rw, app_ro using (app.can_read_company(company_id));
create policy parties_insert on acc.parties for insert to app_rw with check (app.can_write_company(company_id));
create policy parties_update on acc.parties for update to app_rw
  using (app.can_write_company(company_id)) with check (app.can_write_company(company_id));
create policy items_read on acc.items for select to app_rw, app_ro using (app.can_read_company(company_id));
create policy items_insert on acc.items for insert to app_rw with check (app.can_write_company(company_id));
create policy items_update on acc.items for update to app_rw
  using (app.can_write_company(company_id)) with check (app.can_write_company(company_id));

create trigger parties_version before update on acc.parties for each row execute function acc.enforce_version();
create trigger items_version before update on acc.items for each row execute function acc.enforce_version();
create trigger parties_locked before insert or update on acc.parties for each row execute function acc.guard_locked_company();
create trigger items_locked before insert or update on acc.items for each row execute function acc.guard_locked_company();
create trigger audit_parties after insert or update on acc.parties for each row execute function acc.audit_row();
create trigger audit_items after insert or update on acc.items for each row execute function acc.audit_row();

-- บัญชีภาษีที่เอกสารขาย/ซื้อใช้ (docs/phase2-spec.md ข้อ 4) บริษัทใหม่ได้จากผังตั้งต้น
insert into acc.coa_template (code, name, type) values
  ('1411', 'ภาษีซื้อยังไม่ถึงกำหนด', 'asset'),
  ('1420', 'ภาษีเงินได้ถูกหัก ณ ที่จ่าย', 'asset'),
  ('1430', 'ภาษีมูลค่าเพิ่มรอขอคืน', 'asset'),
  ('2211', 'ภาษีขายยังไม่ถึงกำหนด', 'liability'),
  ('4220', 'รับคืนสินค้า', 'revenue'),
  ('5140', 'ส่งคืนสินค้า', 'expense')
on conflict (code) do update set name = excluded.name, type = excluded.type;

-- บริษัทที่เปิดไว้แล้ว: เพิ่มบัญชีที่ยังไม่มี (บริษัทที่ส่งงานค้างอยู่เพิ่มไม่ได้เพราะล็อก จะได้เมื่อครูส่งกลับแล้วเปิดหน้าเอกสาร)
insert into acc.chart_of_accounts (company_id, code, name, type)
select c.id, t.code, t.name, t.type
  from acc.companies c cross join acc.coa_template t
 where t.code in ('1411', '1430', '2211', '4220', '5140') and not app.company_locked(c.id)
on conflict (company_id, code) do nothing;
-- ชื่อเดิมของ 1420 เปลี่ยนเป็นชื่อตามตำรา เฉพาะบริษัทที่ยังใช้ชื่อเดิมจากผังตั้งต้น
update acc.chart_of_accounts a set name = 'ภาษีเงินได้ถูกหัก ณ ที่จ่าย', version = a.version + 1
 where a.code = '1420' and a.name = 'ภาษีหัก ณ ที่จ่ายรอเครดิต' and not app.company_locked(a.company_id);

-- migrate:down
delete from acc.chart_of_accounts a where a.code in ('1411', '1430', '2211', '4220', '5140')
  and not exists (select 1 from acc.journal_lines l where l.company_id = a.company_id and l.account_id = a.id);
delete from acc.coa_template where code in ('1411', '1430', '2211', '4220', '5140');
update acc.coa_template set name = 'ภาษีหัก ณ ที่จ่ายรอเครดิต' where code = '1420';
drop table acc.items;
drop table acc.parties;
drop trigger companies_locked on acc.companies;
drop function acc.guard_locked_company_row();
alter table acc.companies drop column tax_id, drop column branch_no, drop column address,
  drop column vat_registered, drop column vat_rate;
drop function app.valid_tax_id(text);
