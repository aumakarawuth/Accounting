-- migrate:up

-- ตัวช่วยสิทธิ์ (security definer เพื่อไม่ให้ RLS เรียกตัวเองวน)
create function app.user_role() returns text
language sql stable security definer set search_path = acc, pg_temp as $$
  select role from acc.users where id = app.current_user_id() and active
$$;

create function app.current_school_id() returns uuid
language sql stable security definer set search_path = acc, pg_temp as $$
  select school_id from acc.users where id = app.current_user_id() and active
$$;

create function app.company_in_my_school(p_company uuid) returns boolean
language sql stable security definer set search_path = acc, pg_temp as $$
  select exists (select 1 from acc.companies c
                  where c.id = p_company and c.school_id = app.current_school_id())
$$;

create function app.can_write_company(p_company uuid) returns boolean
language sql stable security definer set search_path = acc, pg_temp as $$
  select exists (
    select 1 from acc.companies c join acc.users u on u.id = c.owner_id
    where c.id = p_company and c.owner_id = app.current_user_id() and u.active)
$$;

-- เจ้าของอ่านได้ ครูอ่านได้เฉพาะบริษัทในห้องตัวเอง (อ่านอย่างเดียว)
create function app.can_read_company(p_company uuid) returns boolean
language sql stable security definer set search_path = acc, pg_temp as $$
  select exists (
    select 1 from acc.companies c
    where c.id = p_company
      and (c.owner_id = app.current_user_id()
           or exists (select 1 from acc.classrooms r
                      join acc.users u on u.id = r.teacher_id and u.active
                      where r.id = c.classroom_id and r.teacher_id = app.current_user_id())))
$$;

create function app.is_teacher_of_student(p_student uuid) returns boolean
language sql stable security definer set search_path = acc, pg_temp as $$
  select exists (
    select 1 from acc.enrollments e join acc.classrooms r on r.id = e.classroom_id
    where e.user_id = p_student and r.teacher_id = app.current_user_id())
$$;

grant execute on function app.user_role(), app.company_in_my_school(uuid), app.current_school_id(), app.can_write_company(uuid), app.can_read_company(uuid),
  app.is_teacher_of_student(uuid) to app_rw, app_ro;

-- สร้างบริษัทจำลอง = ผังบัญชีชุดแยกขาด
create function acc.create_company(p_name text, p_classroom uuid default null) returns uuid
language plpgsql security definer set search_path = acc, pg_temp as $$
declare
  v_user acc.users;
  v_id uuid;
begin
  select * into v_user from acc.users where id = app.current_user_id() and active;
  if not found or v_user.role not in ('student','teacher') then
    raise exception 'ไม่มีสิทธิ์สร้างบริษัท' using errcode = '42501';
  end if;
  if p_classroom is not null and not exists (
       select 1 from acc.classrooms r
       where r.id = p_classroom and r.school_id = v_user.school_id
         and (r.teacher_id = v_user.id
              or exists (select 1 from acc.enrollments e where e.classroom_id = r.id and e.user_id = v_user.id))) then
    raise exception 'ไม่ได้อยู่ในห้องนี้' using errcode = '42501';
  end if;
  insert into acc.companies (school_id, owner_id, classroom_id, name)
  values (v_user.school_id, v_user.id, p_classroom, p_name) returning id into v_id;
  insert into acc.chart_of_accounts (company_id, code, name, type)
  select v_id, code, name, type from acc.coa_template;
  return v_id;
end $$;

-- ลงบัญชีผ่านฟังก์ชันนี้ที่เดียว ทรานแซกชันเดียว
-- p_lines: [{"account_code":"1110","debit":"1000.00","credit":"0","memo":""}, ...]
create function acc.post_journal(
  p_company_id      uuid,
  p_entry_date      date,
  p_description     text,
  p_lines           jsonb,
  p_idempotency_key text,
  p_doc_prefix      text default 'JV',
  p_reverses        uuid default null
) returns uuid
language plpgsql security definer set search_path = acc, pg_temp as $$
declare
  v_hash   text;
  v_eid    uuid;
  v_old    text;
  v_start  date;
  v_pid    uuid;
  v_closed boolean;
  v_no     bigint;
  v_doc    text;
  v_d numeric := 0; v_c numeric := 0; v_dr numeric; v_cr numeric; v_n int := 0;
  r record;
begin
  if not app.can_write_company(p_company_id) then
    raise exception 'ไม่มีสิทธิ์ลงบัญชีในบริษัทนี้' using errcode = '42501';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) < 8 then
    raise exception 'ต้องมี idempotency key' using errcode = 'ACC03';
  end if;
  if jsonb_typeof(p_lines) is distinct from 'array' then
    raise exception 'รายการบัญชีต้องเป็นอาร์เรย์' using errcode = 'ACC05';
  end if;

  v_hash := md5(concat_ws('|', p_company_id, p_entry_date, p_description, p_doc_prefix,
                          coalesce(p_reverses::text,''), p_lines::text));

  -- กันกดซ้ำ: คำขอที่สองจะรอคำขอแรกจบ แล้วได้รายการเดิมกลับไป
  insert into acc.idempotency_keys (company_id, key, request_hash)
  values (p_company_id, p_idempotency_key, v_hash) on conflict do nothing;
  if not found then
    select entry_id, request_hash into v_eid, v_old
      from acc.idempotency_keys where company_id = p_company_id and key = p_idempotency_key;
    if v_old <> v_hash then
      raise exception 'idempotency key นี้ถูกใช้กับคำขออื่นแล้ว' using errcode = 'ACC03';
    end if;
    return v_eid;
  end if;

  -- ตรวจจำนวนเงิน (ทศนิยมไม่เกิน 2 ตำแหน่ง) รหัสบัญชี และยอดดุล
  for r in select l.ord::int as ord, l.value as j
             from jsonb_array_elements(p_lines) with ordinality as l(value, ord)
  loop
    begin
      v_dr := coalesce(nullif(r.j->>'debit','')::numeric, 0);
      v_cr := coalesce(nullif(r.j->>'credit','')::numeric, 0);
    exception when invalid_text_representation then
      raise exception 'บรรทัดที่ %: จำนวนเงินไม่ถูกต้อง', r.ord using errcode = 'ACC05';
    end;
    if v_dr <> round(v_dr,2) or v_cr <> round(v_cr,2) or v_dr < 0 or v_cr < 0
       or (v_dr > 0) = (v_cr > 0) then
      raise exception 'บรรทัดที่ %: ต้องมียอดด้านเดียว เป็นบวก ทศนิยมไม่เกิน 2 ตำแหน่ง', r.ord
        using errcode = 'ACC05';
    end if;
    if not exists (select 1 from acc.chart_of_accounts
                    where company_id = p_company_id and code = r.j->>'account_code' and active) then
      raise exception 'บรรทัดที่ %: ไม่พบรหัสบัญชี %', r.ord, coalesce(r.j->>'account_code','(ว่าง)')
        using errcode = 'ACC04';
    end if;
    v_d := v_d + v_dr; v_c := v_c + v_cr; v_n := v_n + 1;
  end loop;

  if v_n < 2 then
    raise exception 'ต้องมีอย่างน้อย 2 บรรทัด' using errcode = 'ACC01';
  end if;
  if v_d <> v_c then
    raise exception 'เดบิต % ไม่เท่าเครดิต % ผลต่าง %',
      to_char(v_d,'FM999,999,999,990.00'), to_char(v_c,'FM999,999,999,990.00'),
      to_char(abs(v_d-v_c),'FM999,999,999,990.00') using errcode = 'ACC01';
  end if;

  -- งวด: สร้างรายเดือนตามต้องการ ล็อกแถวไว้กันปิดงวดพร้อมลงรายการ
  v_start := date_trunc('month', p_entry_date)::date;
  insert into acc.periods (company_id, start_date, end_date)
  values (p_company_id, v_start, (v_start + interval '1 month' - interval '1 day')::date)
  on conflict (company_id, start_date) do nothing;
  select id, closed into v_pid, v_closed
    from acc.periods where company_id = p_company_id and start_date = v_start for share;
  if v_closed then
    raise exception 'งวด % ปิดแล้ว ลงรายการไม่ได้', to_char(v_start,'YYYY-MM') using errcode = 'ACC02';
  end if;

  -- เลขที่เอกสาร: ล็อกแถว ไม่ซ้ำ ไม่ข้าม (ถ้าทรานแซกชันล้ม เลขย้อนกลับด้วย)
  insert into acc.document_sequences (company_id, prefix, last_no)
  values (p_company_id, p_doc_prefix, 1)
  on conflict (company_id, prefix) do update set last_no = acc.document_sequences.last_no + 1
  returning last_no into v_no;
  v_doc := p_doc_prefix || '-' || lpad(v_no::text, 4, '0');

  insert into acc.journal_entries (company_id, period_id, doc_prefix, doc_no, entry_date,
                                   description, total_amount, reverses_entry_id, posted_by)
  values (p_company_id, v_pid, p_doc_prefix, v_doc, p_entry_date, coalesce(p_description,''),
          v_d, p_reverses, app.current_user_id())
  returning id into v_eid;

  -- บรรทัด + ยอดคงเหลือในทรานแซกชันเดียวกัน (เรียงตามบัญชีเพื่อกัน deadlock)
  with src as (
    select l.ord::int as ord, a.id as account_id,
           coalesce(nullif(l.value->>'debit',''),'0')::numeric(18,2)  as debit,
           coalesce(nullif(l.value->>'credit',''),'0')::numeric(18,2) as credit,
           coalesce(l.value->>'memo','') as memo
      from jsonb_array_elements(p_lines) with ordinality as l(value, ord)
      join acc.chart_of_accounts a
        on a.company_id = p_company_id and a.code = l.value->>'account_code'
  ), ins as (
    insert into acc.journal_lines (company_id, entry_id, line_no, account_id, debit, credit, memo)
    select p_company_id, v_eid, ord, account_id, debit, credit, memo from src
    returning account_id, debit, credit
  )
  insert into acc.account_balances (company_id, period_id, account_id, debit_total, credit_total)
  select p_company_id, v_pid, account_id, sum(debit), sum(credit)
    from ins group by account_id order by account_id
  on conflict (company_id, period_id, account_id) do update
    set debit_total  = acc.account_balances.debit_total  + excluded.debit_total,
        credit_total = acc.account_balances.credit_total + excluded.credit_total;

  update acc.idempotency_keys set entry_id = v_eid
   where company_id = p_company_id and key = p_idempotency_key;
  return v_eid;
end $$;

-- กลับรายการ: สลับเดบิต/เครดิตของรายการเดิม (กลับได้ครั้งเดียวต่อรายการ)
create function acc.reverse_journal(
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

create function acc.close_period(p_company_id uuid, p_month date) returns void
language plpgsql security definer set search_path = acc, pg_temp as $$
begin
  if not app.can_write_company(p_company_id) then
    raise exception 'ไม่มีสิทธิ์' using errcode = '42501';
  end if;
  update acc.periods set closed = true, closed_at = now()
   where company_id = p_company_id and start_date = date_trunc('month', p_month)::date;
  if not found then raise exception 'ไม่พบงวด' using errcode = 'ACC04'; end if;
end $$;

create function acc.reopen_period(p_company_id uuid, p_month date) returns void
language plpgsql security definer set search_path = acc, pg_temp as $$
begin
  if not app.can_write_company(p_company_id) then
    raise exception 'ไม่มีสิทธิ์' using errcode = '42501';
  end if;
  update acc.periods set closed = false, closed_at = null
   where company_id = p_company_id and start_date = date_trunc('month', p_month)::date;
  if not found then raise exception 'ไม่พบงวด' using errcode = 'ACC04'; end if;
end $$;

-- งบทดลอง จาก account_balances (invoker: RLS ใช้กับผู้เรียก)
create function acc.trial_balance(p_company_id uuid, p_through date default null)
returns table (code text, name text, type text, debit_total numeric, credit_total numeric)
language sql stable as $$
  select a.code, a.name, a.type,
         coalesce(sum(b.debit_total),0)::numeric(18,2),
         coalesce(sum(b.credit_total),0)::numeric(18,2)
    from acc.chart_of_accounts a
    left join acc.account_balances b on b.company_id = a.company_id and b.account_id = a.id
    left join acc.periods p on p.company_id = b.company_id and p.id = b.period_id
   where a.company_id = p_company_id
     and (p_through is null or p.start_date <= p_through)
   group by a.code, a.name, a.type
   order by a.code
$$;

revoke all on function acc.create_company(text, uuid), acc.post_journal(uuid,date,text,jsonb,text,text,uuid),
  acc.reverse_journal(uuid,uuid,date,text,text), acc.close_period(uuid,date), acc.reopen_period(uuid,date),
  acc.trial_balance(uuid,date) from public;
grant execute on function acc.create_company(text, uuid), acc.post_journal(uuid,date,text,jsonb,text,text,uuid),
  acc.reverse_journal(uuid,uuid,date,text,text), acc.close_period(uuid,date), acc.reopen_period(uuid,date),
  acc.trial_balance(uuid,date) to app_rw;
grant execute on function acc.trial_balance(uuid,date) to app_ro;

-- migrate:down
drop function acc.trial_balance(uuid,date), acc.reopen_period(uuid,date), acc.close_period(uuid,date),
  acc.reverse_journal(uuid,uuid,date,text,text), acc.post_journal(uuid,date,text,jsonb,text,text,uuid),
  acc.create_company(text,uuid), app.is_teacher_of_student(uuid), app.can_read_company(uuid),
  app.can_write_company(uuid), app.current_school_id(), app.company_in_my_school(uuid), app.user_role();
