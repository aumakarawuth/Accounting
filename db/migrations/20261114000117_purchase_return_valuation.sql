-- migrate:up
-- ส่งคืนผู้ขาย (ใบลดหนี้ซื้อ) กับมูลค่าคงเหลือ — พบจากการทดสอบสุ่มข้ามโมดูล
-- 1) ส่งคืนจนจำนวนเหลือ 0: เดิมตัดด้วยมูลค่าตามใบลดหนี้ มูลค่าที่เหลือค้างใน 1310 ทั้งที่ไม่มีของ
--    (ถัวเฉลี่ย: ซื้อ 5@200, 5@50 ขาย 5 เหลือ 625 ส่งคืนใบหลัง 5 ชิ้น 250 → 0 ชิ้น ค้าง 375)
--    → ตัดมูลค่าที่เหลือทั้งหมดเหมือนขาย/ตัดสต็อกจนหมด ส่วนต่างอยู่ใน 5140 (กลุ่มต้นทุนขาย)
-- 2) ลงย้อนวันที่ (เช่น ขายก่อนวันส่งคืน) ทำให้มูลค่า ณ วันส่งคืนน้อยกว่ามูลค่าใบลดหนี้: เดิมคำนวณใหม่ได้มูลค่าติดลบ
--    (1310 ติดลบ ของที่เหลือขายไม่ได้ หรือ error 500 จาก check constraint) → ปฏิเสธพร้อมเหตุผล (ACC15)
--    FIFO: ส่วนต่างที่ปรับเข้าชั้นเก่าสุดแล้วติดลบ ยกไปหักชั้นถัดไปจนหมด ติดลบทั้งหมดจึงปฏิเสธ
-- คำนวณใหม่ใช้มูลค่าตามใบลดหนี้เสมอ (ไม่ใช้ค่าที่เคยคำนวณ) เพราะใบที่เคยเป็นใบสุดท้ายอาจไม่ใช่แล้ว
create or replace function pg_temp.patch_function(p_fn regprocedure, p_pairs text[]) returns void language plpgsql as $$
declare v_src text := pg_get_functiondef(p_fn); i int;
begin
  for i in 1 .. array_length(p_pairs, 1) / 2 loop
    if (length(v_src) - length(replace(v_src, p_pairs[2 * i - 1], ''))) / length(p_pairs[2 * i - 1]) <> 1 then
      raise exception 'patch %: ไม่พบข้อความที่ % ครั้งเดียว', p_fn, i;
    end if;
    v_src := replace(v_src, p_pairs[2 * i - 1], p_pairs[2 * i]);
  end loop;
  execute v_src;
end $$;

-- มูลค่าตามใบลดหนี้ของบรรทัดที่สร้างความเคลื่อนไหวนี้ (idem_key = inventory-purchase-return:<ใบ>:<บรรทัด>)
create function acc.purchase_return_cost(p_company uuid, p_document uuid, p_idem text) returns numeric
language sql stable security definer set search_path = acc, pg_temp as $$
  select pc.cost from acc.purchase_line_costs(p_company, p_document) pc where pc.line_no = split_part(p_idem, ':', 3)::int
$$;
revoke all on function acc.purchase_return_cost(uuid, uuid, text) from public;

select pg_temp.patch_function('acc.fifo_walk(uuid, uuid, date, numeric)', array[
  'h int := 1; q numeric := 0; pend numeric := 0;',
  'h int := 1; k int; q numeric := 0; pend numeric := 0;',
  'if q > 0 then lv[h] := lv[h] + got + nv; else pend := pend + got + nv; end if;',
  E'if m.source_kind = ''purchase_return'' then\n'
  || E'          nv := -acc.purchase_return_cost(p_company, m.source_id, m.idem_key);\n'
  || E'          if q = 0 then nv := -(got + pend); end if;\n'
  || E'          nu := round(nv / m.quantity, 6);\n'
  || E'        end if;\n'
  || E'        if q > 0 then\n'
  || E'          lv[h] := lv[h] + got + nv; k := h;\n'
  || E'          while lv[k] < 0 and k < array_length(lq, 1) loop lv[k + 1] := lv[k + 1] + lv[k]; lv[k] := 0; k := k + 1; end loop;\n'
  || E'          if lv[k] < 0 then\n'
  || E'            raise exception ''ส่งคืนสินค้า % ตาม % มูลค่า % เกินมูลค่าคงเหลือ ณ วันที่ % ตรวจรายการที่ลงย้อนวันที่ก่อนวันส่งคืน'',\n'
  || E'              it.name, m.reference, -nv, acc.thai_date(m.movement_date) using errcode = ''ACC15'';\n'
  || E'          end if;\n'
  || E'        else pend := pend + got + nv; end if;']);

select pg_temp.patch_function('acc.restate_inventory_item(uuid, uuid, text)', array[
  E'elsif m.source_kind = ''sales_return'' then',
  E'elsif m.source_kind = ''purchase_return'' then\n'
  || E'      nv := -acc.purchase_return_cost(p_company, m.source_id, m.idem_key);\n'
  || E'      if q + m.quantity = 0 then nv := -v; end if;\n'
  || E'      if v + nv < 0 then\n'
  || E'        raise exception ''ส่งคืนสินค้า % ตาม % มูลค่า % เกินมูลค่าคงเหลือ ณ วันที่ % (%) ตรวจรายการที่ลงย้อนวันที่ก่อนวันส่งคืน'',\n'
  || E'          it.name, m.reference, -nv, acc.thai_date(m.movement_date), v using errcode = ''ACC15'';\n'
  || E'      end if;\n'
  || E'      nu := round(nv / m.quantity, 6);\n'
  || E'    elsif m.source_kind = ''sales_return'' then']);

-- ลงครั้งแรก: ส่งคืนจนหมด = มูลค่าที่เหลือทั้งหมด (ทั้งรายการบัญชีและบัตรสต็อกใช้ค่าเดียวกัน)
select pg_temp.patch_function('acc.post_purchase_return_inventory()', array[
  E'  eid uuid;\n',
  E'  eid uuid;\n  ov jsonb := ''{}'';\n',
  'if b.value < r.cost then',
  E'if b.quantity = r.qty and b.value > 0 then\n'
  || E'      r.cost := b.value; ov := ov || jsonb_build_object(r.line_no::text, b.value);\n'
  || E'    end if;\n'
  || E'    if b.value < r.cost then',
  'round(pc.cost / l.qty, 6), -pc.cost, eid,',
  'round(coalesce((ov->>l.line_no::text)::numeric, pc.cost) / l.qty, 6), -coalesce((ov->>l.line_no::text)::numeric, pc.cost), eid,']);

-- migrate:down
create or replace function pg_temp.patch_function(p_fn regprocedure, p_pairs text[]) returns void language plpgsql as $$
declare v_src text := pg_get_functiondef(p_fn); i int;
begin
  for i in 1 .. array_length(p_pairs, 1) / 2 loop
    if (length(v_src) - length(replace(v_src, p_pairs[2 * i - 1], ''))) / length(p_pairs[2 * i - 1]) <> 1 then
      raise exception 'patch %: ไม่พบข้อความที่ % ครั้งเดียว', p_fn, i;
    end if;
    v_src := replace(v_src, p_pairs[2 * i - 1], p_pairs[2 * i]);
  end loop;
  execute v_src;
end $$;

select pg_temp.patch_function('acc.post_purchase_return_inventory()', array[
  'round(coalesce((ov->>l.line_no::text)::numeric, pc.cost) / l.qty, 6), -coalesce((ov->>l.line_no::text)::numeric, pc.cost), eid,',
  'round(pc.cost / l.qty, 6), -pc.cost, eid,',
  E'if b.quantity = r.qty and b.value > 0 then\n'
  || E'      r.cost := b.value; ov := ov || jsonb_build_object(r.line_no::text, b.value);\n'
  || E'    end if;\n'
  || E'    if b.value < r.cost then',
  'if b.value < r.cost then',
  E'  eid uuid;\n  ov jsonb := ''{}'';\n',
  E'  eid uuid;\n']);

select pg_temp.patch_function('acc.restate_inventory_item(uuid, uuid, text)', array[
  E'elsif m.source_kind = ''purchase_return'' then\n'
  || E'      nv := -acc.purchase_return_cost(p_company, m.source_id, m.idem_key);\n'
  || E'      if q + m.quantity = 0 then nv := -v; end if;\n'
  || E'      if v + nv < 0 then\n'
  || E'        raise exception ''ส่งคืนสินค้า % ตาม % มูลค่า % เกินมูลค่าคงเหลือ ณ วันที่ % (%) ตรวจรายการที่ลงย้อนวันที่ก่อนวันส่งคืน'',\n'
  || E'          it.name, m.reference, -nv, acc.thai_date(m.movement_date), v using errcode = ''ACC15'';\n'
  || E'      end if;\n'
  || E'      nu := round(nv / m.quantity, 6);\n'
  || E'    elsif m.source_kind = ''sales_return'' then',
  E'elsif m.source_kind = ''sales_return'' then']);

select pg_temp.patch_function('acc.fifo_walk(uuid, uuid, date, numeric)', array[
  E'if m.source_kind = ''purchase_return'' then\n'
  || E'          nv := -acc.purchase_return_cost(p_company, m.source_id, m.idem_key);\n'
  || E'          if q = 0 then nv := -(got + pend); end if;\n'
  || E'          nu := round(nv / m.quantity, 6);\n'
  || E'        end if;\n'
  || E'        if q > 0 then\n'
  || E'          lv[h] := lv[h] + got + nv; k := h;\n'
  || E'          while lv[k] < 0 and k < array_length(lq, 1) loop lv[k + 1] := lv[k + 1] + lv[k]; lv[k] := 0; k := k + 1; end loop;\n'
  || E'          if lv[k] < 0 then\n'
  || E'            raise exception ''ส่งคืนสินค้า % ตาม % มูลค่า % เกินมูลค่าคงเหลือ ณ วันที่ % ตรวจรายการที่ลงย้อนวันที่ก่อนวันส่งคืน'',\n'
  || E'              it.name, m.reference, -nv, acc.thai_date(m.movement_date) using errcode = ''ACC15'';\n'
  || E'          end if;\n'
  || E'        else pend := pend + got + nv; end if;',
  'if q > 0 then lv[h] := lv[h] + got + nv; else pend := pend + got + nv; end if;',
  'h int := 1; k int; q numeric := 0; pend numeric := 0;',
  'h int := 1; q numeric := 0; pend numeric := 0;']);

drop function acc.purchase_return_cost(uuid, uuid, text);
