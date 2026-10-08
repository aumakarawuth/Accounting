-- migrate:up
-- หน้าจอเฟส 1 ที่ยังขาด: ดูรายการ + กลับรายการ, ผังบัญชี, ปิดงวด (docs/assumptions.md ข้อ 17–20)

-- กลับรายการ: กลับได้เฉพาะรายการปกติ และครั้งเดียว ข้อความบอกเลขที่ที่กลับไปแล้ว
-- (ดัชนี unique journal_entries_reverses กันชั้นสุดท้ายอยู่แล้ว ส่วนนี้ให้ข้อความที่อ่านรู้เรื่อง)
create or replace function acc.reverse_journal(
  p_company_id uuid, p_entry_id uuid, p_entry_date date,
  p_idempotency_key text, p_description text default null
) returns uuid
language plpgsql security definer set search_path = acc, pg_temp as $$
declare
  v_e     acc.journal_entries;
  v_lines jsonb;
  v_by    text;
begin
  if not app.can_write_company(p_company_id) then
    raise exception 'ไม่มีสิทธิ์ลงบัญชีในบริษัทนี้' using errcode = '42501';
  end if;
  -- ล็อกรายการเดิม: กดกลับรายการพร้อมกันสองที่ คำขอที่สองรอแล้วเห็นผลของคำขอแรก
  select * into v_e from acc.journal_entries where company_id = p_company_id and id = p_entry_id for update;
  if not found then
    raise exception 'ไม่พบรายการที่จะกลับ' using errcode = 'ACC04';
  end if;
  -- คำขอซ้ำ (เน็ตหลุดแล้วส่งใหม่) ข้ามการตรวจด้านล่าง ให้ post_journal คืนรายการเดิม
  if not exists (select 1 from acc.idempotency_keys where company_id = p_company_id and key = p_idempotency_key) then
    if v_e.reverses_entry_id is not null then
      raise exception 'รายการ % เป็นรายการกลับรายการอยู่แล้ว กลับซ้ำไม่ได้ ถ้าต้องการยอดเดิมให้ลงรายการใหม่', v_e.doc_no
        using errcode = 'ACC12';
    end if;
    select doc_no into v_by from acc.journal_entries where company_id = p_company_id and reverses_entry_id = p_entry_id;
    if v_by is not null then
      raise exception 'รายการ % ถูกกลับรายการแล้วด้วย %', v_e.doc_no, v_by using errcode = 'ACC12';
    end if;
  end if;
  select jsonb_agg(jsonb_build_object(
           'account_code', a.code, 'debit', l.credit::text, 'credit', l.debit::text, 'memo', l.memo)
         order by l.line_no)
    into v_lines
    from acc.journal_lines l join acc.chart_of_accounts a
      on a.company_id = l.company_id and a.id = l.account_id
   where l.company_id = p_company_id and l.entry_id = p_entry_id;
  return acc.post_journal(p_company_id, p_entry_date,
           coalesce(p_description, 'กลับรายการ ' || v_e.doc_no), v_lines,
           p_idempotency_key, 'RV', p_entry_id);
end $$;

-- ปิดงวด: นักเรียนปิดเองได้ เรียงจากเดือนเก่าไปใหม่ (มีงวดเก่าที่ยังเปิดอยู่ ปิดงวดหลังไม่ได้)
-- ล็อกระดับบริษัทกันปิด/เปิดงวดพร้อมกันจนลำดับเพี้ยน; post_journal ล็อกแถวงวด (for share) จึงรอกันเอง
create or replace function acc.close_period(p_company_id uuid, p_month date) returns void
language plpgsql security definer set search_path = acc, pg_temp as $$
declare
  v_start date := date_trunc('month', p_month)::date;
  v_p     acc.periods;
  v_open  date;
begin
  if not app.can_write_company(p_company_id) then
    raise exception 'ไม่มีสิทธิ์' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('periods:' || p_company_id::text, 0));
  select * into v_p from acc.periods where company_id = p_company_id and start_date = v_start for update;
  if not found then
    raise exception 'งวด % ยังไม่มีรายการ ไม่ต้องปิด', to_char(v_start, 'YYYY-MM') using errcode = 'ACC04';
  end if;
  if v_p.closed then return; end if;
  select min(start_date) into v_open from acc.periods
   where company_id = p_company_id and start_date < v_start and not closed;
  if v_open is not null then
    raise exception 'ต้องปิดงวด % ก่อน ปิดงวดเรียงจากเดือนเก่าไปใหม่', to_char(v_open, 'YYYY-MM')
      using errcode = 'ACC13';
  end if;
  update acc.periods set closed = true, closed_at = now() where company_id = p_company_id and id = v_p.id;
end $$;

-- เปิดงวดคืน: เฉพาะครูของห้องที่บริษัทสังกัด และเฉพาะงวดล่าสุดที่ปิด (ถอยกลับทีละเดือน)
-- ไม่ให้นักเรียนเปิดเอง ไม่อย่างนั้น "ปิดงวดแล้วห้ามลงย้อนหลัง" (PLAN.md ข้อ 4) ไม่มีผล
create or replace function acc.reopen_period(p_company_id uuid, p_month date) returns void
language plpgsql security definer set search_path = acc, pg_temp as $$
declare
  v_start date := date_trunc('month', p_month)::date;
  v_owner uuid;
  v_p     acc.periods;
  v_last  date;
begin
  -- อ่านบริษัทได้แต่ไม่ใช่เจ้าของ = ครูของห้องที่บริษัทนี้สังกัด
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

-- ผังบัญชี: บัญชีที่มีรายการแล้วปิดใช้ไม่ได้ (กลับรายการต้องใช้บัญชีเดิม และยอดในงบต้องหาที่มาได้)
create or replace function acc.guard_account_identity() returns trigger
language plpgsql as $$
begin
  if (new.code <> old.code or new.type <> old.type)
     and exists (select 1 from acc.journal_lines where company_id = old.company_id and account_id = old.id) then
    raise exception 'บัญชี % มีรายการแล้ว เปลี่ยนรหัสหรือประเภทไม่ได้', old.code using errcode = 'ACC07';
  end if;
  if old.active and not new.active
     and exists (select 1 from acc.journal_lines where company_id = old.company_id and account_id = old.id) then
    raise exception 'บัญชี % มีรายการแล้ว ปิดใช้ไม่ได้', old.code using errcode = 'ACC07';
  end if;
  return new;
end $$;

-- รหัสบัญชี: ตัวเลข 3–10 หลัก (ผังไทยใช้ตัวเลข ขึ้นต้นตามหมวด) ชื่อไม่ว่าง
alter table acc.chart_of_accounts
  add constraint chart_of_accounts_code_format check (code ~ '^[0-9]{3,10}$') not valid,
  add constraint chart_of_accounts_name_present check (length(btrim(name)) between 1 and 120) not valid;
alter table acc.chart_of_accounts validate constraint chart_of_accounts_code_format;
alter table acc.chart_of_accounts validate constraint chart_of_accounts_name_present;

-- หน้าที่นักเรียนเปิดอยู่ (ดูสด) เพิ่มผังบัญชีกับปิดงวด
alter table acc.presence drop constraint presence_page_check;
alter table acc.presence add constraint presence_page_check
  check (page in ('home','journal','ledger','trial-balance','statements','accounts','closing','menu','other'));

-- migrate:down
alter table acc.presence drop constraint presence_page_check;
alter table acc.presence add constraint presence_page_check
  check (page in ('home','journal','ledger','trial-balance','statements','menu','other'));
alter table acc.chart_of_accounts drop constraint chart_of_accounts_code_format,
  drop constraint chart_of_accounts_name_present;

create or replace function acc.guard_account_identity() returns trigger
language plpgsql as $$
begin
  if (new.code <> old.code or new.type <> old.type)
     and exists (select 1 from acc.journal_lines where company_id = old.company_id and account_id = old.id) then
    raise exception 'บัญชี % มีรายการแล้ว เปลี่ยนรหัสหรือประเภทไม่ได้', old.code using errcode = 'ACC07';
  end if;
  return new;
end $$;

create or replace function acc.reopen_period(p_company_id uuid, p_month date) returns void
language plpgsql security definer set search_path = acc, pg_temp as $$
begin
  if not app.can_write_company(p_company_id) then
    raise exception 'ไม่มีสิทธิ์' using errcode = '42501';
  end if;
  update acc.periods set closed = false, closed_at = null
   where company_id = p_company_id and start_date = date_trunc('month', p_month)::date;
  if not found then raise exception 'ไม่พบงวด' using errcode = 'ACC04'; end if;
end $$;

create or replace function acc.close_period(p_company_id uuid, p_month date) returns void
language plpgsql security definer set search_path = acc, pg_temp as $$
begin
  if not app.can_write_company(p_company_id) then
    raise exception 'ไม่มีสิทธิ์' using errcode = '42501';
  end if;
  update acc.periods set closed = true, closed_at = now()
   where company_id = p_company_id and start_date = date_trunc('month', p_month)::date;
  if not found then raise exception 'ไม่พบงวด' using errcode = 'ACC04'; end if;
end $$;

create or replace function acc.reverse_journal(
  p_company_id uuid, p_entry_id uuid, p_entry_date date,
  p_idempotency_key text, p_description text default null
) returns uuid
language plpgsql security definer set search_path = acc, pg_temp as $$
declare
  v_e   acc.journal_entries;
  v_lines jsonb;
begin
  if not app.can_write_company(p_company_id) then
    raise exception 'ไม่มีสิทธิ์ลงบัญชีในบริษัทนี้' using errcode = '42501';
  end if;
  select * into v_e from acc.journal_entries where company_id = p_company_id and id = p_entry_id;
  if not found then
    raise exception 'ไม่พบรายการที่จะกลับ' using errcode = 'ACC04';
  end if;
  select jsonb_agg(jsonb_build_object(
           'account_code', a.code, 'debit', l.credit::text, 'credit', l.debit::text, 'memo', l.memo)
         order by l.line_no)
    into v_lines
    from acc.journal_lines l join acc.chart_of_accounts a
      on a.company_id = l.company_id and a.id = l.account_id
   where l.company_id = p_company_id and l.entry_id = p_entry_id;
  return acc.post_journal(p_company_id, p_entry_date,
           coalesce(p_description, 'กลับรายการ ' || v_e.doc_no), v_lines,
           p_idempotency_key, 'RV', p_entry_id);
end $$;
