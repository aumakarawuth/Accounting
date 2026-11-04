#!/bin/sh
# service backup: รัน backup.sh ทุกวันเวลา BACKUP_AT (เวลาไทย HH:MM) ล้มเหลวแล้วลองใหม่ใน 1 ชั่วโมง
set -u
at="${BACKUP_AT:-02:30}"
until pg_isready -q -h /var/run/postgresql; do sleep 2; done
# ยังไม่เคยมี base backup: ทำทันที (WAL archive ใช้ได้ก็ต่อเมื่อมี base backup ตั้งต้น)
ls /backups/base/*.tar.gz >/dev/null 2>&1 || /infra/backup.sh || echo "backup ครั้งแรกล้มเหลว" >&2
while :; do
  now=$(date +%s)
  next=$(TZ=ICT-7 date -d "today $at" +%s)
  [ "$next" -le "$now" ] && next=$(TZ=ICT-7 date -d "tomorrow $at" +%s)
  sleep $((next - now))
  /infra/backup.sh || { echo "backup ล้มเหลว ลองใหม่ใน 1 ชั่วโมง" >&2; sleep 3600; /infra/backup.sh || echo "backup ล้มเหลวซ้ำ" >&2; }
done
