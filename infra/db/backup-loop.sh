#!/bin/sh
# service backup: รัน backup.sh ทุกวันเวลา BACKUP_AT (เวลาไทย HH:MM) ล้มเหลวแล้วลองใหม่ใน 1 ชั่วโมง
set -u
at="${BACKUP_AT:-02:30}"
until pg_isready -q -h /var/run/postgresql; do sleep 2; done
# สถานะ WAL archive ทุกนาที → /backups/metrics/archiver.prom (archive ล้มต่อเนื่อง = ดิสก์ของ WAL โตจนเต็ม)
mkdir -p /backups/metrics
(
  while :; do
    psql -h /var/run/postgresql -U postgres -d "${POSTGRES_DB:-accounting}" -XAtq -F ' ' -c "
      select archived_count, failed_count,
             coalesce(extract(epoch from last_archived_time), 0)::bigint,
             coalesce(extract(epoch from last_failed_time), 0)::bigint
        from pg_stat_archiver" 2>/dev/null | {
      read -r ok failed last_ok last_fail || exit 0
      {
        echo "# TYPE pg_archiver_archived_total counter"; echo "pg_archiver_archived_total $ok"
        echo "# TYPE pg_archiver_failed_total counter"; echo "pg_archiver_failed_total $failed"
        echo "# TYPE pg_archiver_last_archived_timestamp_seconds gauge"; echo "pg_archiver_last_archived_timestamp_seconds $last_ok"
        echo "# TYPE pg_archiver_last_failed_timestamp_seconds gauge"; echo "pg_archiver_last_failed_timestamp_seconds $last_fail"
      } > /backups/metrics/.archiver.prom.tmp && mv /backups/metrics/.archiver.prom.tmp /backups/metrics/archiver.prom
    }
    sleep 60
  done
) &
# ยังไม่เคยมี base backup: ทำทันที (WAL archive ใช้ได้ก็ต่อเมื่อมี base backup ตั้งต้น)
ls /backups/base/*.tar.gz >/dev/null 2>&1 || /infra/backup.sh || echo "backup ครั้งแรกล้มเหลว" >&2
while :; do
  now=$(date +%s)
  next=$(TZ=ICT-7 date -d "today $at" +%s)
  [ "$next" -le "$now" ] && next=$(TZ=ICT-7 date -d "tomorrow $at" +%s)
  sleep $((next - now))
  /infra/backup.sh || { echo "backup ล้มเหลว ลองใหม่ใน 1 ชั่วโมง" >&2; sleep 3600; /infra/backup.sh || echo "backup ล้มเหลวซ้ำ" >&2; }
done
