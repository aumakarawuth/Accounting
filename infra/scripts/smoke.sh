#!/bin/sh
# ทดสอบชุด self-host ทั้งระบบบนเครื่องเดียว (CI job infra และบนเครื่องนักพัฒนา) ใช้ https://localhost
#   1) build + up  2) หน้าเว็บ/API ผ่าน Caddy + header ความปลอดภัย  3) ล็อกอินจริง สร้างข้อมูล ส่งออก PDF ดูสด SSE
#   4) backup → เขียนข้อมูลเพิ่ม → ซ้อมกู้คืนต้องเห็นข้อมูลหลัง backup (พิสูจน์ว่าเล่น WAL)  5) security-check
# ใช้ .env ชั่วคราวที่สุ่มรหัสเอง ถ้ามี infra/.env อยู่แล้วจะไม่แตะ (ใช้ของเดิม)
#   SKIP_BUILD=1  ใช้ image ที่ build ไว้แล้ว · KEEP=1 ไม่ down หลังจบ
set -eu
cd "$(dirname "$0")/.."
root=$(cd .. && pwd)
base=https://localhost
work=$(mktemp -d)
created_env=0
if [ ! -f .env ]; then
  printf 'SITE_ADDRESS=localhost\nPOSTGRES_PASSWORD=%s\nAPP_DB_PASSWORD=%s\n' "$(openssl rand -hex 24)" "$(openssl rand -hex 32)" > .env
  created_env=1
fi
cleanup() {
  code=$?
  if [ "$code" != 0 ]; then docker compose ps -a; docker compose logs --tail 60 migrate api web caddy db backup || true; fi
  if [ "${KEEP:-0}" != 1 ]; then
    docker compose --profile drill down -v --remove-orphans >/dev/null 2>&1 || true
    [ "$created_env" = 1 ] && rm -f .env
  fi
  rm -rf "$work"
  exit "$code"
}
trap cleanup EXIT
step() { printf '\n== %s\n' "$*"; }
fail() { echo "ไม่ผ่าน: $*" >&2; exit 1; }
# curl ผ่าน Caddy (ใบรับรองจาก CA ภายในของ Caddy: เชื่อเฉพาะ CA นั้น ไม่ใช้ -k)
c() { curl -sS --cacert "$work/ca.crt" -b "$work/jar" -c "$work/jar" "$@"; }
psql_db() { docker compose exec -T db psql -U postgres -d accounting -XAtq -v ON_ERROR_STOP=1 "$@"; }

step "build + up"
if [ "${SKIP_BUILD:-0}" = 1 ]; then docker compose up -d --no-build --wait; else docker compose up -d --build --wait; fi
docker compose ps
docker compose logs migrate | tail -n 3

step "HTTPS ผ่าน Caddy"
for _ in $(seq 1 30); do docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt "$work/ca.crt" >/dev/null 2>&1 && break; sleep 1; done
[ -s "$work/ca.crt" ] || fail "ไม่มีใบรับรอง CA ของ Caddy"
for _ in $(seq 1 30); do c -o /dev/null "$base/login" 2>/dev/null && break; sleep 1; done
c -D "$work/h" -o "$work/login.html" "$base/login"
grep -qi '^strict-transport-security:' "$work/h" || fail "ไม่มี HSTS"
grep -qi "^content-security-policy:.*frame-ancestors 'none'" "$work/h" || fail "ไม่มี CSP"
grep -qi '^server:' "$work/h" && fail "ยังส่ง header Server"
[ "$(curl -s -o /dev/null -w '%{http_code}' http://localhost/login)" = 308 ] || fail "http ไม่ redirect ไป https"
[ "$(c "$base/api/health" | tr -d ' ')" != "" ] || fail "API /health ผ่าน Caddy ไม่ได้"
c -D "$work/ha" -o /dev/null "$base/api/auth/me"
grep -qi '^cache-control: no-store' "$work/ha" || fail "API ไม่ตอบ no-store"
echo "ผ่าน"

step "ฐานข้อมูล: แอปใช้ app_web ผ่าน PgBouncer, ห้ามสร้างตาราง, LISTEN ต่อตรง"
psql_db -c "select usename, count(*) from pg_stat_activity where usename = 'app_web' group by 1" | grep -q app_web || fail "API ไม่ได้ต่อด้วย app_web"
docker compose exec -T -e PGPASSWORD="$(sed -n 's/^APP_DB_PASSWORD=//p' .env)" db \
  psql -h pgbouncer -p 6432 -U app_web -d accounting -XAtq -c 'create table public.x (a int)' 2>&1 | grep -q 'permission denied' || fail "app_web สร้างตารางได้"
psql_db -c "select count(*) from pg_stat_activity where usename = 'app_web' and query ilike 'listen%'" | grep -qv '^0$' || fail "ไม่มี LISTEN ของ API"
echo "ผ่าน"

step "ผู้ดูแล + ครู + ห้อง + บริษัท + รายการบัญชี (ผ่าน API จริง)"
admin_pw=$(docker compose exec -T -e ADMIN_DATABASE_URL="postgres://postgres:$(sed -n 's/^POSTGRES_PASSWORD=//p' .env)@db:5432/accounting" api \
  node dist/cli/create-admin.js admin-smoke@example.test "ผู้ดูแลทดสอบ" "โรงเรียนทดสอบ" | sed -n 's/.*รหัสชั่วคราว \([^ ]*\) .*/\1/p')
[ -n "$admin_pw" ] || fail "สร้างผู้ดูแลไม่ได้"
node "$root/infra/scripts/smoke-flow.mjs" "$base" "$work/ca.crt" admin-smoke@example.test "$admin_pw" "$work/flow.json"

step "backup → เขียนเพิ่มหลัง backup → ซ้อมกู้คืน"
for _ in $(seq 1 60); do docker compose exec -T backup sh -c 'test -f /backups/last-success' && break; sleep 2; done
docker compose exec -T backup sh -c 'test -f /backups/last-success' || fail "backup ครั้งแรกไม่เสร็จ"
./scripts/backup-now.sh
# เวลาก่อนลงรายการหลัง backup (ใช้ทดสอบกู้ย้อนเวลา)
sleep 2; before=$(psql_db -c "select now()::text"); sleep 2
node "$root/infra/scripts/smoke-flow.mjs" "$base" "$work/ca.crt" --after-backup "$work/flow.json"
marker=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$work/flow.json','utf8')).afterBackupDocNo)")
./scripts/restore-drill.sh | tee "$work/drill.txt"
grep -q '^ผ่าน' "$work/drill.txt" || fail "ซ้อมกู้คืนไม่ผ่าน"
# รายการที่ลงหลัง backup ต้องอยู่ในฐานที่กู้ (มาจาก WAL ไม่ใช่ base backup)
after=$(psql_db -c "select count(*) from acc.journal_entries where doc_no = '$marker'")
[ "$after" = 1 ] || fail "ไม่พบรายการ $marker ในฐานจริง"
grep -q 'journal_entries = 3$' "$work/drill.txt" || fail "ฐานที่กู้ไม่มีรายการที่ลงหลัง backup"
echo "ผ่าน (รายการ $marker ลงหลัง backup กู้ได้จาก WAL)"

step "กู้ย้อนเวลา (ก่อนรายการ $marker)"
./scripts/restore-drill.sh --time "$before" | tee "$work/pitr.txt"
grep -q '^ผ่าน' "$work/pitr.txt" || fail "กู้ย้อนเวลาไม่ผ่าน"
grep -q 'journal_entries = 2$' "$work/pitr.txt" || fail "กู้ย้อนเวลาแล้วยังเห็นรายการหลังเวลาเป้าหมาย"
echo "ผ่าน"

step "security-check"
NODE_EXTRA_CA_CERTS="$work/ca.crt" node "$root/scripts/security-check.mjs" "$base" "$(node -e "console.log(JSON.parse(require('fs').readFileSync('$work/flow.json','utf8')).studentCode)")" \
  "$(node -e "console.log(JSON.parse(require('fs').readFileSync('$work/flow.json','utf8')).studentPassword)")"

printf '\nชุด self-host ผ่านทุกข้อ\n'
