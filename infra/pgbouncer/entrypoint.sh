#!/bin/sh
# เขียน userlist จาก APP_DB_PASSWORD (อยู่ในหน่วยความจำของ container เท่านั้น) แล้วเปิด PgBouncer
set -eu
: "${APP_DB_PASSWORD:?ต้องตั้ง APP_DB_PASSWORD}"
umask 077
printf '"app_web" "%s"\n' "$APP_DB_PASSWORD" > /tmp/userlist.txt
exec pgbouncer /etc/pgbouncer/pgbouncer.ini
