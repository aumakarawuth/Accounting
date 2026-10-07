# รันบนเครื่องนักพัฒนา

ต้องมี Node 22, pnpm 10, PostgreSQL 16

```sh
pnpm install
# 1) ฐานข้อมูล (ใช้ superuser เฉพาะตอน migrate/สร้าง fixture)
createdb accounting_dev
DATABASE_URL=postgres://postgres@localhost/accounting_dev pnpm db:migrate --seed
psql postgres://postgres@localhost/accounting_dev -f db/dev/fixture.sql   # พิมพ์ DEV_COMPANY_ID ออกมา

# 2) API (Fastify) — ต่อด้วยบทบาท app_dev ซึ่งเป็นสมาชิก app_rw
cp .env.example .env   # แล้วใส่ DEV_COMPANY_ID
DATABASE_URL=postgres://app_dev:app_dev@localhost/accounting_dev AUTH_ADAPTER=dev \
  DEV_USER_ID=00000000-0000-4000-8000-000000000020 pnpm --filter @accounting/api dev

# 3) เว็บ (Next.js)
API_URL=http://127.0.0.1:4000 DEV_COMPANY_ID=<จากข้อ 1> pnpm --filter @accounting/web dev
```

- `AUTH_ADAPTER=dev` เชื่อ header `x-dev-user-id` หรือ `DEV_USER_ID` ใช้บนเครื่องเท่านั้น API ไม่ยอมเริ่มถ้า `NODE_ENV=production`
- เบราว์เซอร์เรียก `/api/*` ที่ origin เดียวกัน Next.js rewrite ไปที่ `API_URL`
- เทสต์ทั้งหมด: `pnpm test` (สร้างฐาน `accounting_test` ใหม่ทุกครั้ง)
- ตรวจ UI ด้วยมือ 3 ขนาดจอ: `node tests/e2e-smoke.mjs http://127.0.0.1:3000 <DEV_COMPANY_ID> <โฟลเดอร์ภาพ>` (ลงรายการจริงผ่านหน้าจอแล้วถ่ายภาพ)

## โครงสร้าง

| ที่ | หน้าที่ |
|---|---|
| `apps/api/src/routes/companies.ts` | route บาง ๆ: Zod → ฟังก์ชันใน Postgres |
| `apps/api/src/db.ts` | `withUser()` ตั้ง `app.user_id` ต่อทรานแซกชัน (ใช้กับ PgBouncer transaction pooling ได้) |
| `apps/api/src/auth.ts` | `AuthAdapter` จุดเดียวที่จะสลับเป็นระบบล็อกอินจริงในเฟส 1 |
| `apps/web/app/c/[companyId]/…` | หน้าของบริษัท (โครงหลัก + สมุดรายวัน) |
| `apps/web/components/JournalForm.tsx` | ฟอร์มสมุดรายวัน คำนวณผลต่างเป็นสตางค์ BigInt |
