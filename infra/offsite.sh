#!/bin/sh
# service offsite: rclone sync ไดรฟ์ backups ขึ้น object storage ทุก OFFSITE_EVERY_MINUTES นาที
# remote ตั้งด้วยตัวแปร RCLONE_CONFIG_OFFSITE_* (แนะนำ type=crypt ซ้อนบน S3/R2/B2 ให้เข้ารหัสก่อนออกจากเครื่อง: docs/self-host.md)
# sync = ลบไฟล์ที่เครื่องลบแล้ว (ตาม BACKUP_KEEP) ถ้าต้องการเก็บนานกว่า ให้ตั้ง lifecycle/versioning ที่ bucket
set -u
dest="${OFFSITE_PATH:-offsite:accounting-backups}"
every="${OFFSITE_EVERY_MINUTES:-15}"
while :; do
  # ไฟล์ที่ขึ้นต้นด้วยจุด = กำลังเขียน (ข้าม)
  if rclone sync /backups "$dest" --exclude '.*' --exclude '.*/**' --fast-list --transfers 4 --stats-one-line -v; then
    date -u +%Y-%m-%dT%H:%M:%SZ > /tmp/last-offsite
  else
    echo "offsite sync ล้มเหลว จะลองใหม่รอบหน้า" >&2
  fi
  sleep $((every * 60))
done
