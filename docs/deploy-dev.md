# ตั้งระบบช่วงพัฒนาบน Supabase + Vercel (PLAN.md ข้อ 3)

ใช้สำหรับทดสอบบนอุปกรณ์จริง (`docs/device-test.md`) ไม่ใช่ production (production = self-host ตามแผน)

## รูปแบบ

- **Vercel โปรเจกต์เดียว**: เว็บ Next.js + API ตัวเดิมฝังที่ `/api/*` (`EMBED_API=1` → `apps/web/pages/api/[...path].ts`
  เรียก `apps/api/src/embedded.ts`) โดเมนเดียวกัน cookie/CSRF ทำงานเหมือนเดิม
- **Supabase โปรเจกต์ใหม่** (Postgres เท่านั้น ไม่ใช้ Supabase Auth/Storage/Edge Functions ตามกติกาข้อ 3)
  - คำขอปกติ → Supavisor แบบ transaction (พอร์ต 6543) ตามกติกาข้อ 3.7
  - ดูสด (LISTEN) → Supavisor แบบ session (พอร์ต 5432) ต่อละ 1 การเชื่อมต่อต่อ instance ของ function

## ข้อจำกัดของช่วงพัฒนา (รอยืนยันจากเจ้าของโปรเจกต์)

- ดูสดยังเป็น LISTEN/NOTIFY → SSE (ยังไม่เปลี่ยนเป็น Supabase Broadcast) SSE หลุดเมื่อ function ครบเวลาสูงสุด
  เบราว์เซอร์ต่อใหม่เอง ระหว่างต่อใหม่อาจพลาดสัญญาณ (แดชบอร์ดครูดึงสรุปทุก 5 วินาทีอยู่แล้ว)
- ตัวจำกัดอัตรา (rate limit) อยู่ในหน่วยความจำ แยกต่อ instance หลวมกว่าบนเซิร์ฟเวอร์จริง (แผนใช้ Upstash ตอนต้องการจริง)
- Supabase แผนฟรีหยุดโปรเจกต์อัตโนมัติเมื่อไม่มีการใช้งาน 1 สัปดาห์

## ขั้นตอน

### 1. Supabase

1. สร้างโปรเจกต์ใหม่ ภูมิภาค `ap-southeast-1` (สิงคโปร์ ใกล้ไทยสุด)
   - บัญชีฟรีเปิดได้พร้อมกัน 2 โปรเจกต์ต่อผู้ดูแลองค์กร ถ้าเต็มให้ใช้องค์กรของบัญชีอื่น (อย่าเชิญบัญชีใหม่เข้าองค์กรเดิม)
2. รัน migration ตามลำดับไฟล์ใน `db/migrations/` (ส่วน `-- migrate:up` เท่านั้น) แล้วบันทึกเวอร์ชันลง `schema_migrations`
   เหมือน `scripts/migrate.mjs` (ถ้าเครื่องต่อพอร์ต 5432/6543 ได้ ใช้สคริปต์ตรง ๆ:
   `DATABASE_URL=<session pooler ของ postgres> pnpm db:migrate --seed`) แล้วรัน `db/seed/001_coa_template.sql`
   - ห้ามสร้างตาราง/policy จาก dashboard (กติกาข้อ 3.1)
3. สร้างบทบาท login ของแอป (รหัสผ่านอยู่ชั้น infra ไม่ใส่ใน migration ไม่ใส่ใน repo):
   ```sql
   create role app_web login password '<สุ่มยาว ๆ>' in role app_rw;
   ```
4. สร้างโรงเรียน + ผู้ดูแลคนแรก: ใช้ `pnpm --filter @accounting/api create-admin` (ต่อ DB ได้) หรือ SQL ที่ใส่แฮช Argon2id
   ที่สร้างจาก `apps/api/src/passwords.ts` (`hashPassword`) **ห้ามใช้รหัสตัวอย่างใน CI/fixture** เพราะ URL เปิดสาธารณะ
   แล้วให้ผู้ดูแลสร้างครู ห้อง และนำเข้านักเรียนจากหน้าเว็บตามปกติ

### 2. Vercel

1. สร้างโปรเจกต์ผูกกับ repo นี้ Root Directory = `apps/web`, Framework = Next.js
   - Build Command: `pnpm run build:vercel` (build API ก่อน แล้ว `next build`)
2. Environment Variables (Production):

   | ชื่อ | ค่า |
   |---|---|
   | `EMBED_API` | `1` (ต้องมีตอน build ด้วย) |
   | `DATABASE_URL` | `postgres://app_web.<ref>:<รหัส>@aws-<n>-ap-southeast-1.pooler.supabase.com:6543/postgres` (transaction) |
   | `REALTIME_DATABASE_URL` | เหมือนกันแต่พอร์ต `5432` (session) สำหรับ LISTEN |
   | `PG_POOL_MAX` | `3` |
   | `COOKIE_SECURE` | `true` |
   | `WEB_ORIGIN` | `https://<โดเมน production ของโปรเจกต์>` (ใช้ตรวจ CSRF) |
   | `AUTH_ADAPTER` | `session` |

   - TLS: Supabase บังคับ TLS ตรวจให้ `pg` ต่อแบบเข้ารหัส (ค่า `sslmode` ใน URL) และตรวจใบรับรองได้
3. Deploy แล้วเปิด `https://<โดเมน>/api/health` ต้องได้ `{"ok":true}` แล้วทำตาม `docs/device-test.md`
