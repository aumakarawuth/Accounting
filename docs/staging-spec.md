# เฟสกลาง: ชุด self-host (สเปก)

PLAN.md ข้อ 12 "เฟสกลาง — พิสูจน์การย้าย" ทำส่วนที่ไม่ต้องมี server จริงก่อน: ชุด Docker Compose + backup + ซ้อมกู้คืน
ทดสอบบนเครื่องด้วย `localhost` แทนโดเมน (เจ้าของโปรเจกต์ยังไม่ระบุ server/domain: PLAN.md ข้อ 14)

## 1. ขอบเขต

| ทำในงานนี้ | รอ server จริง |
|---|---|
| `infra/docker-compose.yml`: Postgres 16 + PgBouncer + API + เว็บ + Caddy | ชี้ DNS/โดเมน ใบรับรองจริง (Caddy ขอ Let's Encrypt เอง) |
| image ของ API และเว็บ (Next standalone รวม `public/` และ `.next/static/`) | k6 500 คนบน server จริง |
| ตั้งค่าฐานข้อมูลครั้งแรก/ทุกครั้งที่ deploy (`migrate` service) | firewall/SSH/fail2ban ของเครื่อง |
| backup อัตโนมัติ: base backup + WAL archive (กู้ย้อนเวลาได้) + pg_dump รายวัน | bucket object storage จริง (มีค่าใช้จ่าย ต้องขออนุญาตก่อน) |
| ส่ง backup ออกนอกเครื่องด้วย rclone (เข้ารหัสฝั่งเรา) | สลับ adapter Realtime (WebSocket) |
| สคริปต์ซ้อมกู้คืน (กู้จริงลงฐานชั่วคราว ตรวจข้อมูล เทียบกับฐานจริง) + CI รันทุก PR | GitHub Actions → SSH → deploy |
| คู่มือ deploy `docs/self-host.md` | |

## 2. เส้นทางคำขอ

```
เบราว์เซอร์ ─HTTPS─▶ Caddy :443 ─┬─ /api/* (ตัด /api) ─▶ api:4000 ─┬─ pgbouncer:6432 (transaction) ─▶ db:5432
                                 └─ อื่น ๆ ─────────────▶ web:3000 ─┘ (SSR เรียก api:4000 ส่ง cookie ต่อ)
                                                          api ─ LISTEN acc_events ─ ต่อตรง db:5432 (ไม่ผ่าน PgBouncer)
```

- เปิดสู่ภายนอกเฉพาะ 80/443 (Caddy) ฐานข้อมูล PgBouncer API เว็บ อยู่ในเครือข่ายภายในของ Compose เท่านั้น
- Caddy ทับ `X-Forwarded-For` ด้วย IP จริงของผู้ใช้ (ไม่เชื่อค่าจากไคลเอนต์) API เชื่อ header นี้เฉพาะจาก IP ของ Caddy (`TRUST_PROXY`)
  เพื่อให้ตัวจำกัดอัตราต่อ IP และล็อกอินผิดต่อ IP นับ IP จริง
- `/api` ไปที่ API ตรงจาก Caddy (เหมือน rewrite ของ Next แต่ไม่ผ่าน Node ของเว็บอีกชั้น) SSE ดูสดผ่าน Caddy ได้ (flush ทันที)

## 3. ฐานข้อมูลและบทบาท

- `postgres` (superuser) ใช้เฉพาะ migrate/สร้างผู้ดูแลคนแรก/backup ไม่ให้แอปใช้
- `app_web` = login role ของแอป เป็นสมาชิก `app_rw` (สิทธิ์ตาม migration เดิม RLS บังคับเหมือนบน Supabase)
  service `migrate` สร้าง/ตั้งรหัสจาก `APP_DB_PASSWORD` ทุกครั้งที่ deploy (หมุนรหัสได้ด้วยการเปลี่ยน `.env` แล้ว `up`)
- รหัสผ่านทั้งหมดอยู่ใน `infra/.env` บน server เท่านั้น (ไม่อยู่ใน repo) ตัวอย่างใน `infra/.env.example` เป็นค่าว่าง
- PgBouncer: transaction pooling, `max_prepared_statements` เปิด, SCRAM ทั้งสองฝั่ง

## 4. Backup และกู้คืน

PLAN.md ข้อ 7 ระบุ pgBackRest/WAL-G งานนี้ใช้เครื่องมือที่มากับ Postgres 16 แทน (`docs/assumptions.md` ข้อ 35):
`pg_basebackup` (ตรวจด้วย `pg_verifybackup`) + `archive_command` เก็บ WAL + `pg_dump` รายวัน → ไดรฟ์ `backups`
แล้ว rclone sync ขึ้น object storage (S3/R2/B2 ฯลฯ) ผ่าน remote แบบ `crypt` (เข้ารหัสก่อนออกจากเครื่อง)

- base backup ทุกวันเวลา `BACKUP_AT` (เวลาไทย) เก็บ `BACKUP_KEEP` ชุด ลบ WAL ที่เก่ากว่าชุดเก่าสุดที่เก็บ
- WAL ถูกส่งเข้า archive อย่างน้อยทุก `archive_timeout` (5 นาที) = ข้อมูลหายได้ไม่เกิน ~5 นาที (RPO) ถ้าเครื่องพังทั้งเครื่อง
  ขึ้นกับรอบ sync ออกนอกเครื่องด้วย (`OFFSITE_EVERY_MINUTES`)
- ซ้อมกู้คืน `infra/scripts/restore-drill.sh [--time 'YYYY-MM-DD HH:MM:SS+07']`:
  กู้ base backup ล่าสุด (หรือชุดที่อยู่ก่อนเวลาที่ระบุ) ลงฐานชั่วคราว เล่น WAL จนถึงล่าสุด/เวลาที่ระบุ แล้วตรวจ
  1) migration ครบเท่าฐานจริง 2) จำนวนแถวตารางหลักไม่น้อยกว่าฐานจริง ณ ตอนเริ่มซ้อม 3) ทุกรายการบัญชีเดบิต = เครดิต
  4) ฟังก์ชัน/policy ครบ ไม่เขียนอะไรลงฐานจริง (archive เปิดแบบอ่านอย่างเดียวในฐานชั่วคราว) จบแล้วลบทิ้ง รายงานเวลาที่ใช้ (RTO)

## 5. การทดสอบ

- `infra/scripts/smoke.sh` (รันบนเครื่องและใน CI job `infra`): build image → `up` → ตรวจหน้าเว็บ/API ผ่าน HTTPS
  header ความปลอดภัย, ล็อกอินจริงด้วยผู้ดูแลที่สร้างตอนทดสอบ, PDF ส่งออกได้ (pdfkit ใน standalone),
  ดูสด SSE ผ่าน Caddy → backup → เขียนข้อมูลเพิ่ม → ซ้อมกู้คืนต้องเห็นข้อมูลที่เขียนหลัง backup (พิสูจน์ว่าเล่น WAL)
- `scripts/security-check.mjs` กับ `https://localhost`

## 6. Realtime ฝั่ง self-host (สลับ adapter)

- API (`server.ts`) เปิด WebSocket `/ws` (ผ่าน Caddy = `wss://<โดเมน>/api/ws`) การเชื่อมต่อเดียวต่อแท็บฟังได้หลายช่อง
  แทน SSE ที่ต้องเปิด 1 การเชื่อมต่อต่อช่อง · ส่วนฝัง API บน Vercel ไม่ import โค้ด WebSocket เลย (`buildApp({ websocket })`)
- โปรโตคอล: `{op:'sub'|'unsub', ch}` → `{op:'ok'|'err', ch, code}` และ event `{ch, k, ...}` แบบเดียวกับ SSE (สัญญาณเท่านั้น)
- เว็บ (`apps/web/lib/realtime.ts`): build ด้วย `NEXT_PUBLIC_REALTIME=ws` (image ของ infra และ CI e2e) = ลอง WebSocket ก่อน
  ต่อไม่ได้ตั้งแต่ครั้งแรก/ต่อใหม่ไม่ได้ 3 รอบ = SSE · ไม่ตั้ง (Vercel) = SSE อย่างเดียว · API ปิดได้ด้วย `REALTIME_WEBSOCKET=off`
- ทดสอบ: `tests/realtime-ws.test.ts` (Origin, ต้องล็อกอิน, สิทธิ์ช่อง, เพดาน, ข้อความเสีย, ออกจากระบบแล้วตัด)
  · e2e ดูสดตรวจว่าป้าย "กำลังดูอยู่" มาทาง WebSocket (`E2E_WS=1`) · smoke ผ่าน Caddy (wss)
