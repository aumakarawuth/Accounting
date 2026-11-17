-- migrate:up
-- เก็บสถิติคอลัมน์ company_id แค่ค่าที่พบบ่อยที่สุดค่าเดียว (statistics 1) ทุกตารางใน acc
-- เหตุ: บริษัทมีไม่กี่ร้อยบริษัท ANALYZE เก็บทุกบริษัทเป็นค่าที่พบบ่อย (MCV) บริษัทที่สร้างหลัง ANALYZE ครั้งล่าสุด
-- (นักเรียนเปิดบริษัทใหม่ = กรณีปกติ) จึงถูกคาดว่ามี 1 แถว planner เลือก nested loop ซ้อนสามชั้นโดยไม่ใช้ index
-- บริษัทที่มี ~200 รายการ งบการเงิน/งบทดลองค้างหลายนาที · MCV ค่าเดียว = บริษัทอื่นคาดเท่าค่าเฉลี่ยต่อบริษัท แผนใช้ index
-- (ไม่ใช้ statistics 0: ANALYZE ข้ามคอลัมน์แต่สถิติเก่ายังค้าง ฐานที่มีข้อมูลแล้วจะคาดผิดตลอดไป)
do $$
declare t text;
begin
  for t in select c.relname from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'acc' and a.attname = 'company_id' and c.relkind in ('r', 'p') and not a.attisdropped
  loop
    execute format('alter table acc.%I alter column company_id set statistics 1', t);
    execute format('analyze acc.%I', t);
  end loop;
end $$;

-- migrate:down
do $$
declare t text;
begin
  for t in select c.relname from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'acc' and a.attname = 'company_id' and c.relkind in ('r', 'p') and not a.attisdropped
  loop
    execute format('alter table acc.%I alter column company_id set statistics -1', t);
    execute format('analyze acc.%I', t);
  end loop;
end $$;
