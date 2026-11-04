# คู่มือ self-host (Docker Compose)

ชุดไฟล์อยู่ใน `infra/` (สเปกและเหตุผล: `docs/staging-spec.md`) ใช้ได้ทั้ง staging และ production
ทดสอบทั้งชุดบนเครื่องเดียวด้วย `infra/scripts/smoke.sh` (CI job `infra` รันทุก PR)

```
infra/
  docker-compose.yml      db · migrate · pgbouncer · api · web · caddy · backup (+ offsite, drill ตาม profile)
  Caddyfile               HTTPS อัตโนมัติ /api → API, ที่เหลือ → เว็บ
  .env.example            ค่าที่ต้องตั้ง (คัดลอกเป็น .env บน server เท่านั้น)
  bootstrap-db.mjs        migration + ผังบัญชีตั้งต้น + role app_web (รันทุกครั้งที่ up)
  db/                     image Postgres 16 + postgresql.conf + สคริปต์ backup/ซ้อมกู้คืน
  pgbouncer/              transaction pooling
  offsite.sh              rclone sync backup ขึ้น object storage
  scripts/                backup-now.sh · restore-drill.sh · smoke.sh
```

## 1. เตรียม server (ครั้งเดียว)

- Ubuntu 24.04 LTS (หรือ Debian 12) อย่างน้อย 2 vCPU / 4 GB RAM / SSD 40 GB สำหรับเริ่ม (ตัวเลขจริงต้องวัดด้วย k6: PLAN.md ข้อ 13.8)
- ติดตั้ง Docker Engine + compose plugin จาก repo ทางการของ Docker
- เปิดเฉพาะ 22 (SSH key เท่านั้น ปิดรหัสผ่าน) 80 และ 443 (TCP+UDP) · fail2ban สำหรับ SSH · อัปเดตความปลอดภัยอัตโนมัติ (`unattended-upgrades`)
- ชี้ DNS (A/AAAA) ของโดเมนมาที่ server ก่อน `up` ครั้งแรก (Caddy ขอใบรับรอง Let's Encrypt ทันที)
- เข้ารหัสดิสก์ตามที่ผู้ให้บริการมีให้ (PLAN.md ข้อ 7)

## 2. ติดตั้ง

```sh
git clone <repo> /srv/accounting && cd /srv/accounting/infra
cp .env.example .env && chmod 600 .env
# ใส่ SITE_ADDRESS=<โดเมน>, POSTGRES_PASSWORD และ APP_DB_PASSWORD (openssl rand -hex 32 คนละค่า)
docker compose up -d --build --wait
docker compose logs migrate          # "ฐานข้อมูลพร้อม: migration N ไฟล์ ..."
```

ผู้ดูแลคนแรกของโรงเรียน (ครั้งเดียว รหัสชั่วคราวแสดงครั้งเดียว ต้องเปลี่ยนเมื่อเข้าครั้งแรก):

```sh
docker compose exec api sh -c 'ADMIN_DATABASE_URL=postgres://postgres:$POSTGRES_PASSWORD@db:5432/accounting \
  node dist/cli/create-admin.js <ชื่อผู้ใช้> "<ชื่อ>" "<ชื่อโรงเรียน>"'
```

(`POSTGRES_PASSWORD` ไม่อยู่ใน container ของ api: ใส่ค่าเองในคำสั่ง หรือ `--env-file`/`-e POSTGRES_PASSWORD=...`
แล้วล้าง history ของ shell)

## 3. deploy รุ่นใหม่

```sh
cd /srv/accounting && git pull --ff-only
infra/scripts/backup-now.sh          # มี migration ใหม่: backup ก่อนเสมอ
cd infra && docker compose up -d --build --wait
```

- `migrate` รันก่อน api เสมอ ถ้า migration ล้ม api/เว็บรุ่นเดิมยังรันอยู่ (compose ไม่ถอด container เดิมจนกว่าตัวใหม่จะพร้อม
  แต่ระหว่าง recreate มีช่วงหยุดสั้น ๆ: deploy นอกเวลาเรียน)
- ย้อนรุ่น: `git checkout <commit เดิม>` แล้ว `up -d --build` · migration ไม่ย้อนอัตโนมัติ
  (ถ้าต้องย้อนข้อมูล ใช้ backup ก่อน deploy: ข้อ 5)
- ภายหลัง: GitHub Actions → SSH → คำสั่งชุดนี้ (PLAN.md ข้อ 3)

## 4. backup

| อะไร | เมื่อไร | อยู่ที่ |
|---|---|---|
| WAL (ทุกการเปลี่ยนแปลง) | ต่อเนื่อง อย่างน้อยทุก 5 นาที (`archive_timeout`) | ไดรฟ์ `backups:/wal/<system id>/` (แยกตามฐาน: initdb ใหม่บนไดรฟ์ backup เดิมไม่ชนกัน) |
| base backup (ตรวจ `pg_verifybackup` แล้ว) | ทุกวัน `BACKUP_AT` (เวลาไทย) + ครั้งแรกทันที | `backups:/base/<เวลา UTC>.tar.gz` |
| pg_dump ทั้งฐาน | พร้อม base backup | `backups:/dump/<เวลา UTC>.dump` |
| ออกนอกเครื่อง | ทุก `OFFSITE_EVERY_MINUTES` | object storage ผ่าน rclone (profile `offsite`) |

- เก็บ `BACKUP_KEEP` ชุด (ค่าเริ่มต้น 7 วัน) WAL ที่เก่ากว่าชุดเก่าสุดถูกลบ → กู้ย้อนเวลาได้ถึง 7 วัน
- สถานะ: `docker compose exec backup cat /backups/last-success` (ใส่ใน Uptime Kuma ตอน go-live: เตือนถ้าเก่ากว่า 26 ชม.)
  WAL ค้าง: `select * from pg_stat_archiver` (`failed_count` เพิ่ม = archive ล้ม ดิสก์ของ WAL จะโตจนเต็ม)
- backup ทันที: `infra/scripts/backup-now.sh`

### ส่งออกนอกเครื่อง (ต้องมี bucket: มีค่าใช้จ่าย ขออนุญาตเจ้าของโปรเจกต์ก่อน)

ตั้ง remote ชื่อ `offsite` แบบ `crypt` (rclone เข้ารหัสชื่อไฟล์และเนื้อหาก่อนอัปโหลด) ซ้อนบน S3-compatible ใน `infra/.env`:

```sh
RCLONE_CONFIG_STORE_TYPE=s3
RCLONE_CONFIG_STORE_PROVIDER=Cloudflare          # หรือ AWS / Wasabi / Other
RCLONE_CONFIG_STORE_ENDPOINT=https://<account>.r2.cloudflarestorage.com
RCLONE_CONFIG_STORE_ACCESS_KEY_ID=...            # key ที่เขียนได้เฉพาะ bucket นี้
RCLONE_CONFIG_STORE_SECRET_ACCESS_KEY=...
RCLONE_CONFIG_OFFSITE_TYPE=crypt
RCLONE_CONFIG_OFFSITE_REMOTE=store:<bucket>/accounting
RCLONE_CONFIG_OFFSITE_PASSWORD=...               # rclone obscure <รหัสยาว ๆ>
RCLONE_CONFIG_OFFSITE_PASSWORD2=...              # rclone obscure <อีกค่า>
OFFSITE_PATH=offsite:
```

```sh
docker compose --profile offsite up -d
docker compose logs -f offsite
```

- **เก็บรหัส crypt ไว้นอก server ด้วย** (password manager ของเจ้าของโปรเจกต์) server หาย = ไม่มีรหัสนี้ก็กู้ไม่ได้
- เปิด versioning/object lock ที่ bucket ถ้ามี (กันคนที่ได้ server ไปแล้วลบ backup นอกเครื่องด้วย `sync`)

## 5. กู้คืน

### ซ้อมกู้คืน (ทำเดือนละครั้ง + หลังเปลี่ยนวิธี backup) — ไม่กระทบระบบที่ใช้อยู่

```sh
infra/scripts/restore-drill.sh                                  # ถึงล่าสุด
infra/scripts/restore-drill.sh --time '2026-11-04 10:30:00+07'  # ย้อนถึงเวลานั้น
```

กู้ลงฐานชั่วคราว ตรวจว่า migration/ตาราง/ฟังก์ชัน/policy ครบและจำนวนแถวไม่น้อยกว่าฐานจริง ทุกรายการบัญชีเดบิต = เครดิต
แล้วลบทิ้ง บรรทัดสุดท้าย `ผ่าน: กู้คืนและตรวจเสร็จใน N วินาที` = เวลากู้ (RTO โดยประมาณ) จดผลลงตารางท้ายไฟล์นี้

### กู้จริง (ฐานพัง/ลบข้อมูลผิด)

1. หยุดการเขียน: `docker compose stop caddy api web backup`
2. เก็บของเดิมไว้ก่อน (อย่าลบ): `docker run --rm -v accounting_pgdata:/d -v /srv:/o alpine tar czf /o/pgdata-before-restore.tgz -C /d .`
3. เลือกชุด: ล่าสุด หรือชุดที่อยู่ก่อนเวลาที่ต้องการ (`ls` ใน `backups:/base`; system id ของชุดอยู่ในไฟล์ `<ชุด>.sysid`) ซ้อมด้วย `restore-drill.sh --time ...` ก่อนจนได้ข้อมูลที่ต้องการ
4. กู้ลงไดรฟ์ `pgdata` จริง:
   ```sh
   docker compose stop db
   docker compose run --rm --no-deps --entrypoint sh db -c '   # ใช้ไดรฟ์ pgdata/backups ของ service db
     set -e; d=/var/lib/postgresql/data; rm -rf "$d"/* && tar -xzf /backups/base/<ชุด>.tar.gz -C "$d"
     touch "$d/recovery.signal"
     printf "%s\n" "restore_command = '\''cp /backups/wal/<system id>/%f %p'\''" "recovery_target_action = '\''promote'\''" >> "$d/postgresql.auto.conf"
     # ย้อนเวลา: เพิ่มบรรทัด recovery_target_time = '\''2026-11-04 10:30:00+07'\''
     chown -R postgres:postgres "$d" && chmod 700 "$d"'
   docker compose up -d db && docker compose logs -f db     # รอ "archive recovery complete"
   ```
5. ลบบรรทัดกู้คืนออกจาก `postgresql.auto.conf` (หลัง promote แล้วไม่ใช้ แต่กันสับสน) แล้ว `docker compose up -d --wait`
6. ทำ base backup ใหม่ทันที (`backup-now.sh`) เพราะ timeline เปลี่ยน
7. server หายทั้งเครื่อง: ติดตั้งข้อ 1–2 บนเครื่องใหม่ (ยังไม่ `up` api/web) ดึง backup กลับด้วย
   `rclone copy offsite: /var/lib/docker/volumes/accounting_backups/_data` แล้วทำข้อ 4

pg_dump ใช้กู้บางตาราง/ย้ายไป Postgres รุ่นใหม่: `pg_restore -l` ดูรายการ แล้ว `pg_restore -d <ฐานชั่วคราว> -t <ตาราง>`

## 6. สิ่งที่ยังไม่อยู่ในชุดนี้ (go-live)

- monitoring: Prometheus + Grafana, Sentry, Uptime Kuma, `pg_stat_statements` (PLAN.md ข้อ 12 Go-live)
- Cloudflare หน้าเว็บ: ตั้ง `TRUSTED_PROXIES` เป็นช่วง IP ของ Cloudflare (ไม่อย่างนั้นตัวจำกัดอัตราจะนับทุกคนเป็น IP ของ Cloudflare)
- ตัวจำกัดอัตราอยู่ในหน่วยความจำของ API 1 ตัว (ถ้าเพิ่ม API หลายตัวต้องย้ายไป Redis)
- Realtime ยังเป็น SSE + LISTEN/NOTIFY (WebSocket `apps/realtime` ตามแผนเมื่อจำเป็น)

## บันทึกการซ้อมกู้คืน

| วันที่ | เครื่อง | ชุด base | ผล | เวลา | ผู้ทำ |
|---|---|---|---|---|---|
| 4 พ.ย. 2569 | เครื่องพัฒนา (Docker, localhost) | ล่าสุด + ย้อนเวลา | ผ่าน (เห็น/ไม่เห็นรายการที่ลงหลัง backup ตามเป้าหมาย) | 2–3 วินาที (ฐานเล็ก) | Claude Code |
