-- migrate:up
-- ปิดบัญชีสิ้นปี + รอบปีบัญชี (docs/phase5-spec.md ข้อ 1, docs/assumptions.md ข้อ 40)
-- รายการปิดบัญชีเลขที่ชุด CL ลงวันสิ้นปีบัญชี: รายได้/ค่าใช้จ่ายทุกบัญชีเป็นศูนย์ ผลต่างเข้า 3210 กำไรสะสม

-- เดือนเริ่มปีบัญชี (1 = ปีปฏิทิน)
alter table acc.companies add column fiscal_year_start smallint not null default 1
  check (fiscal_year_start between 1 and 12);

-- วันแรกของปีบัญชีที่วันที่นี้อยู่ (invoker: RLS ของ companies ใช้กับผู้เรียก)
create function acc.fiscal_year_start(p_company uuid, p_date date) returns date
language sql stable set search_path = acc, pg_temp as $$
  select make_date(extract(year from p_date)::int - (extract(month from p_date)::int < c.fiscal_year_start)::int,
                   c.fiscal_year_start, 1)
    from acc.companies c where c.id = p_company
$$;

create table acc.fiscal_year_closings (
  id              uuid not null default gen_random_uuid(),
  company_id      uuid not null references acc.companies(id),
  year_start      date not null,
  year_end        date not null,
  entry_id        uuid,                       -- null = ยอดรายได้/ค่าใช้จ่ายเป็นศูนย์ ไม่มีรายการ CL
  net_income      numeric(18,2) not null,     -- กำไร(+)/ขาดทุน(−) ที่โอนเข้า 3210 ครั้งนี้
  idempotency_key text not null,
  closed_by       uuid not null references acc.users(id),
  closed_at       timestamptz not null default now(),
  reopened_by     uuid references acc.users(id),
  reopened_at     timestamptz,
  primary key (company_id, id),
  unique (company_id, idempotency_key),
  check (year_end > year_start),
  check ((reopened_at is null) = (reopened_by is null)),
  foreign key (company_id, entry_id) references acc.journal_entries(company_id, id)
);
-- ปีหนึ่งปิดอยู่ได้ครั้งเดียว (ปิดใหม่หลังครูเปิดคืน = แถวใหม่)
create unique index fiscal_year_closings_active on acc.fiscal_year_closings (company_id, year_end) where reopened_at is null;

-- แก้ได้เฉพาะการเปิดคืน (จาก null เป็นค่า) ลบไม่ได้
create function acc.guard_fiscal_year_closing_update() returns trigger
language plpgsql set search_path = acc, pg_temp as $$
begin
  if tg_op = 'DELETE' or old.reopened_at is not null or new.reopened_at is null
     or (to_jsonb(new) - 'reopened_at' - 'reopened_by') <> (to_jsonb(old) - 'reopened_at' - 'reopened_by') then
    raise exception 'การปิดบัญชีสิ้นปีแก้หรือลบไม่ได้ ให้ครูเปิดงวดคืนแล้วปิดใหม่' using errcode = 'ACC06';
  end if;
  return new;
end $$;
create trigger fiscal_year_closings_guard before update or delete on acc.fiscal_year_closings
  for each row execute function acc.guard_fiscal_year_closing_update();
create trigger fiscal_year_closings_locked before insert on acc.fiscal_year_closings
  for each row execute function acc.guard_locked_company();
create trigger audit_fiscal_year_closings after insert or update on acc.fiscal_year_closings
  for each row execute function acc.audit_row();

alter table acc.fiscal_year_closings enable row level security;
grant select on acc.fiscal_year_closings to app_rw, app_ro;
create policy fiscal_year_closings_read on acc.fiscal_year_closings for select to app_rw, app_ro
  using (company_id in (select app.readable_company_ids()));

-- รายการปิดบัญชีที่จะลง ณ วันสิ้นปี: ยอดสุทธิทุกรายการถึงวันนั้น (ปีก่อนปิดแล้ว = เหลือเฉพาะปีนี้ / ปิดซ้ำ = เฉพาะส่วนที่เหลือ)
-- รายได้ยอดเครดิต → เดบิต · ค่าใช้จ่ายยอดเดบิต → เครดิต · ผลต่างเข้า 3210 (กำไร = เครดิต)
create function acc.year_closing_lines(p_company uuid, p_year_end date)
returns table (code text, name text, debit numeric, credit numeric)
language sql stable set search_path = acc, pg_temp as $$
  with n as (
    select a.code, a.name, sum(l.debit - l.credit) as net
      from acc.journal_lines l
      join acc.journal_entries e on e.company_id = l.company_id and e.id = l.entry_id
      join acc.chart_of_accounts a on a.company_id = l.company_id and a.id = l.account_id
     where l.company_id = p_company and e.entry_date <= p_year_end and a.type in ('revenue', 'expense')
     group by a.code, a.name
    having sum(l.debit - l.credit) <> 0
  ), t as (select coalesce(sum(net), 0) as total from n)
  select code, name, debit::numeric(18,2), credit::numeric(18,2) from (
    select 1 as ord, code, name, greatest(-net, 0) as debit, greatest(net, 0) as credit from n
    union all
    select 2, '3210',
           coalesce((select a.name from acc.chart_of_accounts a where a.company_id = p_company and a.code = '3210'), 'กำไรสะสม'),
           greatest(total, 0), greatest(-total, 0)
      from t where total <> 0
  ) x
  order by ord, code
$$;

-- ปิดบัญชีสิ้นปี (นักเรียนเจ้าของบริษัท) คืน id ของการปิด
create function acc.close_fiscal_year(p_company uuid, p_year_end date, p_key text) returns uuid
language plpgsql security definer set search_path = acc, pg_temp as $$
declare
  v_id    uuid;
  v_start date;
  v_end   date;
  v_prev  date;
  v_bad   date;
  v_open  date;
  v_lines jsonb;
  v_net   numeric(18,2);
  v_eid   uuid;
  v_month date;
  v_bs    date;
begin
  if not app.can_write_company(p_company) then
    raise exception 'ไม่มีสิทธิ์ปิดบัญชีบริษัทนี้' using errcode = '42501';
  end if;
  if p_key is null or length(p_key) < 8 then
    raise exception 'ต้องมี idempotency key' using errcode = 'ACC03';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('periods:' || p_company::text, 0));
  select id into v_id from acc.fiscal_year_closings where company_id = p_company and idempotency_key = p_key;
  if found then return v_id; end if;  -- กดซ้ำ/เน็ตหลุด: ได้ผลเดิม
  perform 1 from acc.companies where id = p_company for update; -- กันเปลี่ยนรอบปีพร้อมกัน

  v_start := acc.fiscal_year_start(p_company, p_year_end);
  v_end := (v_start + interval '1 year' - interval '1 day')::date;
  if p_year_end is distinct from v_end then
    raise exception 'วันที่ % ไม่ใช่วันสิ้นปีบัญชี (ปีบัญชีนี้สิ้นสุด %)', acc.thai_date(p_year_end), acc.thai_date(v_end)
      using errcode = '22023';
  end if;
  if exists (select 1 from acc.fiscal_year_closings
              where company_id = p_company and reopened_at is null and year_end >= v_end) then
    raise exception 'ปิดบัญชีปีบัญชี % – % ไปแล้ว', acc.thai_date(v_start), acc.thai_date(v_end) using errcode = 'ACC21';
  end if;
  if not exists (select 1 from acc.journal_entries where company_id = p_company and entry_date between v_start and v_end) then
    raise exception 'ปีบัญชี % – % ยังไม่มีรายการ ไม่ต้องปิดบัญชี', acc.thai_date(v_start), acc.thai_date(v_end)
      using errcode = 'ACC04';
  end if;

  -- ปีก่อนหน้าที่มีรายการต้องปิดก่อน (ปิดเรียงปี)
  select max(year_end) into v_prev from acc.fiscal_year_closings
   where company_id = p_company and reopened_at is null and year_end < v_start;
  select min(entry_date) into v_bad from acc.journal_entries
   where company_id = p_company and entry_date < v_start and (v_prev is null or entry_date > v_prev);
  if v_bad is not null then
    v_bs := acc.fiscal_year_start(p_company, v_bad);
    raise exception 'ต้องปิดบัญชีปีบัญชี % – % ก่อน ปิดบัญชีเรียงจากปีเก่าไปใหม่',
      acc.thai_date(v_bs), acc.thai_date((v_bs + interval '1 year' - interval '1 day')::date) using errcode = 'ACC13';
  end if;
  select min(start_date) into v_open from acc.periods
   where company_id = p_company and start_date < v_start and not closed;
  if v_open is not null then
    raise exception 'ต้องปิดงวด % ก่อน ปิดงวดเรียงจากเดือนเก่าไปใหม่', to_char(v_open, 'YYYY-MM') using errcode = 'ACC13';
  end if;

  -- 3210 ต้องมีและใช้งานอยู่
  insert into acc.chart_of_accounts (company_id, code, name, type) values (p_company, '3210', 'กำไรสะสม', 'equity')
  on conflict (company_id, code) do nothing;
  update acc.chart_of_accounts set active = true, version = version + 1
   where company_id = p_company and code = '3210' and not active;

  select jsonb_agg(jsonb_build_object('account_code', x.code, 'debit', x.debit::text, 'credit', x.credit::text,
                                      'memo', 'ปิดบัญชี'))
    into v_lines from acc.year_closing_lines(p_company, v_end) x;
  select coalesce(sum(x.debit) - sum(x.credit), 0) into v_net from acc.year_closing_lines(p_company, v_end) x where x.code <> '3210';

  if v_lines is not null then
    -- งวดสิ้นปีปิดไปก่อนแล้วได้: เปิดชั่วคราวในธุรกรรมนี้เพื่อลง CL แล้วปิดคืนด้านล่าง
    v_month := date_trunc('month', v_end)::date;
    insert into acc.periods (company_id, start_date, end_date) values (p_company, v_month, v_end)
    on conflict (company_id, start_date) do nothing;
    update acc.periods set closed = false, closed_at = null where company_id = p_company and start_date = v_month and closed;
    perform set_config('acc.year_closing', 'on', true);
    v_eid := acc.post_journal(p_company, v_end,
      'ปิดบัญชีรายได้และค่าใช้จ่ายเข้ากำไรสะสม ปีบัญชี ' || acc.thai_date(v_start) || ' – ' || acc.thai_date(v_end),
      v_lines, p_key, 'CL');
    perform set_config('acc.year_closing', '', true);
  end if;

  insert into acc.fiscal_year_closings (company_id, year_start, year_end, entry_id, net_income, idempotency_key, closed_by)
  values (p_company, v_start, v_end, v_eid, v_net, p_key, app.current_user_id())
  returning id into v_id;

  -- งวดที่ยังเปิดของปีนี้ปิดทั้งหมด
  update acc.periods set closed = true, closed_at = now()
   where company_id = p_company and start_date between v_start and v_end and not closed;
  return v_id;
end $$;

-- ทุกรายการ: CL ลงได้จากการปิดบัญชีเท่านั้น กลับรายการ CL ไม่ได้ ลงวันที่ในปีที่ปิดบัญชีแล้วไม่ได้
create function acc.guard_fiscal_year_entry() returns trigger
language plpgsql set search_path = acc, pg_temp as $$
declare
  v_c acc.fiscal_year_closings;
begin
  if coalesce(current_setting('acc.year_closing', true), '') = 'on' and new.doc_prefix = 'CL' then
    return new;
  end if;
  if new.doc_prefix = 'CL' then
    raise exception 'รายการปิดบัญชี (CL) ลงได้จากเมนูปิดบัญชีสิ้นปีเท่านั้น' using errcode = 'ACC21';
  end if;
  if new.reverses_entry_id is not null and exists (
       select 1 from acc.journal_entries o where o.company_id = new.company_id and o.id = new.reverses_entry_id and o.doc_prefix = 'CL') then
    raise exception 'กลับรายการปิดบัญชีไม่ได้ ถ้าต้องแก้ให้ขอครูเปิดงวดคืน แล้วปิดบัญชีใหม่' using errcode = 'ACC21';
  end if;
  select * into v_c from acc.fiscal_year_closings
   where company_id = new.company_id and reopened_at is null and new.entry_date between year_start and year_end
   limit 1;
  if found then
    raise exception 'ปิดบัญชีปีบัญชี % – % แล้ว ลงรายการวันที่ % ไม่ได้ ถ้าต้องแก้ให้ขอครูเปิดงวดคืน',
      acc.thai_date(v_c.year_start), acc.thai_date(v_c.year_end), acc.thai_date(new.entry_date) using errcode = 'ACC02';
  end if;
  return new;
end $$;
create trigger journal_entries_fiscal_year before insert on acc.journal_entries
  for each row execute function acc.guard_fiscal_year_entry();

-- ตั้งเดือนเริ่มปีบัญชี: ได้จนกว่าจะเคยปิดบัญชีสิ้นปี
create function acc.set_fiscal_year_start(p_company uuid, p_month smallint, p_version int) returns int
language plpgsql security definer set search_path = acc, pg_temp as $$
declare v_version int;
begin
  if not app.can_write_company(p_company) then
    raise exception 'ไม่มีสิทธิ์' using errcode = '42501';
  end if;
  if app.company_locked(p_company) then
    raise exception 'งานนี้ส่งตรวจแล้ว แก้ไขไม่ได้จนกว่าครูจะส่งกลับให้แก้' using errcode = 'ACC10';
  end if;
  if p_month is null or p_month not between 1 and 12 then
    raise exception 'เดือนเริ่มปีบัญชีต้องเป็น 1–12' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('periods:' || p_company::text, 0));
  if exists (select 1 from acc.fiscal_year_closings where company_id = p_company) then
    raise exception 'ปิดบัญชีสิ้นปีไปแล้ว เปลี่ยนรอบปีบัญชีไม่ได้' using errcode = 'ACC21';
  end if;
  update acc.companies set fiscal_year_start = p_month, version = version + 1
   where id = p_company and version = p_version returning version into v_version;
  if not found then
    raise exception 'มีคนแก้ข้อมูลบริษัทไปก่อนแล้ว โหลดใหม่ก่อนแก้' using errcode = '40001';
  end if;
  return v_version;
end $$;

-- เปิดงวดคืน (ครู): เดิม + การปิดบัญชีของปีที่สิ้นสุดตั้งแต่เดือนนี้เป็นต้นไปถูกเปิดคืนด้วย
create or replace function acc.reopen_period(p_company_id uuid, p_month date) returns void
language plpgsql security definer set search_path = acc, pg_temp as $$
declare
  v_start date := date_trunc('month', p_month)::date;
  v_owner uuid;
  v_p     acc.periods;
  v_last  date;
begin
  select owner_id into v_owner from acc.companies where id = p_company_id;
  if v_owner is null or v_owner = app.current_user_id() or not app.can_read_company(p_company_id) then
    raise exception 'เปิดงวดที่ปิดแล้วได้เฉพาะครูประจำห้อง' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('periods:' || p_company_id::text, 0));
  select * into v_p from acc.periods where company_id = p_company_id and start_date = v_start for update;
  if not found then raise exception 'ไม่พบงวด' using errcode = 'ACC04'; end if;
  if not v_p.closed then return; end if;
  select max(start_date) into v_last from acc.periods where company_id = p_company_id and closed;
  if v_last > v_start then
    raise exception 'ต้องเปิดงวด % ก่อน เปิดงวดคืนเรียงจากเดือนล่าสุดย้อนกลับ', to_char(v_last, 'YYYY-MM')
      using errcode = 'ACC13';
  end if;
  update acc.periods set closed = false, closed_at = null where company_id = p_company_id and id = v_p.id;
  update acc.fiscal_year_closings set reopened_at = now(), reopened_by = app.current_user_id()
   where company_id = p_company_id and reopened_at is null and year_end >= v_start;
end $$;

-- กระดาษทำการ: ไม่รวมรายการปิดบัญชี (CL) ของปีบัญชีของเดือนนั้น = ยอดก่อนปิดบัญชี
create or replace function acc.worksheet(p_company uuid, p_month date)
returns table (code text, name text, type text, normal_side text, unadjusted numeric, adj_debit numeric, adj_credit numeric)
language sql stable set search_path = acc, pg_temp as $$
  with bounds as (
    select date_trunc('month', p_month)::date as s, (date_trunc('month', p_month) + interval '1 month - 1 day')::date as e,
           acc.fiscal_year_start(p_company, p_month) as fy
  ), l as (
    select l.account_id, l.debit, l.credit,
           (e.entry_date >= b.s and (e.doc_prefix = 'AJ' or coalesce(o.doc_prefix, '') = 'AJ')) as adj
      from acc.journal_lines l
      join acc.journal_entries e on e.company_id = l.company_id and e.id = l.entry_id
      left join acc.journal_entries o on o.company_id = e.company_id and o.id = e.reverses_entry_id
      cross join bounds b
     where l.company_id = p_company and e.entry_date <= b.e
       and not (e.doc_prefix = 'CL' and e.entry_date >= b.fy)
  )
  select a.code, a.name, a.type, a.normal_side,
         coalesce(sum(l.debit - l.credit) filter (where not l.adj), 0),
         coalesce(sum(l.debit) filter (where l.adj), 0),
         coalesce(sum(l.credit) filter (where l.adj), 0)
    from acc.chart_of_accounts a
    left join l on l.account_id = a.id
   where a.company_id = p_company
   group by a.code, a.name, a.type, a.normal_side
  having count(l.account_id) > 0
   order by a.code
$$;

revoke all on function acc.fiscal_year_start(uuid, date), acc.year_closing_lines(uuid, date),
  acc.close_fiscal_year(uuid, date, text), acc.set_fiscal_year_start(uuid, smallint, int) from public;
grant execute on function acc.fiscal_year_start(uuid, date), acc.year_closing_lines(uuid, date) to app_rw, app_ro;
grant execute on function acc.close_fiscal_year(uuid, date, text), acc.set_fiscal_year_start(uuid, smallint, int) to app_rw;

-- migrate:down
create or replace function acc.worksheet(p_company uuid, p_month date)
returns table (code text, name text, type text, normal_side text, unadjusted numeric, adj_debit numeric, adj_credit numeric)
language sql stable set search_path = acc, pg_temp as $$
  with bounds as (
    select date_trunc('month', p_month)::date as s, (date_trunc('month', p_month) + interval '1 month - 1 day')::date as e
  ), l as (
    select l.account_id, l.debit, l.credit,
           (e.entry_date >= b.s and (e.doc_prefix = 'AJ' or coalesce(o.doc_prefix, '') = 'AJ')) as adj
      from acc.journal_lines l
      join acc.journal_entries e on e.company_id = l.company_id and e.id = l.entry_id
      left join acc.journal_entries o on o.company_id = e.company_id and o.id = e.reverses_entry_id
      cross join bounds b
     where l.company_id = p_company and e.entry_date <= b.e
  )
  select a.code, a.name, a.type, a.normal_side,
         coalesce(sum(l.debit - l.credit) filter (where not l.adj), 0),
         coalesce(sum(l.debit) filter (where l.adj), 0),
         coalesce(sum(l.credit) filter (where l.adj), 0)
    from acc.chart_of_accounts a
    left join l on l.account_id = a.id
   where a.company_id = p_company
   group by a.code, a.name, a.type, a.normal_side
  having count(l.account_id) > 0
   order by a.code
$$;
create or replace function acc.reopen_period(p_company_id uuid, p_month date) returns void
language plpgsql security definer set search_path = acc, pg_temp as $$
declare
  v_start date := date_trunc('month', p_month)::date;
  v_owner uuid;
  v_p     acc.periods;
  v_last  date;
begin
  select owner_id into v_owner from acc.companies where id = p_company_id;
  if v_owner is null or v_owner = app.current_user_id() or not app.can_read_company(p_company_id) then
    raise exception 'เปิดงวดที่ปิดแล้วได้เฉพาะครูประจำห้อง' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('periods:' || p_company_id::text, 0));
  select * into v_p from acc.periods where company_id = p_company_id and start_date = v_start for update;
  if not found then raise exception 'ไม่พบงวด' using errcode = 'ACC04'; end if;
  if not v_p.closed then return; end if;
  select max(start_date) into v_last from acc.periods where company_id = p_company_id and closed;
  if v_last > v_start then
    raise exception 'ต้องเปิดงวด % ก่อน เปิดงวดคืนเรียงจากเดือนล่าสุดย้อนกลับ', to_char(v_last, 'YYYY-MM')
      using errcode = 'ACC13';
  end if;
  update acc.periods set closed = false, closed_at = null where company_id = p_company_id and id = v_p.id;
end $$;
drop function acc.set_fiscal_year_start(uuid, smallint, int);
drop trigger journal_entries_fiscal_year on acc.journal_entries;
drop function acc.guard_fiscal_year_entry();
drop function acc.close_fiscal_year(uuid, date, text);
drop function acc.year_closing_lines(uuid, date);
drop table acc.fiscal_year_closings;
drop function acc.guard_fiscal_year_closing_update();
drop function acc.fiscal_year_start(uuid, date);
alter table acc.companies drop column fiscal_year_start;
