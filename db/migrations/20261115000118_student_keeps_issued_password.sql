-- migrate:up
-- นักเรียนใช้รหัสบนใบที่ครูพิมพ์แจกได้เลย ไม่บังคับตั้งรหัสใหม่ตอนเข้าครั้งแรก (เจ้าของโปรเจกต์เลือก 15 พ.ย. 2569)
-- เหตุ: บังคับตั้งใหม่ทำให้นักเรียนรีบตั้งแล้วลืม · ยังเปลี่ยนเองได้ที่หน้าเปลี่ยนรหัสผ่าน · ครู/ผู้ดูแลยังต้องเปลี่ยนรหัสชั่วคราวเหมือนเดิม
-- ข้อแลกเปลี่ยน: คนที่เห็นใบรหัสของนักเรียนเข้าแทนได้ (docs/assumptions.md ข้อ 51)
-- ทำเป็น trigger เดียวครอบทุกทางที่ตั้งรหัส (นำเข้า CSV, ครูรีเซ็ต, ผู้ดูแลรีเซ็ต) ไม่ต้องแก้ทีละฟังก์ชัน
create function acc.student_keeps_issued_password() returns trigger
language plpgsql security definer set search_path = acc, pg_temp as $$
begin
  if new.must_change and exists (select 1 from acc.users u where u.id = new.user_id and u.role = 'student') then
    new.must_change := false;
  end if;
  return new;
end $$;
revoke all on function acc.student_keeps_issued_password() from public;
create trigger credentials_student_no_forced_change before insert or update of must_change on acc.credentials
  for each row execute function acc.student_keeps_issued_password();
update acc.credentials c set must_change = false
  from acc.users u where u.id = c.user_id and u.role = 'student' and c.must_change;

-- migrate:down
drop trigger credentials_student_no_forced_change on acc.credentials;
drop function acc.student_keeps_issued_password();
