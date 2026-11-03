-- migrate:up
-- กระดาษทำการ 6 / 8 / 10 ช่อง: รายการปรับปรุงเป็นเลขที่ชุด AJ ลงวันสิ้นเดือน ผู้ดูแลระบบเลือกได้ว่าโรงเรียนเปิดใช้แบบไหน

alter table acc.schools add column worksheet_formats smallint[] not null default '{6,8,10}'
  check (worksheet_formats <@ '{6,8,10}'::smallint[]);

create function acc.admin_set_worksheet_formats(p_formats smallint[]) returns smallint[]
language plpgsql security definer set search_path = acc, pg_temp as $$
declare
  v_school uuid := app.require_admin();
  v_sorted smallint[];
begin
  if p_formats is null or not (p_formats <@ '{6,8,10}'::smallint[]) then
    raise exception 'แบบกระดาษทำการต้องเป็น 6, 8 หรือ 10 ช่อง' using errcode = '22023';
  end if;
  select coalesce(array_agg(distinct f order by f), '{}') into v_sorted from unnest(p_formats) f;
  update acc.schools set worksheet_formats = v_sorted where id = v_school;
  return v_sorted;
end $$;
revoke all on function acc.admin_set_worksheet_formats(smallint[]) from public;
grant execute on function acc.admin_set_worksheet_formats(smallint[]) to app_rw;

-- รายการปรับปรุง (AJ) ต้องลงวันสิ้นเดือน (ใส่ช่องปรับปรุงของกระดาษทำการเดือนนั้น)
create function acc.guard_adjusting_entry() returns trigger
language plpgsql as $$
begin
  if new.doc_prefix = 'AJ' and new.entry_date <> (date_trunc('month', new.entry_date) + interval '1 month - 1 day')::date then
    raise exception 'รายการปรับปรุงต้องลงวันที่สิ้นเดือน (%)',
      to_char((date_trunc('month', new.entry_date) + interval '1 month - 1 day')::date, 'DD/MM/') || (extract(year from new.entry_date)::int + 543)
      using errcode = '22023';
  end if;
  return new;
end $$;
create trigger journal_entries_adjusting before insert on acc.journal_entries for each row execute function acc.guard_adjusting_entry();

-- ยอดแต่ละบัญชีสำหรับกระดาษทำการ ณ สิ้นเดือน (ยอดสะสมตั้งแต่เริ่มบริษัท เหมือนงบทดลอง)
-- รายการปรับปรุงของเดือน = AJ ที่ลงวันที่ในเดือนนี้ และการกลับรายการของ AJ ที่ลงวันที่ในเดือนนี้
-- unadjusted = ยอดสุทธิไม่รวมรายการปรับปรุงของเดือน · adj_debit/adj_credit = ยอดรวมรายการปรับปรุงของเดือนแยกเดบิต/เครดิต
create function acc.worksheet(p_company uuid, p_month date)
returns table (code text, name text, type text, normal_side text, unadjusted numeric, adj_debit numeric, adj_credit numeric)
language sql stable as $$
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
grant execute on function acc.worksheet(uuid, date) to app_rw, app_ro;

-- migrate:down
drop function acc.worksheet(uuid, date);
drop trigger journal_entries_adjusting on acc.journal_entries;
drop function acc.guard_adjusting_entry();
drop function acc.admin_set_worksheet_formats(smallint[]);
alter table acc.schools drop column worksheet_formats;
