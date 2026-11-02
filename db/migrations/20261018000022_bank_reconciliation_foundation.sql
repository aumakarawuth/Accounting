-- migrate:up
-- เฟส 3.2 กระทบยอดธนาคาร: statement เป็นหลักฐานต้นฉบับ จับคู่กับสมุดรายวันได้หลายต่อหลาย

create table acc.bank_statements (
  id uuid not null default gen_random_uuid(),
  company_id uuid not null references acc.companies(id),
  bank_account_id uuid not null,
  period_start date not null,
  period_end date not null,
  opening_balance numeric(18,2) not null,
  closing_balance numeric(18,2) not null,
  imported_at timestamptz not null default now(),
  imported_by uuid not null references acc.users(id),
  primary key(company_id,id),
  unique(company_id,bank_account_id,period_start,period_end),
  foreign key(company_id,bank_account_id) references acc.chart_of_accounts(company_id,id),
  check(period_end >= period_start)
);
create table acc.bank_statement_lines (
  id uuid not null default gen_random_uuid(),
  company_id uuid not null,
  statement_id uuid not null,
  line_date date not null,
  description text not null check(length(btrim(description)) between 1 and 300),
  reference text not null default '' check(length(reference) <= 100),
  amount numeric(18,2) not null check(amount <> 0), -- เงินเข้า +, เงินออก -
  balance numeric(18,2),
  primary key(company_id,id),
  unique(company_id,statement_id,line_date,reference,amount,description),
  foreign key(company_id,statement_id) references acc.bank_statements(company_id,id)
);
create table acc.bank_reconciliation_matches (
  company_id uuid not null,
  statement_line_id uuid not null,
  entry_id uuid not null,
  amount numeric(18,2) not null check(amount <> 0),
  created_at timestamptz not null default now(),
  created_by uuid not null references acc.users(id),
  primary key(company_id,statement_line_id,entry_id),
  foreign key(company_id,statement_line_id) references acc.bank_statement_lines(company_id,id),
  foreign key(company_id,entry_id) references acc.journal_entries(company_id,id)
);

create function acc.guard_bank_account() returns trigger language plpgsql as $$
begin
  if not exists (select 1 from acc.chart_of_accounts a where a.company_id=new.company_id and a.id=new.bank_account_id
                 and a.active and a.type='asset' and a.code like '11%') then
    raise exception 'บัญชีกระทบยอดต้องเป็นบัญชีเงินสดหรือเงินฝาก (11xx)' using errcode='ACC04';
  end if;
  return new;
end $$;
create trigger bank_statements_account before insert on acc.bank_statements for each row execute function acc.guard_bank_account();
create trigger bank_statements_locked before insert on acc.bank_statements for each row execute function acc.guard_locked_company();
create trigger bank_statements_immutable before update or delete on acc.bank_statements for each row execute function acc.forbid_mutation();
create trigger bank_lines_immutable before update or delete on acc.bank_statement_lines for each row execute function acc.forbid_mutation();
create trigger bank_matches_immutable before update or delete on acc.bank_reconciliation_matches for each row execute function acc.forbid_mutation();

alter table acc.bank_statements enable row level security;
alter table acc.bank_statement_lines enable row level security;
alter table acc.bank_reconciliation_matches enable row level security;
grant select on acc.bank_statements,acc.bank_statement_lines,acc.bank_reconciliation_matches to app_rw,app_ro;
grant insert on acc.bank_statements,acc.bank_statement_lines,acc.bank_reconciliation_matches to app_rw;
create policy bank_statements_read on acc.bank_statements for select to app_rw,app_ro using(app.can_read_company(company_id));
create policy bank_lines_read on acc.bank_statement_lines for select to app_rw,app_ro using(app.can_read_company(company_id));
create policy bank_matches_read on acc.bank_reconciliation_matches for select to app_rw,app_ro using(app.can_read_company(company_id));
create policy bank_statements_write on acc.bank_statements for insert to app_rw with check(app.can_write_company(company_id));
create policy bank_lines_write on acc.bank_statement_lines for insert to app_rw with check(app.can_write_company(company_id));
create policy bank_matches_write on acc.bank_reconciliation_matches for insert to app_rw with check(app.can_write_company(company_id));

-- สรุปยอด: ยอดธนาคาร, ยอดสมุดบัญชี, และรายการที่ยังไม่จับคู่
create function acc.bank_reconciliation(p_company uuid,p_statement uuid)
returns table(opening_balance numeric,closing_balance numeric,statement_total numeric,book_balance numeric,unmatched_bank numeric,unmatched_book numeric)
language sql stable as $$
  with s as (select * from acc.bank_statements where company_id=p_company and id=p_statement),
  b as (select coalesce(sum(l.debit-l.credit),0) amount from s join acc.journal_lines l on l.company_id=s.company_id and l.account_id=s.bank_account_id join acc.journal_entries e on e.company_id=l.company_id and e.id=l.entry_id where e.entry_date<=s.period_end),
  sl as (select coalesce(sum(amount),0) amount from acc.bank_statement_lines where company_id=p_company and statement_id=p_statement),
  um as (select coalesce(sum(l.amount),0) amount from acc.bank_statement_lines l where l.company_id=p_company and l.statement_id=p_statement and not exists(select 1 from acc.bank_reconciliation_matches m where m.company_id=l.company_id and m.statement_line_id=l.id)),
  ub as (select coalesce(sum(l.debit-l.credit-coalesce(x.matched,0)),0) amount from s join acc.journal_lines l on l.company_id=s.company_id and l.account_id=s.bank_account_id join acc.journal_entries e on e.company_id=l.company_id and e.id=l.entry_id left join lateral(select sum(m.amount) matched from acc.bank_reconciliation_matches m where m.company_id=l.company_id and m.entry_id=l.entry_id) x on true where e.entry_date between s.period_start and s.period_end)
  select s.opening_balance,s.closing_balance,sl.amount,b.amount,um.amount::numeric(18,2),ub.amount from s cross join b cross join sl cross join um cross join ub
$$;
grant execute on function acc.bank_reconciliation(uuid,uuid) to app_rw,app_ro;

-- migrate:down
drop function acc.bank_reconciliation(uuid,uuid);
drop table acc.bank_reconciliation_matches;
drop table acc.bank_statement_lines;
drop table acc.bank_statements;
drop function acc.guard_bank_account();
