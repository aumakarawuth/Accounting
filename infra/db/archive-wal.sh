#!/bin/sh
# archive_command: คัดลอก WAL 1 ไฟล์เข้า /backups/wal/<system identifier> อย่างปลอดภัย (ไม่ทับไฟล์เดิม เขียนลงดิสก์จริงก่อนตอบสำเร็จ)
# แยกโฟลเดอร์ตาม system identifier: สร้างฐานใหม่ (initdb) โดยใช้ไดรฟ์ backups เดิม ชื่อไฟล์ WAL จะซ้ำกับของฐานเก่า
# exit ≠ 0 = Postgres จะลองใหม่ และไม่ลบ WAL นั้นจนกว่าจะสำเร็จ
set -eu
src="$1"; name="$2"
sysid=$(pg_controldata "$PGDATA" | sed -n 's/^Database system identifier: *//p')
[ -n "$sysid" ] || { echo "archive: อ่าน system identifier ไม่ได้" >&2; exit 1; }
dir="/backups/wal/$sysid"
mkdir -p "$dir"
if [ -f "$dir/$name" ]; then
  # ส่งซ้ำหลังเครื่องดับ: ถือว่าสำเร็จถ้าเนื้อหาเหมือนเดิมเท่านั้น
  cmp -s "$src" "$dir/$name" && exit 0
  echo "archive: $name มีอยู่แล้วแต่เนื้อหาไม่ตรง" >&2; exit 1
fi
cp "$src" "$dir/.$name.tmp"
sync "$dir/.$name.tmp"
mv "$dir/.$name.tmp" "$dir/$name"
sync "$dir"
