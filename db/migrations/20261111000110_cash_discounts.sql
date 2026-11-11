-- migrate:up
-- ส่วนลดเงินสดตอนรับชำระ (4210 ส่วนลดจ่าย) และจ่ายชำระ (5120 ส่วนลดรับ) (docs/phase5-spec.md ข้อ 6, docs/assumptions.md ข้อ 45)
-- ยอดที่ตัดหนี้ = เงินที่รับ/จ่าย + ส่วนลด · สินค้า: ภาษีไม่เปลี่ยน (ลดภาษีต้องออกใบลดหนี้) · บริการ: ภาษียังไม่ถึงกำหนดของส่วนลดล้างออก
-- แก้ post_receipt / post_payment จากนิยามปัจจุบัน (รวมส่วนที่ migration เช็คและโมดูล 5 แก้ไว้)

-- amount = ยอดที่ตัดหนี้ (รวมส่วนลด) · discount = ส่วนลดเงินสดในยอดนั้น · discount_vat = ภาษียังไม่ถึงกำหนดที่ล้างออกพร้อมส่วนลด
alter table acc.allocations add column discount numeric(18,2) not null default 0 check (discount >= 0),
  add column discount_vat numeric(18,2) not null default 0 check (discount_vat >= 0 and discount_vat <= discount);
alter table acc.allocations add constraint allocations_discount_le check (discount < amount);
alter table acc.purchase_allocations add column discount numeric(18,2) not null default 0 check (discount >= 0),
  add column discount_vat numeric(18,2) not null default 0 check (discount_vat >= 0 and discount_vat <= discount);
alter table acc.purchase_allocations add constraint purchase_allocations_discount_le check (discount < amount);

CREATE OR REPLACE FUNCTION acc.post_receipt(p_company uuid, p jsonb, p_idem text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'acc', 'pg_temp'
AS $function$
declare
  co      acc.companies;
  pa      acc.parties;
  tgt     acc.documents;
  v_cash  acc.chart_of_accounts;
  v_id    uuid;
  v_date  date;
  v_amt   numeric;
  v_open  numeric; v_undue numeric; v_tr numeric;
  v_disc  numeric; v_dvat numeric; v_settle numeric; v_tdisc numeric := 0; v_tdvat numeric := 0; v_gross numeric := 0;
  v_total numeric := 0; v_vat numeric := 0; v_wht numeric;
  v_svc   boolean := false;
  v_tax   boolean;
  v_allocs jsonb := '[]';
  v_je    jsonb;
  v_eid   uuid;
  r record;
begin
  if not app.can_write_company(p_company) then
    raise exception 'ไม่มีสิทธิ์ออกเอกสารในบริษัทนี้' using errcode = '42501';
  end if;
  select id into v_id from acc.documents where company_id = p_company and idem_key = p_idem;
  if found then return v_id; end if;
  perform acc.ensure_tax_accounts(p_company);
  insert into acc.chart_of_accounts (company_id, code, name, type)
  select p_company, t.code, t.name, t.type from acc.coa_template t where t.code = '4210' on conflict (company_id, code) do nothing;
  select * into co from acc.companies where id = p_company;
  v_date := nullif(p->>'date', '')::date;
  if v_date is null then raise exception 'ต้องมีวันที่เอกสาร' using errcode = '22023'; end if;
  select * into pa from acc.parties where company_id = p_company and code = upper(p->>'party_code');
  if not found or not pa.is_customer then
    raise exception 'ไม่พบลูกค้ารหัส %', coalesce(p->>'party_code', '(ว่าง)') using errcode = 'ACC04';
  end if;
  select * into v_cash from acc.chart_of_accounts
   where company_id = p_company and code = coalesce(nullif(p->>'cash_account', ''), '1110') and active and ((type = 'asset' and code like '11%') or code = nullif(current_setting('acc.cheque_account', true), ''));
  if not found then raise exception 'บัญชีรับเงินต้องเป็นบัญชีเงินสด/เงินฝาก (11xx)' using errcode = 'ACC04'; end if;
  if jsonb_typeof(p->'allocations') is distinct from 'array' or jsonb_array_length(p->'allocations') not between 1 and 50 then
    raise exception 'ต้องเลือกใบที่รับชำระ 1–50 ใบ' using errcode = '22023';
  end if;

  -- ล็อกใบที่ถูกตัดตามลำดับ id (กันตัดเกินเมื่อรับพร้อมกัน และกัน deadlock)
  for r in select (a->>'document_id')::uuid as did, a->>'amount' as amt, a->>'discount' as disc, count(*) over (partition by a->>'document_id') as dup
             from jsonb_array_elements(p->'allocations') a order by 1 loop
    if r.dup > 1 then raise exception 'เลือกใบเดียวกันซ้ำ' using errcode = '22023'; end if;
    select * into tgt from acc.documents where company_id = p_company and id = r.did for update;
    if not found or tgt.kind not in ('sales_invoice', 'debit_note') or tgt.voided_at is not null or tgt.party_id <> pa.id then
      raise exception 'รับชำระได้เฉพาะใบขายเชื่อ/ใบเพิ่มหนี้ของลูกค้ารายนี้ที่ยังไม่ยกเลิก' using errcode = 'ACC15';
    end if;
    if tgt.doc_date > v_date then
      raise exception 'วันที่รับชำระต้องไม่ก่อนวันที่ของ %', tgt.doc_no using errcode = '22023';
    end if;
    begin v_amt := r.amt::numeric; exception when others then v_amt := null; end;
    if v_amt is null or v_amt <= 0 or v_amt <> round(v_amt, 2) then
      raise exception '%: จำนวนเงินต้องมากกว่า 0 ทศนิยมไม่เกิน 2 ตำแหน่ง', tgt.doc_no using errcode = 'ACC05';
    end if;
    -- ส่วนลดเงินสด (ไม่บังคับ): ตัดยอดค้างพร้อมเงินที่รับ
    begin v_disc := coalesce(nullif(r.disc, '')::numeric, 0); exception when others then v_disc := null; end;
    if v_disc is null or v_disc < 0 or v_disc <> round(v_disc, 2) then
      raise exception '%: ส่วนลดเงินสดต้องไม่ติดลบ ทศนิยมไม่เกิน 2 ตำแหน่ง', tgt.doc_no using errcode = 'ACC05';
    end if;
    v_settle := v_amt + v_disc;
    select tgt.total - s.amount, tgt.vat - s.vat into v_open, v_undue from acc.document_settled(p_company, tgt.id) s;
    if v_settle > v_open then
      raise exception '% ค้างอยู่ % รับเกินยอดค้างไม่ได้', tgt.doc_no, v_open using errcode = 'ACC15';
    end if;
    -- บริการ: ภาษียังไม่ถึงกำหนดของส่วนที่ตัด แบ่งเป็นส่วนที่รับเงิน (ถึงกำหนด → 2210) กับส่วนลด (ไม่มีการรับเงิน → ล้างออก)
    v_tr := 0; v_dvat := 0;
    if tgt.is_service and v_undue > 0 then
      v_tr := case when v_settle = v_open then v_undue else round(v_settle * v_undue / v_open, 2) end;
      v_dvat := round(v_disc * v_undue / v_open, 2);
      v_svc := true;
    end if;
    v_total := v_total + v_amt; v_vat := v_vat + v_tr - v_dvat;
    v_gross := v_gross + v_settle; v_tdisc := v_tdisc + v_disc; v_tdvat := v_tdvat + v_dvat;
    v_allocs := v_allocs || jsonb_build_object('target', tgt.id, 'doc_no', tgt.doc_no, 'amount', v_settle, 'vat', v_tr,
                                               'discount', v_disc, 'discount_vat', v_dvat);
  end loop;

  v_wht := coalesce(nullif(p->>'wht_amount', '')::numeric, 0);
  if v_wht < 0 or v_wht <> round(v_wht, 2) or v_wht >= v_total then
    raise exception 'ภาษีที่ลูกค้าหัก ณ ที่จ่ายต้องไม่ติดลบและน้อยกว่ายอดรับชำระ' using errcode = 'ACC05';
  end if;
  -- รับชำระค่าบริการ = ใบเสร็จรับเงิน/ใบกำกับภาษี
  v_tax := co.vat_registered and v_svc;
  if v_tax and co.tax_id is null then
    raise exception 'กรอกเลขประจำตัวผู้เสียภาษีของบริษัทก่อนออกใบกำกับภาษี (ข้อมูลบริษัทและภาษี)' using errcode = 'ACC14';
  end if;

  v_je := jsonb_build_array(jsonb_build_object('account_code', v_cash.code, 'debit', (v_total - v_wht)::text, 'memo', pa.name));
  if v_wht > 0 then v_je := v_je || jsonb_build_object('account_code', '1420', 'debit', v_wht::text, 'memo', pa.name); end if;
  if v_tdisc - v_tdvat > 0 then v_je := v_je || jsonb_build_object('account_code', '4210', 'debit', (v_tdisc - v_tdvat)::text, 'memo', pa.name); end if;
  if v_vat + v_tdvat > 0 then v_je := v_je || jsonb_build_object('account_code', '2211', 'debit', (v_vat + v_tdvat)::text); end if;
  v_je := v_je || jsonb_build_object('account_code', '1210', 'credit', v_gross::text, 'memo', pa.name);
  if v_vat > 0 then v_je := v_je || jsonb_build_object('account_code', '2210', 'credit', v_vat::text); end if;

  v_eid := acc.post_journal(p_company, v_date, coalesce(nullif(btrim(p->>'description'), ''), 'รับชำระ ' || pa.name), v_je, p_idem, 'RE', null);
  select id into v_id from acc.documents where company_id = p_company and entry_id = v_eid;
  if found then return v_id; end if;

  insert into acc.documents (company_id, kind, doc_no, doc_date, party_id, party_code, party_name, party_tax_id, party_branch_no,
      party_address, seller_name, seller_tax_id, seller_branch_no, seller_address, is_service, is_tax_invoice, price_mode, vat_rate,
      gross, discount, base, vat, total, wht_amount, cash_account_id, description, entry_id, idem_key, created_by)
  select p_company, 'receipt', e.doc_no, v_date, pa.id, pa.code, pa.name, pa.tax_id, pa.branch_no, pa.address,
         co.name, co.tax_id, co.branch_no, co.address, v_svc, v_tax, case when v_vat > 0 then 'inclusive' else 'none' end, co.vat_rate,
         v_gross, v_tdisc, v_total - v_vat, v_vat, v_total, v_wht, v_cash.id, coalesce(btrim(p->>'description'), ''), v_eid, p_idem,
         app.current_user_id()
    from acc.journal_entries e where e.company_id = p_company and e.id = v_eid
  returning id into v_id;

  insert into acc.document_lines (company_id, document_id, line_no, description, qty, unit_price, amount, account_id)
  select p_company, v_id, a.ord::int, 'รับชำระ ' || (a.value->>'doc_no'), 1, (a.value->>'amount')::numeric, (a.value->>'amount')::numeric,
         (select id from acc.chart_of_accounts where company_id = p_company and code = '1210')
    from jsonb_array_elements(v_allocs) with ordinality a(value, ord);
  insert into acc.allocations (company_id, source_id, target_id, amount, vat_transfer, discount, discount_vat)
  select p_company, v_id, (a->>'target')::uuid, (a->>'amount')::numeric, (a->>'vat')::numeric, (a->>'discount')::numeric,
         (a->>'discount_vat')::numeric from jsonb_array_elements(v_allocs) a;
  return v_id;
end $function$;

CREATE OR REPLACE FUNCTION acc.post_payment(p_company uuid, p jsonb, p_idem text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'acc', 'pg_temp'
AS $function$
declare
  co      acc.companies;
  pa      acc.parties;
  tgt     acc.purchase_documents;
  v_cash  acc.chart_of_accounts;
  v_id    uuid;
  v_date  date;
  v_amt   numeric;
  v_open  numeric; v_undue numeric; v_tr numeric; v_wb numeric;
  v_disc  numeric; v_dvat numeric; v_settle numeric; v_tdisc numeric := 0; v_tdvat numeric := 0; v_gross numeric := 0;
  v_total numeric := 0; v_vat numeric := 0;
  v_wkind text; v_wrate numeric; v_wbase numeric := 0; v_wht numeric := 0;
  v_svc   boolean := false;
  v_allocs jsonb := '[]';
  v_je    jsonb;
  v_eid   uuid;
  r record;
begin
  if not app.can_write_company(p_company) then
    raise exception 'ไม่มีสิทธิ์บันทึกเอกสารในบริษัทนี้' using errcode = '42501';
  end if;
  select id into v_id from acc.purchase_documents where company_id = p_company and idem_key = p_idem;
  if found then return v_id; end if;
  perform acc.ensure_purchase_accounts(p_company);
  insert into acc.chart_of_accounts (company_id, code, name, type)
  select p_company, t.code, t.name, t.type from acc.coa_template t where t.code = '5120' on conflict (company_id, code) do nothing;
  select * into co from acc.companies where id = p_company;
  v_date := nullif(p->>'date', '')::date;
  if v_date is null then raise exception 'ต้องมีวันที่เอกสาร' using errcode = '22023'; end if;
  select * into pa from acc.parties where company_id = p_company and code = upper(p->>'party_code');
  if not found or not pa.is_vendor then
    raise exception 'ไม่พบผู้ขายรหัส %', coalesce(p->>'party_code', '(ว่าง)') using errcode = 'ACC04';
  end if;
  select * into v_cash from acc.chart_of_accounts
   where company_id = p_company and code = coalesce(nullif(p->>'cash_account', ''), '1110') and active and ((type = 'asset' and code like '11%') or code = nullif(current_setting('acc.cheque_account', true), ''));
  if not found then raise exception 'บัญชีจ่ายเงินต้องเป็นบัญชีเงินสด/เงินฝาก (11xx)' using errcode = 'ACC04'; end if;
  if jsonb_typeof(p->'allocations') is distinct from 'array' or jsonb_array_length(p->'allocations') not between 1 and 50 then
    raise exception 'ต้องเลือกใบที่จ่ายชำระ 1–50 ใบ' using errcode = '22023';
  end if;

  -- ล็อกใบที่ตัดตามลำดับ id กันจ่ายเกินยอดค้างเมื่อกดพร้อมกัน (และกัน deadlock)
  for r in select (a->>'document_id')::uuid as did, a->>'amount' as amt, a->>'discount' as disc, count(*) over (partition by a->>'document_id') as dup
             from jsonb_array_elements(p->'allocations') a order by 1 loop
    if r.dup > 1 then raise exception 'เลือกใบเดียวกันซ้ำ' using errcode = '22023'; end if;
    select * into tgt from acc.purchase_documents where company_id = p_company and id = r.did for update;
    if not found or tgt.kind not in ('purchase_invoice', 'purchase_debit_note') or tgt.voided_at is not null or tgt.party_id <> pa.id then
      raise exception 'จ่ายชำระได้เฉพาะใบซื้อเชื่อ/ใบเพิ่มหนี้ของผู้ขายรายนี้ที่ยังไม่ยกเลิก' using errcode = 'ACC15';
    end if;
    if tgt.doc_date > v_date then
      raise exception 'วันที่จ่ายชำระต้องไม่ก่อนวันที่ของ %', tgt.doc_no using errcode = '22023';
    end if;
    begin v_amt := r.amt::numeric; exception when others then v_amt := null; end;
    if v_amt is null or v_amt <= 0 or v_amt <> round(v_amt, 2) then
      raise exception '%: จำนวนเงินต้องมากกว่า 0 ทศนิยมไม่เกิน 2 ตำแหน่ง', tgt.doc_no using errcode = 'ACC05';
    end if;
    -- ส่วนลดเงินสดที่ได้รับ (ไม่บังคับ): ตัดยอดค้างพร้อมเงินที่จ่าย
    begin v_disc := coalesce(nullif(r.disc, '')::numeric, 0); exception when others then v_disc := null; end;
    if v_disc is null or v_disc < 0 or v_disc <> round(v_disc, 2) then
      raise exception '%: ส่วนลดเงินสดต้องไม่ติดลบ ทศนิยมไม่เกิน 2 ตำแหน่ง', tgt.doc_no using errcode = 'ACC05';
    end if;
    v_settle := v_amt + v_disc;
    select tgt.total - s.amount, tgt.vat - s.vat into v_open, v_undue from acc.purchase_settled(p_company, tgt.id) s;
    if v_settle > v_open then
      raise exception '% ค้างอยู่ % จ่ายเกินยอดค้างไม่ได้', tgt.doc_no, v_open using errcode = 'ACC15';
    end if;
    -- บริการ: ภาษีซื้อยังไม่ถึงกำหนดของส่วนที่ตัด แบ่งเป็นส่วนที่จ่ายเงิน (ถึงกำหนด → 1410) กับส่วนลด (ไม่มีการจ่าย → ล้างออก)
    v_tr := 0; v_dvat := 0;
    if tgt.is_service and tgt.vat_claimable and v_undue > 0 then
      v_tr := case when v_settle = v_open then v_undue else round(v_settle * v_undue / v_open, 2) end;
      v_dvat := round(v_disc * v_undue / v_open, 2);
      v_svc := true;
    end if;
    v_wb := round(v_amt * tgt.base / tgt.total, 2); -- ส่วนของมูลค่าก่อนภาษีในยอดที่จ่าย (ไม่รวมส่วนลด)
    v_total := v_total + v_amt; v_vat := v_vat + v_tr - v_dvat; v_wbase := v_wbase + v_wb;
    v_gross := v_gross + v_settle; v_tdisc := v_tdisc + v_disc; v_tdvat := v_tdvat + v_dvat;
    v_allocs := v_allocs || jsonb_build_object('target', tgt.id, 'doc_no', tgt.doc_no, 'amount', v_settle, 'vat', v_tr, 'wb', v_wb,
                                               'discount', v_disc, 'discount_vat', v_dvat);
  end loop;

  select w.kind, w.rate into v_wkind, v_wrate from acc.wht_rate_from(p) w;
  if v_wkind is not null then
    if pa.tax_id is null then
      raise exception 'ผู้ขายต้องมีเลขประจำตัวผู้เสียภาษีจึงหักภาษี ณ ที่จ่ายและออก 50 ทวิ ได้ (แก้ที่ ลูกค้า / ผู้ขาย)' using errcode = 'ACC14';
    end if;
    v_wht := round(v_wbase * v_wrate / 100, 2);
    if v_wht <= 0 or v_wht >= v_total then
      raise exception 'ภาษีหัก ณ ที่จ่ายคิดได้ % ต้องมากกว่า 0 และน้อยกว่ายอดจ่าย', v_wht using errcode = 'ACC05';
    end if;
  else
    v_wbase := 0;
  end if;

  v_je := jsonb_build_array(jsonb_build_object('account_code', '2110', 'debit', v_gross::text, 'memo', pa.name));
  if v_vat > 0 then v_je := v_je || jsonb_build_object('account_code', '1410', 'debit', v_vat::text); end if;
  v_je := v_je || jsonb_build_object('account_code', v_cash.code, 'credit', (v_total - v_wht)::text, 'memo', pa.name);
  if v_wht > 0 then v_je := v_je || jsonb_build_object('account_code', '2230', 'credit', v_wht::text, 'memo', pa.name); end if;
  if v_vat + v_tdvat > 0 then v_je := v_je || jsonb_build_object('account_code', '1411', 'credit', (v_vat + v_tdvat)::text); end if;
  if v_tdisc - v_tdvat > 0 then v_je := v_je || jsonb_build_object('account_code', '5120', 'credit', (v_tdisc - v_tdvat)::text, 'memo', pa.name); end if;
  v_eid := acc.post_journal(p_company, v_date, coalesce(nullif(btrim(p->>'description'), ''), 'จ่ายชำระ ' || pa.name), v_je, p_idem, 'PV', null);
  select id into v_id from acc.purchase_documents where company_id = p_company and entry_id = v_eid;
  if found then return v_id; end if;

  insert into acc.purchase_documents (company_id, kind, doc_no, doc_date, party_id, party_code, party_name, party_tax_id,
      party_branch_no, party_address, is_service, vat_claimable, price_mode, vat_rate, gross, discount, base, vat, total,
      wht_kind, wht_rate, wht_base, wht_amount, cash_account_id, description, entry_id, idem_key, created_by)
  select p_company, 'payment', e.doc_no, v_date, pa.id, pa.code, pa.name, pa.tax_id, pa.branch_no, pa.address,
         v_svc, v_vat > 0, case when v_vat > 0 then 'inclusive' else 'none' end, co.vat_rate,
         v_gross, v_tdisc, v_total - v_vat, v_vat, v_total, v_wkind, v_wrate, v_wbase, v_wht, v_cash.id,
         coalesce(btrim(p->>'description'), ''), v_eid, p_idem, app.current_user_id()
    from acc.journal_entries e where e.company_id = p_company and e.id = v_eid
  returning id into v_id;
  insert into acc.purchase_document_lines (company_id, document_id, line_no, description, qty, unit_price, amount, account_id)
  select p_company, v_id, a.ord::int, 'จ่ายชำระ ' || (a.value->>'doc_no'), 1, (a.value->>'amount')::numeric, (a.value->>'amount')::numeric,
         (select id from acc.chart_of_accounts where company_id = p_company and code = '2110')
    from jsonb_array_elements(v_allocs) with ordinality a(value, ord);
  insert into acc.purchase_allocations (company_id, source_id, target_id, amount, vat_transfer, wht_base, discount, discount_vat)
  select p_company, v_id, (a->>'target')::uuid, (a->>'amount')::numeric, (a->>'vat')::numeric,
         case when v_wht > 0 then (a->>'wb')::numeric else 0 end, (a->>'discount')::numeric, (a->>'discount_vat')::numeric
    from jsonb_array_elements(v_allocs) a;
  if v_wht > 0 then perform acc.issue_wht_certificate(p_company, v_id); end if;
  return v_id;
end $function$;

CREATE OR REPLACE FUNCTION acc.vat_report(p_company uuid, p_month date, p_side text)
 RETURNS TABLE(row_date date, document_id uuid, doc_no text, ref_no text, kind text, party_name text, party_tax_id text, party_branch_no text, base numeric, vat numeric, status text)
 LANGUAGE sql
 STABLE
 SET search_path TO 'acc', 'pg_temp'
AS $function$
  with ev as (
    select d.id, d.doc_date, d.doc_no, null::text as ref_no, d.kind, d.party_name, d.party_tax_id, d.party_branch_no,
           case when d.kind in ('credit_note', 'deposit_applied') then -1 else 1 end as sign,
           case when d.kind = 'receipt' then (select coalesce(sum(a.amount - a.discount - (a.vat_transfer - a.discount_vat)), 0) from acc.allocations a
                                               join acc.documents t on t.company_id = a.company_id and t.id = a.target_id
                                              where a.company_id = d.company_id and a.source_id = d.id and t.is_service)
                else d.base end as base,
           d.vat, d.void_entry_id
      from acc.documents d
     where p_side = 'sales' and d.company_id = p_company and d.is_tax_invoice
       and (d.kind <> 'receipt' or d.vat > 0)
    union all
    select d.id, d.doc_date, d.doc_no,
           case when d.kind = 'payment' then (select string_agg(t.vendor_doc_no, ', ' order by t.doc_no) from acc.purchase_allocations a
                                               join acc.purchase_documents t on t.company_id = a.company_id and t.id = a.target_id
                                              where a.company_id = d.company_id and a.source_id = d.id and t.is_service and t.vat_claimable)
                when d.kind = 'deposit_applied' then (select t.vendor_doc_no from acc.purchase_documents t
                                                       where t.company_id = d.company_id and t.id = d.ref_document_id)
                else d.vendor_doc_no end,
           d.kind, d.party_name, d.party_tax_id, d.party_branch_no,
           case when d.kind in ('purchase_credit_note', 'deposit_applied') then -1 else 1 end,
           case when d.kind = 'payment' then (select coalesce(sum(a.amount - a.discount - (a.vat_transfer - a.discount_vat)), 0) from acc.purchase_allocations a
                                               join acc.purchase_documents t on t.company_id = a.company_id and t.id = a.target_id
                                              where a.company_id = d.company_id and a.source_id = d.id and t.is_service and t.vat_claimable)
                else d.base end,
           d.vat, d.void_entry_id
      from acc.purchase_documents d
     where p_side = 'purchases' and d.company_id = p_company and d.vat_claimable and d.vat > 0
       and (d.kind in ('cash_purchase', 'payment', 'deposit') or not d.is_service)
  ), x as (
    select ev.*, ve.entry_date as void_date
      from ev left join acc.journal_entries ve on ve.company_id = p_company and ve.id = ev.void_entry_id
  )
  select doc_date, id, doc_no, ref_no, kind, party_name, party_tax_id, party_branch_no,
         case when void_date is not null and date_trunc('month', void_date) = date_trunc('month', doc_date) then 0 else sign * base end,
         case when void_date is not null and date_trunc('month', void_date) = date_trunc('month', doc_date) then 0 else sign * vat end,
         case when void_date is not null and date_trunc('month', void_date) = date_trunc('month', doc_date) then 'voided' else 'normal' end
    from x where date_trunc('month', doc_date) = date_trunc('month', p_month)
  union all
  select void_date, id, doc_no, ref_no, kind, party_name, party_tax_id, party_branch_no, -sign * base, -sign * vat, 'void_reversal'
    from x where void_date is not null and date_trunc('month', void_date) = date_trunc('month', p_month)
     and date_trunc('month', void_date) <> date_trunc('month', doc_date)
  order by 1, 3
$function$;

-- migrate:down
CREATE OR REPLACE FUNCTION acc.post_receipt(p_company uuid, p jsonb, p_idem text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'acc', 'pg_temp'
AS $function$
declare
  co      acc.companies;
  pa      acc.parties;
  tgt     acc.documents;
  v_cash  acc.chart_of_accounts;
  v_id    uuid;
  v_date  date;
  v_amt   numeric;
  v_open  numeric; v_undue numeric; v_tr numeric;
  v_total numeric := 0; v_vat numeric := 0; v_wht numeric;
  v_svc   boolean := false;
  v_tax   boolean;
  v_allocs jsonb := '[]';
  v_je    jsonb;
  v_eid   uuid;
  r record;
begin
  if not app.can_write_company(p_company) then
    raise exception 'ไม่มีสิทธิ์ออกเอกสารในบริษัทนี้' using errcode = '42501';
  end if;
  select id into v_id from acc.documents where company_id = p_company and idem_key = p_idem;
  if found then return v_id; end if;
  perform acc.ensure_tax_accounts(p_company);
  select * into co from acc.companies where id = p_company;
  v_date := nullif(p->>'date', '')::date;
  if v_date is null then raise exception 'ต้องมีวันที่เอกสาร' using errcode = '22023'; end if;
  select * into pa from acc.parties where company_id = p_company and code = upper(p->>'party_code');
  if not found or not pa.is_customer then
    raise exception 'ไม่พบลูกค้ารหัส %', coalesce(p->>'party_code', '(ว่าง)') using errcode = 'ACC04';
  end if;
  select * into v_cash from acc.chart_of_accounts
   where company_id = p_company and code = coalesce(nullif(p->>'cash_account', ''), '1110') and active and ((type = 'asset' and code like '11%') or code = nullif(current_setting('acc.cheque_account', true), ''));
  if not found then raise exception 'บัญชีรับเงินต้องเป็นบัญชีเงินสด/เงินฝาก (11xx)' using errcode = 'ACC04'; end if;
  if jsonb_typeof(p->'allocations') is distinct from 'array' or jsonb_array_length(p->'allocations') not between 1 and 50 then
    raise exception 'ต้องเลือกใบที่รับชำระ 1–50 ใบ' using errcode = '22023';
  end if;

  -- ล็อกใบที่ถูกตัดตามลำดับ id (กันตัดเกินเมื่อรับพร้อมกัน และกัน deadlock)
  for r in select (a->>'document_id')::uuid as did, a->>'amount' as amt, count(*) over (partition by a->>'document_id') as dup
             from jsonb_array_elements(p->'allocations') a order by 1 loop
    if r.dup > 1 then raise exception 'เลือกใบเดียวกันซ้ำ' using errcode = '22023'; end if;
    select * into tgt from acc.documents where company_id = p_company and id = r.did for update;
    if not found or tgt.kind not in ('sales_invoice', 'debit_note') or tgt.voided_at is not null or tgt.party_id <> pa.id then
      raise exception 'รับชำระได้เฉพาะใบขายเชื่อ/ใบเพิ่มหนี้ของลูกค้ารายนี้ที่ยังไม่ยกเลิก' using errcode = 'ACC15';
    end if;
    if tgt.doc_date > v_date then
      raise exception 'วันที่รับชำระต้องไม่ก่อนวันที่ของ %', tgt.doc_no using errcode = '22023';
    end if;
    begin v_amt := r.amt::numeric; exception when others then v_amt := null; end;
    if v_amt is null or v_amt <= 0 or v_amt <> round(v_amt, 2) then
      raise exception '%: จำนวนเงินต้องมากกว่า 0 ทศนิยมไม่เกิน 2 ตำแหน่ง', tgt.doc_no using errcode = 'ACC05';
    end if;
    select tgt.total - s.amount, tgt.vat - s.vat into v_open, v_undue from acc.document_settled(p_company, tgt.id) s;
    if v_amt > v_open then
      raise exception '% ค้างอยู่ % รับเกินยอดค้างไม่ได้', tgt.doc_no, v_open using errcode = 'ACC15';
    end if;
    v_tr := 0;
    if tgt.is_service and v_undue > 0 then
      v_tr := case when v_amt = v_open then v_undue else round(v_amt * v_undue / v_open, 2) end;
      v_svc := true;
    end if;
    v_total := v_total + v_amt; v_vat := v_vat + v_tr;
    v_allocs := v_allocs || jsonb_build_object('target', tgt.id, 'doc_no', tgt.doc_no, 'amount', v_amt, 'vat', v_tr);
  end loop;

  v_wht := coalesce(nullif(p->>'wht_amount', '')::numeric, 0);
  if v_wht < 0 or v_wht <> round(v_wht, 2) or v_wht >= v_total then
    raise exception 'ภาษีที่ลูกค้าหัก ณ ที่จ่ายต้องไม่ติดลบและน้อยกว่ายอดรับชำระ' using errcode = 'ACC05';
  end if;
  -- รับชำระค่าบริการ = ใบเสร็จรับเงิน/ใบกำกับภาษี
  v_tax := co.vat_registered and v_svc;
  if v_tax and co.tax_id is null then
    raise exception 'กรอกเลขประจำตัวผู้เสียภาษีของบริษัทก่อนออกใบกำกับภาษี (ข้อมูลบริษัทและภาษี)' using errcode = 'ACC14';
  end if;

  v_je := jsonb_build_array(jsonb_build_object('account_code', v_cash.code, 'debit', (v_total - v_wht)::text, 'memo', pa.name));
  if v_wht > 0 then v_je := v_je || jsonb_build_object('account_code', '1420', 'debit', v_wht::text, 'memo', pa.name); end if;
  if v_vat > 0 then v_je := v_je || jsonb_build_object('account_code', '2211', 'debit', v_vat::text); end if;
  v_je := v_je || jsonb_build_object('account_code', '1210', 'credit', v_total::text, 'memo', pa.name);
  if v_vat > 0 then v_je := v_je || jsonb_build_object('account_code', '2210', 'credit', v_vat::text); end if;

  v_eid := acc.post_journal(p_company, v_date, coalesce(nullif(btrim(p->>'description'), ''), 'รับชำระ ' || pa.name), v_je, p_idem, 'RE', null);
  select id into v_id from acc.documents where company_id = p_company and entry_id = v_eid;
  if found then return v_id; end if;

  insert into acc.documents (company_id, kind, doc_no, doc_date, party_id, party_code, party_name, party_tax_id, party_branch_no,
      party_address, seller_name, seller_tax_id, seller_branch_no, seller_address, is_service, is_tax_invoice, price_mode, vat_rate,
      gross, discount, base, vat, total, wht_amount, cash_account_id, description, entry_id, idem_key, created_by)
  select p_company, 'receipt', e.doc_no, v_date, pa.id, pa.code, pa.name, pa.tax_id, pa.branch_no, pa.address,
         co.name, co.tax_id, co.branch_no, co.address, v_svc, v_tax, case when v_vat > 0 then 'inclusive' else 'none' end, co.vat_rate,
         v_total, 0, v_total - v_vat, v_vat, v_total, v_wht, v_cash.id, coalesce(btrim(p->>'description'), ''), v_eid, p_idem,
         app.current_user_id()
    from acc.journal_entries e where e.company_id = p_company and e.id = v_eid
  returning id into v_id;

  insert into acc.document_lines (company_id, document_id, line_no, description, qty, unit_price, amount, account_id)
  select p_company, v_id, a.ord::int, 'รับชำระ ' || (a.value->>'doc_no'), 1, (a.value->>'amount')::numeric, (a.value->>'amount')::numeric,
         (select id from acc.chart_of_accounts where company_id = p_company and code = '1210')
    from jsonb_array_elements(v_allocs) with ordinality a(value, ord);
  insert into acc.allocations (company_id, source_id, target_id, amount, vat_transfer)
  select p_company, v_id, (a->>'target')::uuid, (a->>'amount')::numeric, (a->>'vat')::numeric from jsonb_array_elements(v_allocs) a;
  return v_id;
end $function$;

CREATE OR REPLACE FUNCTION acc.post_payment(p_company uuid, p jsonb, p_idem text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'acc', 'pg_temp'
AS $function$
declare
  co      acc.companies;
  pa      acc.parties;
  tgt     acc.purchase_documents;
  v_cash  acc.chart_of_accounts;
  v_id    uuid;
  v_date  date;
  v_amt   numeric;
  v_open  numeric; v_undue numeric; v_tr numeric; v_wb numeric;
  v_total numeric := 0; v_vat numeric := 0;
  v_wkind text; v_wrate numeric; v_wbase numeric := 0; v_wht numeric := 0;
  v_svc   boolean := false;
  v_allocs jsonb := '[]';
  v_je    jsonb;
  v_eid   uuid;
  r record;
begin
  if not app.can_write_company(p_company) then
    raise exception 'ไม่มีสิทธิ์บันทึกเอกสารในบริษัทนี้' using errcode = '42501';
  end if;
  select id into v_id from acc.purchase_documents where company_id = p_company and idem_key = p_idem;
  if found then return v_id; end if;
  perform acc.ensure_purchase_accounts(p_company);
  select * into co from acc.companies where id = p_company;
  v_date := nullif(p->>'date', '')::date;
  if v_date is null then raise exception 'ต้องมีวันที่เอกสาร' using errcode = '22023'; end if;
  select * into pa from acc.parties where company_id = p_company and code = upper(p->>'party_code');
  if not found or not pa.is_vendor then
    raise exception 'ไม่พบผู้ขายรหัส %', coalesce(p->>'party_code', '(ว่าง)') using errcode = 'ACC04';
  end if;
  select * into v_cash from acc.chart_of_accounts
   where company_id = p_company and code = coalesce(nullif(p->>'cash_account', ''), '1110') and active and ((type = 'asset' and code like '11%') or code = nullif(current_setting('acc.cheque_account', true), ''));
  if not found then raise exception 'บัญชีจ่ายเงินต้องเป็นบัญชีเงินสด/เงินฝาก (11xx)' using errcode = 'ACC04'; end if;
  if jsonb_typeof(p->'allocations') is distinct from 'array' or jsonb_array_length(p->'allocations') not between 1 and 50 then
    raise exception 'ต้องเลือกใบที่จ่ายชำระ 1–50 ใบ' using errcode = '22023';
  end if;

  -- ล็อกใบที่ตัดตามลำดับ id กันจ่ายเกินยอดค้างเมื่อกดพร้อมกัน (และกัน deadlock)
  for r in select (a->>'document_id')::uuid as did, a->>'amount' as amt, count(*) over (partition by a->>'document_id') as dup
             from jsonb_array_elements(p->'allocations') a order by 1 loop
    if r.dup > 1 then raise exception 'เลือกใบเดียวกันซ้ำ' using errcode = '22023'; end if;
    select * into tgt from acc.purchase_documents where company_id = p_company and id = r.did for update;
    if not found or tgt.kind not in ('purchase_invoice', 'purchase_debit_note') or tgt.voided_at is not null or tgt.party_id <> pa.id then
      raise exception 'จ่ายชำระได้เฉพาะใบซื้อเชื่อ/ใบเพิ่มหนี้ของผู้ขายรายนี้ที่ยังไม่ยกเลิก' using errcode = 'ACC15';
    end if;
    if tgt.doc_date > v_date then
      raise exception 'วันที่จ่ายชำระต้องไม่ก่อนวันที่ของ %', tgt.doc_no using errcode = '22023';
    end if;
    begin v_amt := r.amt::numeric; exception when others then v_amt := null; end;
    if v_amt is null or v_amt <= 0 or v_amt <> round(v_amt, 2) then
      raise exception '%: จำนวนเงินต้องมากกว่า 0 ทศนิยมไม่เกิน 2 ตำแหน่ง', tgt.doc_no using errcode = 'ACC05';
    end if;
    select tgt.total - s.amount, tgt.vat - s.vat into v_open, v_undue from acc.purchase_settled(p_company, tgt.id) s;
    if v_amt > v_open then
      raise exception '% ค้างอยู่ % จ่ายเกินยอดค้างไม่ได้', tgt.doc_no, v_open using errcode = 'ACC15';
    end if;
    v_tr := 0;
    if tgt.is_service and tgt.vat_claimable and v_undue > 0 then
      v_tr := case when v_amt = v_open then v_undue else round(v_amt * v_undue / v_open, 2) end;
      v_svc := true;
    end if;
    v_wb := round(v_amt * tgt.base / tgt.total, 2); -- ส่วนของมูลค่าก่อนภาษีในยอดที่จ่าย
    v_total := v_total + v_amt; v_vat := v_vat + v_tr; v_wbase := v_wbase + v_wb;
    v_allocs := v_allocs || jsonb_build_object('target', tgt.id, 'doc_no', tgt.doc_no, 'amount', v_amt, 'vat', v_tr, 'wb', v_wb);
  end loop;

  select w.kind, w.rate into v_wkind, v_wrate from acc.wht_rate_from(p) w;
  if v_wkind is not null then
    if pa.tax_id is null then
      raise exception 'ผู้ขายต้องมีเลขประจำตัวผู้เสียภาษีจึงหักภาษี ณ ที่จ่ายและออก 50 ทวิ ได้ (แก้ที่ ลูกค้า / ผู้ขาย)' using errcode = 'ACC14';
    end if;
    v_wht := round(v_wbase * v_wrate / 100, 2);
    if v_wht <= 0 or v_wht >= v_total then
      raise exception 'ภาษีหัก ณ ที่จ่ายคิดได้ % ต้องมากกว่า 0 และน้อยกว่ายอดจ่าย', v_wht using errcode = 'ACC05';
    end if;
  else
    v_wbase := 0;
  end if;

  v_je := jsonb_build_array(jsonb_build_object('account_code', '2110', 'debit', v_total::text, 'memo', pa.name));
  if v_vat > 0 then v_je := v_je || jsonb_build_object('account_code', '1410', 'debit', v_vat::text); end if;
  v_je := v_je || jsonb_build_object('account_code', v_cash.code, 'credit', (v_total - v_wht)::text, 'memo', pa.name);
  if v_wht > 0 then v_je := v_je || jsonb_build_object('account_code', '2230', 'credit', v_wht::text, 'memo', pa.name); end if;
  if v_vat > 0 then v_je := v_je || jsonb_build_object('account_code', '1411', 'credit', v_vat::text); end if;
  v_eid := acc.post_journal(p_company, v_date, coalesce(nullif(btrim(p->>'description'), ''), 'จ่ายชำระ ' || pa.name), v_je, p_idem, 'PV', null);
  select id into v_id from acc.purchase_documents where company_id = p_company and entry_id = v_eid;
  if found then return v_id; end if;

  insert into acc.purchase_documents (company_id, kind, doc_no, doc_date, party_id, party_code, party_name, party_tax_id,
      party_branch_no, party_address, is_service, vat_claimable, price_mode, vat_rate, gross, discount, base, vat, total,
      wht_kind, wht_rate, wht_base, wht_amount, cash_account_id, description, entry_id, idem_key, created_by)
  select p_company, 'payment', e.doc_no, v_date, pa.id, pa.code, pa.name, pa.tax_id, pa.branch_no, pa.address,
         v_svc, v_vat > 0, case when v_vat > 0 then 'inclusive' else 'none' end, co.vat_rate,
         v_total, 0, v_total - v_vat, v_vat, v_total, v_wkind, v_wrate, v_wbase, v_wht, v_cash.id,
         coalesce(btrim(p->>'description'), ''), v_eid, p_idem, app.current_user_id()
    from acc.journal_entries e where e.company_id = p_company and e.id = v_eid
  returning id into v_id;
  insert into acc.purchase_document_lines (company_id, document_id, line_no, description, qty, unit_price, amount, account_id)
  select p_company, v_id, a.ord::int, 'จ่ายชำระ ' || (a.value->>'doc_no'), 1, (a.value->>'amount')::numeric, (a.value->>'amount')::numeric,
         (select id from acc.chart_of_accounts where company_id = p_company and code = '2110')
    from jsonb_array_elements(v_allocs) with ordinality a(value, ord);
  insert into acc.purchase_allocations (company_id, source_id, target_id, amount, vat_transfer, wht_base)
  select p_company, v_id, (a->>'target')::uuid, (a->>'amount')::numeric, (a->>'vat')::numeric,
         case when v_wht > 0 then (a->>'wb')::numeric else 0 end
    from jsonb_array_elements(v_allocs) a;
  if v_wht > 0 then perform acc.issue_wht_certificate(p_company, v_id); end if;
  return v_id;
end $function$;

CREATE OR REPLACE FUNCTION acc.vat_report(p_company uuid, p_month date, p_side text)
 RETURNS TABLE(row_date date, document_id uuid, doc_no text, ref_no text, kind text, party_name text, party_tax_id text, party_branch_no text, base numeric, vat numeric, status text)
 LANGUAGE sql
 STABLE
 SET search_path TO 'acc', 'pg_temp'
AS $function$
  with ev as (
    select d.id, d.doc_date, d.doc_no, null::text as ref_no, d.kind, d.party_name, d.party_tax_id, d.party_branch_no,
           case when d.kind in ('credit_note', 'deposit_applied') then -1 else 1 end as sign,
           case when d.kind = 'receipt' then (select coalesce(sum(a.amount - a.vat_transfer), 0) from acc.allocations a
                                               join acc.documents t on t.company_id = a.company_id and t.id = a.target_id
                                              where a.company_id = d.company_id and a.source_id = d.id and t.is_service)
                else d.base end as base,
           d.vat, d.void_entry_id
      from acc.documents d
     where p_side = 'sales' and d.company_id = p_company and d.is_tax_invoice
       and (d.kind <> 'receipt' or d.vat > 0)
    union all
    select d.id, d.doc_date, d.doc_no,
           case when d.kind = 'payment' then (select string_agg(t.vendor_doc_no, ', ' order by t.doc_no) from acc.purchase_allocations a
                                               join acc.purchase_documents t on t.company_id = a.company_id and t.id = a.target_id
                                              where a.company_id = d.company_id and a.source_id = d.id and t.is_service and t.vat_claimable)
                when d.kind = 'deposit_applied' then (select t.vendor_doc_no from acc.purchase_documents t
                                                       where t.company_id = d.company_id and t.id = d.ref_document_id)
                else d.vendor_doc_no end,
           d.kind, d.party_name, d.party_tax_id, d.party_branch_no,
           case when d.kind in ('purchase_credit_note', 'deposit_applied') then -1 else 1 end,
           case when d.kind = 'payment' then (select coalesce(sum(a.amount - a.vat_transfer), 0) from acc.purchase_allocations a
                                               join acc.purchase_documents t on t.company_id = a.company_id and t.id = a.target_id
                                              where a.company_id = d.company_id and a.source_id = d.id and t.is_service and t.vat_claimable)
                else d.base end,
           d.vat, d.void_entry_id
      from acc.purchase_documents d
     where p_side = 'purchases' and d.company_id = p_company and d.vat_claimable and d.vat > 0
       and (d.kind in ('cash_purchase', 'payment', 'deposit') or not d.is_service)
  ), x as (
    select ev.*, ve.entry_date as void_date
      from ev left join acc.journal_entries ve on ve.company_id = p_company and ve.id = ev.void_entry_id
  )
  select doc_date, id, doc_no, ref_no, kind, party_name, party_tax_id, party_branch_no,
         case when void_date is not null and date_trunc('month', void_date) = date_trunc('month', doc_date) then 0 else sign * base end,
         case when void_date is not null and date_trunc('month', void_date) = date_trunc('month', doc_date) then 0 else sign * vat end,
         case when void_date is not null and date_trunc('month', void_date) = date_trunc('month', doc_date) then 'voided' else 'normal' end
    from x where date_trunc('month', doc_date) = date_trunc('month', p_month)
  union all
  select void_date, id, doc_no, ref_no, kind, party_name, party_tax_id, party_branch_no, -sign * base, -sign * vat, 'void_reversal'
    from x where void_date is not null and date_trunc('month', void_date) = date_trunc('month', p_month)
     and date_trunc('month', void_date) <> date_trunc('month', doc_date)
  order by 1, 3
$function$;

alter table acc.purchase_allocations drop constraint purchase_allocations_discount_le, drop column discount_vat, drop column discount;
alter table acc.allocations drop constraint allocations_discount_le, drop column discount_vat, drop column discount;
