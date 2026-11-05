-- migrate:up
-- กระทบยอดธนาคาร: ตรวจการจับคู่ที่ DB (ก่อนหน้านี้ API บันทึกได้ทุกคู่ แม้รายการในสมุดไม่ได้ลงบัญชีธนาคารนั้น
-- จับคู่เกินยอดของบรรทัด statement หรือคนละทิศ) พบตอนทดสอบทั้งระบบ docs/full-system-test.md
create function acc.guard_bank_match() returns trigger
language plpgsql security definer set search_path = acc, pg_temp as $$
declare
  l   record;
  v_book numeric;
  v_line_used numeric;
  v_entry_used numeric;
  v_date date;
begin
  -- จับคู่พร้อมกันสองแท็บ: ทำทีละคำขอต่อบรรทัด statement
  perform pg_advisory_xact_lock(hashtext('bank-match:' || new.statement_line_id::text));
  -- คู่เดิมซ้ำ (กดซ้ำ/เน็ตหลุดส่งใหม่): ปล่อยให้ on conflict do nothing ของ API จัดการ ไม่นับยอดซ้ำ
  if exists (select 1 from acc.bank_reconciliation_matches m where m.company_id = new.company_id
              and m.statement_line_id = new.statement_line_id and m.entry_id = new.entry_id) then
    return new;
  end if;
  select bl.amount, bl.line_date, s.bank_account_id, s.period_end
    into l
    from acc.bank_statement_lines bl
    join acc.bank_statements s on s.company_id = bl.company_id and s.id = bl.statement_id
   where bl.company_id = new.company_id and bl.id = new.statement_line_id;
  if not found then
    raise exception 'ไม่พบรายการเดินบัญชีนี้' using errcode = 'ACC04';
  end if;
  select sum(jl.debit - jl.credit), min(e.entry_date) into v_book, v_date
    from acc.journal_lines jl join acc.journal_entries e on e.company_id = jl.company_id and e.id = jl.entry_id
   where jl.company_id = new.company_id and jl.entry_id = new.entry_id and jl.account_id = l.bank_account_id;
  if coalesce(v_book, 0) = 0 then
    raise exception 'รายการนี้ไม่ได้ลงบัญชีธนาคารของ statement นี้ จับคู่ไม่ได้' using errcode = 'ACC15';
  end if;
  if v_date > l.period_end then
    raise exception 'รายการในสมุดลงวันที่หลังงวดของ statement จับคู่ไม่ได้' using errcode = 'ACC15';
  end if;
  if sign(new.amount) <> sign(l.amount) or sign(new.amount) <> sign(v_book) then
    raise exception 'เงินเข้า/เงินออกคนละทิศกับรายการเดินบัญชี จับคู่ไม่ได้' using errcode = 'ACC15';
  end if;
  select coalesce(sum(amount), 0) into v_line_used from acc.bank_reconciliation_matches
   where company_id = new.company_id and statement_line_id = new.statement_line_id;
  if abs(v_line_used + new.amount) > abs(l.amount) then
    raise exception 'จับคู่เกินยอดรายการเดินบัญชี (จับคู่แล้ว %, รายการนี้ %)', abs(v_line_used), abs(l.amount) using errcode = 'ACC15';
  end if;
  select coalesce(sum(m.amount), 0) into v_entry_used
    from acc.bank_reconciliation_matches m
    join acc.bank_statement_lines bl on bl.company_id = m.company_id and bl.id = m.statement_line_id
    join acc.bank_statements s on s.company_id = bl.company_id and s.id = bl.statement_id
   where m.company_id = new.company_id and m.entry_id = new.entry_id and s.bank_account_id = l.bank_account_id;
  if abs(v_entry_used + new.amount) > abs(v_book) then
    raise exception 'รายการในสมุดนี้ถูกจับคู่ครบยอดแล้ว' using errcode = 'ACC15';
  end if;
  return new;
end $$;
create trigger bank_matches_guard before insert on acc.bank_reconciliation_matches
  for each row execute function acc.guard_bank_match();
create trigger bank_matches_locked before insert on acc.bank_reconciliation_matches
  for each row execute function acc.guard_locked_company();

-- migrate:down
drop trigger bank_matches_locked on acc.bank_reconciliation_matches;
drop trigger bank_matches_guard on acc.bank_reconciliation_matches;
drop function acc.guard_bank_match();
