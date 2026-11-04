#!/bin/sh
# ซ้อมกู้คืนบน server (docs/self-host.md ข้อ "ซ้อมกู้คืน") ทำอย่างน้อยเดือนละครั้ง และทุกครั้งหลังเปลี่ยนวิธี backup
#   infra/scripts/restore-drill.sh                                   กู้ถึงล่าสุด แล้วเทียบกับฐานจริง
#   infra/scripts/restore-drill.sh --time '2026-11-04 10:30:00+07'   กู้ย้อนถึงเวลานั้น (point-in-time)
# ไม่แตะฐานจริง: กู้ลงฐานชั่วคราวในไดรฟ์ drill อ่าน backups แบบอ่านอย่างเดียว
set -eu
cd "$(dirname "$0")/.."
target=""
if [ "${1:-}" = "--time" ]; then target="${2:?ต้องระบุเวลา เช่น '2026-11-04 10:30:00+07'}"; fi
RESTORE_TARGET_TIME="$target" docker compose --profile drill run --rm drill
