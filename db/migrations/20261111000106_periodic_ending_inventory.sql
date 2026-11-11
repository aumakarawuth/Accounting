-- migrate:up
-- ระบบสินค้าสิ้นงวด: บันทึกสินค้าคงเหลือปลายงวดตามตรวจนับ (docs/phase5-spec.md ข้อ 2, docs/assumptions.md ข้อ 41)
-- ลงรายการปรับปรุง (AJ) วันสิ้นเดือน ปรับ 1310 ให้เท่ายอดตรวจนับ คู่กับ 5130 ต้นทุนขาย
-- ใช้ไม่ได้เมื่อบริษัทมีสินค้าที่ติดตามสต็อก (ระบบต่อเนื่อง: 1310 คุมด้วยบัตรสต็อก ปรับที่หน้าสินค้าคงเหลือ)

create function acc.record_ending_inventory(p_company uuid, p_month_end date, p_amount numeric, p_key text) returns uuid
language plpgsql security definer set search_path = acc, pg_temp as $$
declare
  v_end   date := (date_trunc('month', p_month_end) + interval '1 month - 1 day')::date;
  v_bal   numeric(18,2);
  v_diff  numeric(18,2);
  v_lines jsonb;
begin
  if not app.can_write_company(p_company) then
    raise exception 'ไม่มีสิทธิ์ลงบัญชีในบริษัทนี้' using errcode = '42501';
  end if;
  if p_month_end is distinct from v_end then
    raise exception 'สินค้าคงเหลือปลายงวดลงวันสิ้นเดือนเท่านั้น (%)', acc.thai_date(v_end) using errcode = '22023';
  end if;
  if p_amount is null or p_amount < 0 or p_amount <> round(p_amount, 2) then
    raise exception 'มูลค่าสินค้าคงเหลือต้องไม่ติดลบ ทศนิยมไม่เกิน 2 ตำแหน่ง' using errcode = 'ACC05';
  end if;
  if exists (select 1 from acc.items where company_id = p_company and track_inventory) then
    raise exception 'บริษัทนี้ติดตามสต็อกรายสินค้า (ระบบต่อเนื่อง) ยอดสินค้าคงเหลือมาจากบัตรสต็อก ปรับที่หน้าสินค้าคงเหลือ'
      using errcode = 'ACC15';
  end if;
  -- กันสองคำขอคำนวณส่วนต่างจากยอดเดียวกัน
  perform pg_advisory_xact_lock(hashtextextended('ending-inventory:' || p_company::text, 0));
  if exists (select 1 from acc.idempotency_keys where company_id = p_company and key = p_key) then
    return (select entry_id from acc.idempotency_keys where company_id = p_company and key = p_key);
  end if;
  insert into acc.chart_of_accounts (company_id, code, name, type) values (p_company, '5130', 'ต้นทุนขาย', 'expense')
  on conflict (company_id, code) do nothing;

  select coalesce(sum(l.debit - l.credit), 0) into v_bal
    from acc.journal_lines l
    join acc.journal_entries e on e.company_id = l.company_id and e.id = l.entry_id
    join acc.chart_of_accounts a on a.company_id = l.company_id and a.id = l.account_id
   where l.company_id = p_company and a.code = '1310' and e.entry_date <= v_end;
  v_diff := p_amount - v_bal;
  if v_diff = 0 then
    raise exception 'ยอดสินค้าคงเหลือในบัญชี ณ % เท่ากับ % อยู่แล้ว ไม่ต้องปรับปรุง', acc.thai_date(v_end),
      to_char(p_amount, 'FM999,999,999,990.00') using errcode = 'ACC15';
  end if;
  v_lines := case when v_diff > 0 then jsonb_build_array(
      jsonb_build_object('account_code', '1310', 'debit', v_diff::text, 'memo', 'สินค้าคงเหลือปลายงวด'),
      jsonb_build_object('account_code', '5130', 'credit', v_diff::text, 'memo', 'สินค้าคงเหลือปลายงวด'))
    else jsonb_build_array(
      jsonb_build_object('account_code', '5130', 'debit', (-v_diff)::text, 'memo', 'สินค้าคงเหลือปลายงวด'),
      jsonb_build_object('account_code', '1310', 'credit', (-v_diff)::text, 'memo', 'สินค้าคงเหลือปลายงวด')) end;
  return acc.post_journal(p_company, v_end,
    'ปรับปรุงสินค้าคงเหลือปลายงวดตามตรวจนับ ' || to_char(p_amount, 'FM999,999,999,990.00') || ' บาท (เดิม '
      || to_char(v_bal, 'FM999,999,999,990.00') || ')',
    v_lines, p_key, 'AJ');
end $$;

revoke all on function acc.record_ending_inventory(uuid, date, numeric, text) from public;
grant execute on function acc.record_ending_inventory(uuid, date, numeric, text) to app_rw;

-- migrate:down
drop function acc.record_ending_inventory(uuid, date, numeric, text);
