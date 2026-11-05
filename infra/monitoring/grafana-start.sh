#!/bin/sh
# Grafana ใช้ admin/admin ถ้าไม่ตั้งรหัส: ไม่ยอมเริ่มจนกว่าจะตั้ง GRAFANA_ADMIN_PASSWORD (≥ 12 ตัว) ใน infra/.env
if [ "${#GF_SECURITY_ADMIN_PASSWORD}" -lt 12 ]; then
  echo "ต้องตั้ง GRAFANA_ADMIN_PASSWORD ยาวอย่างน้อย 12 ตัวใน infra/.env" >&2
  exit 1
fi
exec /run.sh "$@"
