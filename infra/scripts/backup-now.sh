#!/bin/sh
# backup ทันที (นอกเหนือจากรอบประจำวัน) เช่น ก่อน deploy ที่มี migration
set -eu
cd "$(dirname "$0")/.."
docker compose exec -T backup /infra/backup.sh
