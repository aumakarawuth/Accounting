#!/usr/bin/env bash
# สร้างฐาน accounting_load ใหม่ + ข้อมูลนักเรียน 500 คน แล้วเขียน tests/load/data/users.json
# ADMIN_URL=postgres://postgres@localhost/postgres?host=/tmp tests/load/setup.sh [จำนวนนักเรียน]
set -euo pipefail
cd "$(dirname "$0")/../.."
ADMIN_URL=${ADMIN_URL:-postgres://postgres@localhost/postgres?host=/tmp}
LOAD_URL=$(echo "$ADMIN_URL" | sed "s|/postgres?|/accounting_load?|; s|/postgres$|/accounting_load|")
psql "$ADMIN_URL" -qc "drop database if exists accounting_load with (force)" -c "create database accounting_load"
DATABASE_URL="$LOAD_URL" node scripts/migrate.mjs --seed
psql "$LOAD_URL" -qc "do \$\$ begin if not exists (select from pg_roles where rolname='app_load') then create role app_load login password 'app_load' in role app_rw; end if; end \$\$"
mkdir -p tests/load/data
ADMIN_DATABASE_URL="$LOAD_URL" pnpm --filter @accounting/api -s load-seed "${1:-500}" "$PWD/tests/load/data/users.json"
