-- migrate:up
-- ล็อก search_path ให้ทุกฟังก์ชันใน acc/app ที่ยังไม่ได้ตั้ง (Supabase lint 0011) กันการแทรก object ชื่อซ้ำผ่าน search_path
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname in ('acc', 'app') and p.prokind in ('f', 'p')
       and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')
  loop
    execute format('alter function %s set search_path = acc, app, public, pg_temp', f.sig);
  end loop;
end $$;

-- migrate:down
-- ไม่ย้อน: search_path ที่ล็อกไว้เข้ากันได้กับโค้ดเดิม
