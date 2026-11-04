#!/bin/sh
# ซ้อมกู้คืน (รันใน service drill ด้วย infra/scripts/restore-drill.sh) ไม่เขียนอะไรลงฐานจริงและไดรฟ์ backups
#   กู้ base backup → เล่น WAL จาก archive จนถึงล่าสุด (หรือ RESTORE_TARGET_TIME) → ตรวจข้อมูลเทียบฐานจริง → ลบทิ้ง
# ออก 0 = ผ่าน
set -eu
export PGUSER=postgres
db="${POSTGRES_DB:-accounting}"
target="${RESTORE_TARGET_TIME:-}"
data=/drill/data
live="-h /var/run/postgresql"     # ฐานจริง (ซ็อกเก็ตที่ใช้ร่วมกัน)
tmp="-h /drill/run -p 5433"       # ฐานที่กู้ (ซ็อกเก็ตของตัวเอง ไม่เปิดพอร์ต)
started=$(date +%s)
fail() { echo "ไม่ผ่าน: $*" >&2; exit 1; }

# ตาราง/จำนวนที่ใช้เทียบ (ถ้าฐานจริงเพิ่มข้อมูลระหว่างซ้อม ฐานที่กู้ต้องไม่น้อยกว่าค่าที่จดตอนเริ่ม)
snapshot() {
  psql $1 -d "$db" -XAtq -v ON_ERROR_STOP=1 <<'SQL'
select 'schema_migrations', count(*) from schema_migrations
union all select 'schools', count(*) from acc.schools
union all select 'users', count(*) from acc.users
union all select 'classrooms', count(*) from acc.classrooms
union all select 'companies', count(*) from acc.companies
union all select 'journal_entries', count(*) from acc.journal_entries
union all select 'journal_lines', count(*) from acc.journal_lines
union all select 'documents', count(*) from acc.documents
union all select 'audit_log', count(*) from acc.audit_log
union all select 'functions', count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('acc','app')
union all select 'policies', count(*) from pg_policies where schemaname in ('acc','app')
order by 1;
SQL
}

[ -d /backups/base ] || fail "ไม่มี /backups/base"
# ล้างของรอบก่อน (ไดรฟ์ drill ใช้ซ้ำ)
rm -rf "$data" /drill/run /drill/bad /drill/live.txt /drill/restored.txt /drill/postgres.log
# ชุดที่ใช้: ล่าสุด หรือชุดล่าสุดที่เริ่มก่อนเวลาเป้าหมาย (ชื่อไฟล์เป็นเวลา UTC)
if [ -n "$target" ]; then
  cut=$(date -u -d "$target" +%Y%m%dT%H%M%SZ) || fail "อ่านเวลา $target ไม่ได้"
  base=$(ls -1 /backups/base/*.tar.gz 2>/dev/null | sort | awk -v c="$cut" '{n=$0; sub(/.*\//,"",n); if (n < c) f=$0} END{print f}')
else
  base=$(ls -1 /backups/base/*.tar.gz 2>/dev/null | sort | tail -n 1)
fi
[ -n "$base" ] || fail "ไม่มี base backup ที่ใช้ได้"
sysid=$(cat "${base%.tar.gz}.sysid" 2>/dev/null) || fail "ไม่มีไฟล์ .sysid ของ $(basename "$base")"
wals="/backups/wal/$sysid"
live_sysid=$(psql $live -d "$db" -XAtq -c 'select system_identifier from pg_control_system()' 2>/dev/null || true)
echo "ซ้อมกู้คืนจาก $(basename "$base")${target:+ ถึงเวลา $target}"

# เทียบกับฐานจริงได้เฉพาะเมื่อ backup เป็นของฐานเดียวกันและกู้ถึงล่าสุด
if [ -z "$target" ] && [ "$sysid" = "$live_sysid" ]; then
  # ดัน WAL ปัจจุบันเข้า archive แล้วรอจนเก็บเสร็จ จึงจดค่าของฐานจริง
  wal=$(psql $live -XAtq -c "select pg_walfile_name(pg_current_wal_lsn())")
  psql $live -XAtq -c "select pg_switch_wal()" >/dev/null
  for _ in $(seq 1 60); do [ -f "$wals/$wal" ] && break; sleep 1; done
  [ -f "$wals/$wal" ] || fail "WAL $wal ไม่เข้า archive ใน 60 วินาที (ดู log ของ db)"
  snapshot "$live" > /drill/live.txt
fi

mkdir -p "$data" /drill/run
tar -xzf "$base" -C "$data"
rm -f "$data/postmaster.pid" "$data/postmaster.opts"
touch "$data/recovery.signal"
cat >> "$data/postgresql.auto.conf" <<CONF
# --- ซ้อมกู้คืน ---
restore_command = 'cp $wals/%f %p'
recovery_target_action = 'promote'
${target:+recovery_target_time = '$target'}
CONF
chown -R postgres:postgres /drill
chmod 700 "$data"

# archive_mode=off: ฐานที่กู้ต้องไม่ส่ง WAL ทับ archive ของฐานจริง
gosu postgres pg_ctl -D "$data" -w -t 600 -l /drill/postgres.log \
  -o "-c config_file=/etc/postgresql/postgresql.conf -c archive_mode=off -c listen_addresses='' -c unix_socket_directories=/drill/run -p 5433 -c shared_buffers=128MB" start \
  || { tail -n 30 /drill/postgres.log; fail "เปิดฐานที่กู้ไม่ขึ้น"; }
for _ in $(seq 1 600); do
  [ "$(psql $tmp -d "$db" -XAtq -c 'select pg_is_in_recovery()')" = f ] && break; sleep 1
done
[ "$(psql $tmp -d "$db" -XAtq -c 'select pg_is_in_recovery()')" = f ] || { tail -n 30 /drill/postgres.log; fail "กู้ไม่จบใน 10 นาที"; }
grep -E "redo done|recovery stopping|archive recovery complete|consistent recovery state" /drill/postgres.log | sed 's/^/  log: /' || true

snapshot "$tmp" > /drill/restored.txt
echo "ข้อมูลในฐานที่กู้:"; sed 's/^/  /; s/|/ = /' /drill/restored.txt

ok=1
if [ -f /drill/live.txt ]; then
  # เทียบรายบรรทัด: ฐานที่กู้ต้องมีไม่น้อยกว่าฐานจริง ณ ตอนเริ่ม
  join -t'|' /drill/live.txt /drill/restored.txt | while IFS='|' read -r k a b; do
    [ "$b" -ge "$a" ] || { echo "  $k: ฐานจริง $a แต่กู้ได้ $b" >&2; echo bad >> /drill/bad; }
  done
  [ -f /drill/bad ] && ok=0
fi
unbalanced=$(psql $tmp -d "$db" -XAtq -c "select count(*) from (select entry_id from acc.journal_lines group by entry_id having sum(debit) <> sum(credit)) x")
[ "$unbalanced" = 0 ] || { echo "  รายการบัญชีเดบิตไม่เท่าเครดิต $unbalanced รายการ" >&2; ok=0; }
latest=$(psql $tmp -d "$db" -XAtq -c "select coalesce(max(posted_at)::text, '-') from acc.journal_entries")
echo "  รายการบัญชีล่าสุดในฐานที่กู้: $latest"

gosu postgres pg_ctl -D "$data" -m fast stop >/dev/null
rm -rf "$data"
secs=$(( $(date +%s) - started ))
[ "$ok" = 1 ] || fail "ข้อมูลที่กู้ไม่ครบ/ไม่ถูกต้อง"
echo "ผ่าน: กู้คืนและตรวจเสร็จใน ${secs} วินาที"
