# รันบนเครื่องนักพัฒนา

ต้องมี Node 22, pnpm 10, PostgreSQL 16

```sh
pnpm install
# 1) ฐานข้อมูล (ใช้ superuser เฉพาะตอน migrate/สร้าง fixture)
createdb accounting_dev
DATABASE_URL=postgres://postgres@localhost/accounting_dev pnpm db:migrate --seed
psql postgres://postgres@localhost/accounting_dev -f db/dev/fixture.sql
# ผู้ดูแลคนแรก (ครั้งเดียวตอนติดตั้ง) จากนั้นสร้างครู/ห้อง/นำเข้านักเรียนที่หน้า /admin ได้เลย
export ADMIN_DATABASE_URL=postgres://postgres@localhost/accounting_dev
pnpm --filter @accounting/api create-admin admin@example.test 'ผู้ดูแลระบบ'
# ตั้งรหัสให้ข้อมูลตัวอย่าง (ไม่ใส่รหัส = สุ่มรหัสชั่วคราว บังคับเปลี่ยนตอนเข้าครั้งแรก)
pnpm --filter @accounting/api set-password teacher@example.test    # ครู (อีเมล)
pnpm --filter @accounting/api set-password 65012                   # นักเรียน (รหัสนักเรียน)

# 2) API (Fastify) — ต่อด้วยบทบาท app_dev ซึ่งเป็นสมาชิก app_rw
DATABASE_URL=postgres://app_dev:app_dev@localhost/accounting_dev COOKIE_SECURE=false \
  WEB_ORIGIN=http://localhost:3000 pnpm --filter @accounting/api dev

# 3) เว็บ (Next.js)
API_URL=http://127.0.0.1:4000 pnpm --filter @accounting/web dev
# เปิด http://localhost:3000 → /login
```

- ล็อกอินจริงเป็นค่าเริ่มต้น (`AUTH_ADAPTER=session`); `AUTH_ADAPTER=dev` (เชื่อ header `x-dev-user-id`) ใช้ในเทสต์เท่านั้น API ไม่ยอมเริ่มถ้า `NODE_ENV=production`
- ตัวแปรทั้งหมดดู `.env.example`; production ต้อง `COOKIE_SECURE=true` และ `WEB_ORIGIN` เป็นโดเมนจริง
- เบราว์เซอร์เรียก `/api/*` ที่ origin เดียวกัน Next.js rewrite ไปที่ `API_URL`
- เทสต์ทั้งหมด: `pnpm test` (สร้างฐาน `accounting_test` ใหม่ทุกครั้ง)
- ตรวจเส้นทางผู้ดูแล → ครูนำเข้า CSV → ใบรหัสผ่าน → นักเรียนเข้าใช้: `node tests/e2e-admin.mjs <base> <อีเมลผู้ดูแล> <รหัสชั่วคราว> <โฟลเดอร์ csv> <โฟลเดอร์ภาพ>`
- ตรวจครูเปิดบริษัททั้งห้อง → นักเรียนลงรายการ → งบทดลอง/แยกประเภท 3 ขนาดจอ: `node tests/e2e-reports.mjs <base> <อีเมลครู> <รหัสครู> <รหัสนักเรียน> <รหัสผ่าน> <โฟลเดอร์ภาพ>`
- lint: `pnpm lint`
- เทสต์หน้าจอ 3 ขนาด (Playwright) ต้องเปิดเว็บ + API กับฐาน accounting_dev ก่อน: `pnpm --filter @accounting/tests e2e`
  (ภาพอยู่ที่ `tests/e2e-results/screens/<phone|ipad|pc>/` ตรวจอัตโนมัติ: ไม่เลื่อนแนวนอนเกินจอ, ช่องกรอก ≥ 16px, ปุ่ม ≥ 44px บนจอสัมผัส, ไม่มี error ใน console)
- CI (`.github/workflows/ci.yml`): checks (lint/typecheck/build/เทสต์) · e2e 3 จอ + ภาพเป็น artifact · security (pnpm audit + Trivy) · Dependabot รายสัปดาห์
- ทดสอบโหลด k6 (500 คน): ดู `docs/load-test.md` (ไม่ได้อยู่ใน CI เพราะหนักเกินเครื่อง CI)
- ตรวจดูสด (ครูกับนักเรียนสองเบราว์เซอร์พร้อมกัน): `node tests/e2e-live.mjs <base> <อีเมลครู> <รหัสครู> <รหัสนักเรียน> <รหัสผ่าน> <ชื่อบริษัท> <โฟลเดอร์ภาพ>`
- realtime: API ฟัง Postgres `LISTEN acc_events` ด้วยการเชื่อมต่อตรง (ตั้ง `REALTIME_DATABASE_URL` เมื่อ `DATABASE_URL` ผ่าน PgBouncer แบบ transaction pooling)
- ตรวจวงจรส่งงาน: `node tests/e2e-submit.mjs <base> <อีเมลครู> <รหัสครู> <รหัสนักเรียน> <รหัสผ่าน> <โฟลเดอร์ภาพ>`
- ตรวจ UI ด้วยมือ 3 ขนาดจอ: `node tests/e2e-smoke.mjs http://127.0.0.1:3000 <รหัสนักเรียน> <รหัสผ่าน> <โฟลเดอร์ภาพ>` (ล็อกอิน ลงรายการจริงผ่านหน้าจอ แล้วถ่ายภาพ)

## โครงสร้าง

| ที่ | หน้าที่ |
|---|---|
| `apps/api/src/routes/companies.ts` | route บาง ๆ: Zod → ฟังก์ชันใน Postgres |
| `apps/api/src/db.ts` | `withUser()` ตั้ง `app.user_id` ต่อทรานแซกชัน (ใช้กับ PgBouncer transaction pooling ได้) |
| `apps/api/src/auth.ts` | `AuthAdapter` จุดเดียวที่จะสลับเป็นระบบล็อกอินจริงในเฟส 1 |
| `apps/web/app/c/[companyId]/…` | หน้าของบริษัท (โครงหลัก + สมุดรายวัน) |
| `apps/web/components/JournalForm.tsx` | ฟอร์มสมุดรายวัน คำนวณผลต่างเป็นสตางค์ BigInt |
