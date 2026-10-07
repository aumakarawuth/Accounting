-- migrate:up
create extension if not exists pgcrypto;

create table acc.schools (
  id   uuid primary key default gen_random_uuid(),
  name text not null
);

create table acc.users (
  id           uuid primary key default gen_random_uuid(),
  school_id    uuid not null references acc.schools(id),
  role         text not null check (role in ('admin','teacher','student','ta')),
  student_code text,
  email        text,
  display_name text not null,
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  check (role <> 'student' or student_code is not null),
  check (role = 'student' or email is not null)
);
create unique index users_school_student_code on acc.users (school_id, student_code) where student_code is not null;
create unique index users_email on acc.users (lower(email)) where email is not null;

create table acc.classrooms (
  id         uuid primary key default gen_random_uuid(),
  school_id  uuid not null references acc.schools(id),
  teacher_id uuid not null references acc.users(id),
  name       text not null,
  created_at timestamptz not null default now()
);
create index classrooms_teacher on acc.classrooms (teacher_id);

create table acc.enrollments (
  classroom_id uuid not null references acc.classrooms(id),
  user_id      uuid not null references acc.users(id),
  primary key (classroom_id, user_id)
);
create index enrollments_user on acc.enrollments (user_id);

create table acc.companies (
  id           uuid primary key default gen_random_uuid(),
  school_id    uuid not null references acc.schools(id),
  owner_id     uuid not null references acc.users(id),
  classroom_id uuid references acc.classrooms(id),
  name         text not null,
  version      int  not null default 1,
  created_at   timestamptz not null default now()
);
create index companies_owner on acc.companies (owner_id);
create index companies_classroom on acc.companies (classroom_id);

-- ผังบัญชีตั้งต้น (ข้อมูลอ้างอิงร่วม คัดลอกให้ทุกบริษัทตอนสร้าง)
create table acc.coa_template (
  code text primary key,
  name text not null,
  type text not null check (type in ('asset','liability','equity','revenue','expense'))
);

create table acc.chart_of_accounts (
  id          uuid not null default gen_random_uuid(),
  company_id  uuid not null references acc.companies(id),
  code        text not null,
  name        text not null,
  type        text not null check (type in ('asset','liability','equity','revenue','expense')),
  normal_side text generated always as (case when type in ('asset','expense') then 'debit' else 'credit' end) stored,
  active      boolean not null default true,
  version     int not null default 1,
  primary key (company_id, id),
  unique (company_id, code)
);

create table acc.periods (
  id         uuid not null default gen_random_uuid(),
  company_id uuid not null references acc.companies(id),
  start_date date not null,
  end_date   date not null,
  closed     boolean not null default false,
  closed_at  timestamptz,
  primary key (company_id, id),
  unique (company_id, start_date),
  check (end_date >= start_date)
);

create table acc.document_sequences (
  company_id uuid not null references acc.companies(id),
  prefix     text not null,
  last_no    bigint not null default 0,
  primary key (company_id, prefix)
);

create table acc.journal_entries (
  id                  uuid not null default gen_random_uuid(),
  company_id          uuid not null references acc.companies(id),
  period_id           uuid not null,
  doc_prefix          text not null,
  doc_no              text not null,
  entry_date          date not null,
  description         text not null default '',
  total_amount        numeric(18,2) not null check (total_amount > 0),
  reverses_entry_id   uuid,
  posted_by           uuid not null,
  posted_at           timestamptz not null default now(),
  primary key (company_id, id),
  unique (company_id, doc_no),
  foreign key (company_id, period_id) references acc.periods (company_id, id),
  foreign key (company_id, reverses_entry_id) references acc.journal_entries (company_id, id)
);
create unique index journal_entries_reverses on acc.journal_entries (company_id, reverses_entry_id) where reverses_entry_id is not null;
create index journal_entries_period on acc.journal_entries (company_id, period_id, entry_date);

create table acc.journal_lines (
  company_id uuid not null,
  entry_id   uuid not null,
  line_no    int  not null,
  account_id uuid not null,
  debit      numeric(18,2) not null default 0 check (debit >= 0),
  credit     numeric(18,2) not null default 0 check (credit >= 0),
  memo       text not null default '',
  primary key (company_id, entry_id, line_no),
  foreign key (company_id, entry_id) references acc.journal_entries (company_id, id),
  foreign key (company_id, account_id) references acc.chart_of_accounts (company_id, id),
  check ((debit > 0) <> (credit > 0))   -- แต่ละบรรทัดมีด้านเดียว และไม่เป็นศูนย์
);
create index journal_lines_account on acc.journal_lines (company_id, account_id);

create table acc.account_balances (
  company_id   uuid not null,
  period_id    uuid not null,
  account_id   uuid not null,
  debit_total  numeric(18,2) not null default 0,
  credit_total numeric(18,2) not null default 0,
  primary key (company_id, period_id, account_id),
  foreign key (company_id, period_id)  references acc.periods (company_id, id),
  foreign key (company_id, account_id) references acc.chart_of_accounts (company_id, id)
);

create table acc.idempotency_keys (
  company_id   uuid not null references acc.companies(id),
  key          text not null,
  request_hash text not null,
  entry_id     uuid,
  created_at   timestamptz not null default now(),
  primary key (company_id, key)
);

create table acc.audit_log (
  id         bigint generated always as identity primary key,
  at         timestamptz not null default now(),
  user_id    uuid,
  company_id uuid,
  table_name text not null,
  op         text not null,
  row_pk     text,
  client     text,           -- IP/อุปกรณ์ จาก app.client_info
  old_row    jsonb,
  new_row    jsonb
);
create index audit_log_company on acc.audit_log (company_id, at);

-- migrate:down
drop schema acc cascade;
