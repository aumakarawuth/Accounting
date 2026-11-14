-- migrate:up
-- กระดาษทำการ: คิดขอบเขตวันที่/ต้นปีบัญชีครั้งเดียว และคัดรายการก่อนค่อยอ่านบรรทัด (materialized)
-- เดิม planner รวม CTE bounds เข้าไปในลูป บริษัทที่เพิ่งสร้าง (ยังไม่มีสถิติ คาด 1 แถว) เรียก fiscal_year_start
-- ทุกคู่บรรทัด × รายการ: ~250 รายการใช้ 1.2 วินาที โตตามกำลังสอง · ผลลัพธ์เหมือนเดิมทุกแถว
create or replace function acc.worksheet(p_company uuid, p_month date)
returns table (code text, name text, type text, normal_side text, unadjusted numeric, adj_debit numeric, adj_credit numeric)
language sql stable set search_path = acc, pg_temp as $$
  with bounds as materialized (
    select date_trunc('month', p_month)::date as s, (date_trunc('month', p_month) + interval '1 month - 1 day')::date as e,
           acc.fiscal_year_start(p_company, p_month) as fy
  ), ent as materialized (
    select e.id, (e.entry_date >= b.s and (e.doc_prefix = 'AJ' or coalesce(o.doc_prefix, '') = 'AJ')) as adj
      from acc.journal_entries e
      cross join bounds b
      left join acc.journal_entries o on o.company_id = e.company_id and o.id = e.reverses_entry_id
     where e.company_id = p_company and e.entry_date <= b.e
       and not (e.doc_prefix = 'CL' and e.entry_date >= b.fy)
  ), l as materialized (
    select l.account_id, l.debit, l.credit, ent.adj
      from acc.journal_lines l join ent on ent.id = l.entry_id
     where l.company_id = p_company
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

-- migrate:down
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
