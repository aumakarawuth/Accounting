#!/bin/sh
# backup 1 รอบ (service backup เรียกทุกวัน หรือสั่งเอง: docker compose exec backup /infra/backup.sh)
#  1) base backup แบบ plain → ตรวจด้วย pg_verifybackup → บีบอัดเป็น base/<เวลา>.tar.gz (+ .start = WAL แรกที่ต้องใช้)
#  2) pg_dump ทั้งฐาน (ย้ายข้ามเวอร์ชัน/กู้รายตารางได้)  3) เก็บ BACKUP_KEEP ชุดล่าสุด ลบ WAL ที่ไม่มีชุดไหนต้องใช้แล้ว
# ต่อฐานผ่านซ็อกเก็ต (ไดรฟ์ pgrun ใช้ร่วมกับ db) ไม่ต้องมีรหัสผ่าน
set -eu
export PGHOST=/var/run/postgresql PGUSER=postgres
db="${POSTGRES_DB:-accounting}"
keep="${BACKUP_KEEP:-7}"
ts=$(date -u +%Y%m%dT%H%M%SZ)
cd /backups
mkdir -p base dump wal
work="base/.work-$ts"
trap 'rm -rf "$work"' EXIT

echo "backup $ts: base backup"
sysid=$(psql -d "$db" -XAtq -c 'select system_identifier from pg_control_system()')
pg_basebackup -D "$work" -Fp -X stream --checkpoint=fast --manifest-checksums=SHA256 --label "backup-$ts"
pg_verifybackup -q "$work"
# WAL แรกที่ชุดนี้ต้องใช้ (ใช้ลบ WAL เก่าตอนชุดนี้กลายเป็นชุดเก่าสุด)
sed -n 's/^START WAL LOCATION: .* (file \([0-9A-F]*\))$/\1/p' "$work/backup_label" > "base/.$ts.start.tmp"
test -s "base/.$ts.start.tmp"
tar -czf "base/.$ts.tar.gz.tmp" -C "$work" .
mv "base/.$ts.tar.gz.tmp" "base/$ts.tar.gz"
echo "$sysid" > "base/$ts.sysid"
mv "base/.$ts.start.tmp" "base/$ts.start"

echo "backup $ts: pg_dump"
pg_dump -d "$db" -Fc -f "dump/.$ts.dump.tmp"
mv "dump/.$ts.dump.tmp" "dump/$ts.dump"

# เก็บ $keep ชุดล่าสุด
ls -1 base/*.tar.gz | sort | head -n "-$keep" | while read -r f; do rm -f "$f" "${f%.tar.gz}.start" "${f%.tar.gz}.sysid"; done
ls -1 dump/*.dump | sort | head -n "-$keep" | xargs -r rm -f
# WAL ของแต่ละฐาน (system identifier) เก็บตั้งแต่ base backup เก่าสุดของฐานนั้น · ฐานที่ไม่มี base backup เหลือแล้ว = ลบทั้งโฟลเดอร์
for d in wal/*/; do
  [ -d "$d" ] || continue
  id=$(basename "$d")
  oldest=$(grep -lx "$id" base/*.sysid 2>/dev/null | sort | head -n 1)
  if [ -z "$oldest" ]; then
    [ "$id" = "$sysid" ] || { echo "ลบ WAL ของฐานเดิม $id (ไม่มี base backup แล้ว)"; rm -rf "wal/$id"; }
  else
    pg_archivecleanup "wal/$id" "$(cat "${oldest%.sysid}.start")"
  fi
done

date -u +%Y-%m-%dT%H:%M:%SZ > last-success
# ตัวชี้วัดให้ node-exporter (textfile collector) → Prometheus เตือนเมื่อ backup เก่ากว่า 26 ชม.
mkdir -p metrics
{
  echo "# HELP backup_last_success_timestamp_seconds เวลาที่ base backup + pg_dump สำเร็จล่าสุด"
  echo "# TYPE backup_last_success_timestamp_seconds gauge"
  echo "backup_last_success_timestamp_seconds $(date +%s)"
  echo "# HELP backup_base_bytes ขนาด base backup ล่าสุด"
  echo "# TYPE backup_base_bytes gauge"
  echo "backup_base_bytes $(stat -c %s "base/$ts.tar.gz")"
  echo "# HELP backup_base_count จำนวน base backup ที่เก็บอยู่"
  echo "# TYPE backup_base_count gauge"
  echo "backup_base_count $(ls -1 base/*.tar.gz | wc -l)"
} > metrics/.backup.prom.tmp && mv metrics/.backup.prom.tmp metrics/backup.prom
echo "backup $ts: เสร็จ ($(du -sh "base/$ts.tar.gz" | cut -f1) base, $(du -sh "dump/$ts.dump" | cut -f1) dump, WAL $(find wal -type f | wc -l) ไฟล์)"
