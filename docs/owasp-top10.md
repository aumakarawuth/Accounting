# เช็กลิสต์ OWASP Top 10 (2021) — ทดสอบเจาะระบบเบื้องต้น เฟส 4

ทดสอบเมื่อ 4 พ.ย. 2569 บนเครื่องพัฒนา (API + เว็บ build จริง + Postgres 16) และอ่านโค้ด ไม่ใช่การทดสอบโดยผู้เชี่ยวชาญภายนอก
ก่อน go-live ยังควรให้ผู้เชี่ยวชาญหรือ OWASP ZAP (โหมด active scan) ทดสอบกับ staging อีกรอบ (PLAN.md ข้อ 12)

สถานะ: **ผ่าน** = มีมาตรการ + มีเทสต์อัตโนมัติ · **แก้แล้ว** = พบในรอบนี้และแก้พร้อมเทสต์ · **รับความเสี่ยง** = รู้แล้ว ตัดสินใจไว้ก่อน (เหตุผลในตาราง)
· **ต้องทำ** = ยังไม่ได้ทำ ต้องทำก่อน go-live

## A01 การควบคุมสิทธิ์ผิดพลาด (Broken Access Control)

| ตรวจ | ผล | หลักฐาน |
|---|---|---|
| นักเรียน A อ่าน/เขียนบริษัท B (IDOR) ทุก route | ผ่าน | RLS ทุกตาราง + `requireReadable/requireWritable` · `tests/isolation.test.ts`, `api.test.ts` และเทสต์ของแต่ละโมดูล |
| นักเรียนอ่านเฉลยก่อนเวลา (ตารางตรง / API / ผลตรวจ) | ผ่าน | ไม่มี policy ให้นักเรียนบน `exercise_*`/`assignments` · `app.grade_company` ไม่ให้ app_rw เรียก · `acc.assignment_view` ตัดตามเวลา · `tests/exercises.test.ts` (ตรวจว่า JSON ไม่มีรหัส/ยอดของเฉลย) |
| ครูห้องอื่นดู/คุมงานของห้องนี้ | ผ่าน | `app.can_manage_assignment` · ตอบ 404 เหมือนไม่มีงาน |
| นักเรียนส่งออกคะแนนของห้อง / ไฟล์รายงานของบริษัทอื่น | ผ่าน | `/export/*` ดึงข้อมูลผ่าน API ด้วย cookie ของผู้ใช้เอง (403/404) · e2e `exercises.spec.ts` |
| ลงรายการหลังหมดเวลาสอบ/ก่อนเริ่ม/หลังปิดงาน (ทุกเส้นทางเขียน) | ผ่าน | trigger `guard_locked_company` ใช้ `app.company_lock_reason` เวลาจาก DB (`now()`) ไม่เชื่อนาฬิกาเครื่อง |
| ครูแก้สมุดรายวันนักเรียน | ผ่าน | `can_write_company` เฉพาะเจ้าของ |
| ผู้ดูแลระบบเห็นข้อมูลบัญชีนักเรียน | ผ่าน | `can_read_company` ไม่รวมผู้ดูแล |

## A02 การเข้ารหัสผิดพลาด (Cryptographic Failures)

| ตรวจ | ผล | หลักฐาน |
|---|---|---|
| รหัสผ่านแฮช Argon2id, token เซสชันสุ่ม 256 บิต เก็บแค่ sha256 | ผ่าน | `passwords.ts`, `auth.ts` |
| cookie `__Host-sid` HttpOnly Secure SameSite=Lax | ผ่าน | `routes/auth.ts`, `config.ts` |
| HTTPS + HSTS | **แก้แล้ว** | เพิ่ม `Strict-Transport-Security: max-age=31536000; includeSubDomains` ทุกหน้า (`next.config.ts`) · Vercel/Caddy บังคับ HTTPS |
| DB ต่อแบบ TLS ตรวจใบรับรอง | ผ่าน | `DATABASE_CA_CERT` (`docs/deploy-dev.md`) |
| เข้ารหัสดิสก์/backup | ต้องทำ | ตอน self-host (PLAN.md ข้อ 5) |

## A03 Injection

| ตรวจ | ผล | หลักฐาน |
|---|---|---|
| SQL injection | ผ่าน | ทุกคำสั่งใช้ parameter (`$1`) ส่วนที่ต่อสตริงเป็นค่าคงที่ในโค้ด (รายชื่อคอลัมน์/ตัวกรองที่เลือกจาก enum) ตรวจด้วย `grep` แล้ว |
| XSS | ผ่าน | React escape ทุกข้อความ · `dangerouslySetInnerHTML` มีที่เดียว (QR SVG จากไลบรารี ไม่มีข้อความผู้ใช้ปน) · CSP |
| สูตรแฝงใน Excel (CSV/Formula injection) | ผ่าน | .xlsx เขียนข้อความเป็น inline string ไม่ถูกตีความเป็นสูตร · `tests/exports.test.ts` (ชื่อบัญชี `=HYPERLINK(...)`) |
| Header injection ผ่านชื่อไฟล์ดาวน์โหลด (ชื่อบริษัทมี `"`/ขึ้นบรรทัด) | ผ่าน | `filename*` เข้ารหัส RFC 5987 · `tests/exports.test.ts` |

## A04 การออกแบบไม่ปลอดภัย (Insecure Design)

| ตรวจ | ผล | หลักฐาน |
|---|---|---|
| ความถูกต้องบัญชีอยู่ใน DB (ดุล, append-only, ปิดงวด, idempotency) | ผ่าน | `tests/books.test.ts` ฯลฯ |
| โหมดสอบ 1 เซสชันต่อคน | ผ่าน | เริ่มสอบ/ล็อกอินใหม่ระหว่างสอบเพิกถอนเซสชันอื่น (`app.exam_single_session`) |
| ตรวจคำตอบเดา/ไล่ลองเฉลยได้ไหม | รับความเสี่ยง | ฝึกหัดที่ครูตั้ง "แสดงผลทันที" นักเรียนลองผิดลองถูกได้โดยเจตนา (เป็นการฝึก) · สอบบังคับซ่อนผลจนครูเปิดเฉลย |
| ปลอมเวลาเครื่องเพื่อยืดเวลาสอบ | ผ่าน | เวลาตัดสินที่ DB นาฬิกาบนจอแก้ส่วนต่างด้วยเวลาเซิร์ฟเวอร์ |

## A05 การตั้งค่าความปลอดภัยผิดพลาด (Security Misconfiguration)

| ตรวจ | ผล | หลักฐาน |
|---|---|---|
| Content-Security-Policy | **แก้แล้ว** | `default-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'` ฯลฯ · `tests/security.test.ts` |
| CSP แบบ nonce (เลิก `'unsafe-inline'` ใน script-src และ style-src) | **แก้แล้ว** (10 พ.ย. 2569) | `apps/web/proxy.ts` สร้าง nonce ใหม่ทุกคำขอ `script-src 'self' 'nonce-…' 'strict-dynamic'` · ทุกหน้าเรนเดอร์ตอนมีคำขอ (`app/layout.tsx` `connection()`) · `tests/e2e/csp.spec.ts`: ทุก `<script>` มี nonce ของคำขอ, HTML ที่ถูกแทรกพร้อม `onerror` ไม่ทำงาน, ไม่มี CSP violation ในหน้าปกติ (e2e ทุกหน้าจับ console error อยู่แล้ว) |
| รหัสผ่านไปอยู่ใน URL ถ้าส่งฟอร์มก่อนสคริปต์โหลด | **แก้แล้ว** (พบจาก OWASP ZAP 10024) | ฟอร์มล็อกอิน/เปลี่ยนรหัส `method="post"` · `tests/e2e/csp.spec.ts` ปิด JavaScript แล้วกดส่ง |
| คำตอบ API ถูก cache ใน proxy/เบราว์เซอร์ | **แก้แล้ว** | ทุกคำตอบ `Cache-Control: no-store` + `nosniff` (`app.ts` onSend) · ไฟล์ส่งออก `private, no-store` |
| X-Frame-Options, Referrer-Policy, Permissions-Policy, ปิด `X-Powered-By` | ผ่าน | `next.config.ts` |
| error 500 ไม่เปิดเผยรายละเอียด | ผ่าน | ตอบ `{code:'server', ref}` log ฝั่งเซิร์ฟเวอร์ (`errors.ts`) |
| `AUTH_ADAPTER=dev` ใน production | ผ่าน | `server.ts` ปฏิเสธการเริ่ม |
| Referer เสียทำให้ 500 | **แก้แล้ว** | `new URL()` โยน error → ตอนนี้ตอบ 403 `csrf` · `tests/security.test.ts` |

## A06 ส่วนประกอบมีช่องโหว่ (Vulnerable and Outdated Components)

| ตรวจ | ผล | หลักฐาน |
|---|---|---|
| `pnpm audit --prod` | ผ่าน | ไม่มีช่องโหว่ (4 พ.ย. 2569) · CI รันทุก PR + Trivy + Dependabot รายสัปดาห์ |
| dependency ใหม่เฟส 4 | ผ่าน | `pdfkit` 0.17 (+ fontkit) เท่านั้น · Excel เขียนเองด้วย `node:zlib` (ไม่ใช้ `xlsx` จาก npm ที่ค้างเวอร์ชันมีช่องโหว่) |

## A07 การยืนยันตัวตนผิดพลาด (Identification and Authentication Failures)

| ตรวจ | ผล | หลักฐาน |
|---|---|---|
| เดารหัส: ล็อก 15 นาทีเมื่อผิด 5 ครั้ง + เพดานต่อ IP + rate limit | ผ่าน | `tests/auth.test.ts` |
| เดาว่ารหัสนักเรียนไหนมีอยู่ (ข้อความ/เวลาตอบต่างกัน) | ผ่าน | ข้อความเดียวกัน แฮชหลอกเมื่อไม่มีผู้ใช้ |
| รหัสเริ่มต้นต้องเปลี่ยน, ตรวจกับรหัสยอดแย่ | ผ่าน | `must_change`, `common-passwords.json` |
| เปลี่ยนรหัสแล้วเซสชันอื่นหมดอายุ | ผ่าน | `change_own_password` |
| 2FA ครู/ผู้ดูแล | รับความเสี่ยง | เจ้าของโปรเจกต์ตัดสินใจไม่ใช้ (2569-10-07) |

## A08 ความสมบูรณ์ของซอฟต์แวร์และข้อมูล (Software and Data Integrity Failures)

| ตรวจ | ผล | หลักฐาน |
|---|---|---|
| lockfile ตรึง (`--frozen-lockfile`), action ของ CI ตรึง commit (Trivy) | ผ่าน | `.github/workflows/ci.yml` |
| สมุดรายวัน/audit/เหตุการณ์ส่งงาน/เหตุการณ์ของงานแก้ไม่ได้ | ผ่าน | trigger `forbid_mutation` (รวม `assignment_events`) |
| ฟอนต์ใน PDF | ผ่าน | ฝังจากไฟล์ใน repo (OFL) ไม่โหลดจากเน็ตตอนสร้างไฟล์ |

## A09 การบันทึกและเฝ้าระวังผิดพลาด (Security Logging and Monitoring Failures)

| ตรวจ | ผล | หลักฐาน |
|---|---|---|
| audit log (ใคร ทำอะไร เมื่อไร IP/อุปกรณ์) แก้ไม่ได้ | ผ่าน | `audit_log` + การเปิดดูของครู |
| เหตุการณ์สอบ (มอบหมาย เริ่ม เพิ่มเวลา ปิด เปิดเฉลย) | ผ่าน | `assignment_events` เก็บผู้ทำและอุปกรณ์ |
| แจ้งครูเมื่อบัญชีถูกล็อก | ผ่าน | `teacher_alerts` |
| ส่ง log ออกนอกเครื่อง, Sentry, แจ้งเตือนล็อกอินจาก IP ใหม่ | ต้องทำ | ตอน go-live (PLAN.md ข้อ 12) |

## A10 Server-Side Request Forgery

| ตรวจ | ผล | หลักฐาน |
|---|---|---|
| เซิร์ฟเวอร์ดึง URL ที่ผู้ใช้กำหนด | ผ่าน (ไม่มี) | เว็บเรียก API ที่ `API_URL` คงที่เท่านั้น ไฟล์ส่งออกไม่โหลดทรัพยากรภายนอก |
| QR รหัสห้องสร้างจาก header Host | **แก้แล้ว** (ลดความเสี่ยง) | ใช้ `WEB_ORIGIN` ก่อนถ้าตั้งไว้ (header ปลอมได้เมื่อ proxy ไม่ล้าง) |

## OWASP ZAP baseline (10 พ.ย. 2569)

`zap-baseline.py` (zaproxy/zap-stable 2.16.1, สแกนแบบ passive + spider 2 นาที) กับเว็บบนเครื่อง (`next start` + API) **FAIL 0 · ผ่าน 54 · เตือน 4**

| เตือน | ผล |
|---|---|
| 10024 ข้อมูลสำคัญใน URL (`/login?…&password=`) | **แก้แล้ว**: ZAP ส่งฟอร์มแบบไม่มี JavaScript → GET ฟอร์มรหัสผ่านเป็น `method="post"` (สแกนซ้ำไม่พบแล้ว) |
| 10202 ฟอร์มไม่มี anti-CSRF token | รับความเสี่ยง: ฟอร์มส่งผ่าน JavaScript ไป API ซึ่งตรวจ `Origin` ทุกคำขอที่เปลี่ยนข้อมูล + cookie `SameSite=Lax` (A01 ด้านบน) การส่งแบบไม่มี JS ไปที่หน้าเว็บไม่ทำอะไร |
| 10044 redirect มีเนื้อหาใหญ่ (`/` → `/login`) | รับความเสี่ยง: เนื้อหาเป็น redirect มาตรฐานของ Next ไม่มีข้อมูลผู้ใช้ (ไม่ได้ล็อกอิน) |
| 10027 คำว่า query/select ในไฟล์ JS ของ framework, 10109 เว็บสมัยใหม่ | ข้อมูลเท่านั้น (false positive) |

สแกนซ้ำ: `docker run --rm --network host -v $PWD/zap:/zap/wrk zaproxy/zap-stable:2.16.1 zap-baseline.py -t http://localhost:3000/login -m 2 -r report.html`
ยังค้าง: สแกนแบบ active/ล็อกอินแล้ว (ZAP full scan หรือผู้เชี่ยวชาญ) กับ staging จริง

## วิธีทดสอบซ้ำ

1. อัตโนมัติทุก PR: `pnpm test` (รวม `security.test.ts`, `exercises.test.ts`, `exports.test.ts`, `isolation.test.ts`) + `pnpm audit --prod` + Trivy
2. กับเว็บที่ deploy แล้ว (staging/Vercel): `node scripts/security-check.mjs <https://โดเมน> <รหัสนักเรียน A> <รหัสผ่าน A> <id บริษัทของคนอื่น>`
   ตรวจ header ความปลอดภัย, CSRF (origin ปลอม/Referer เสีย), cookie, IDOR, ไฟล์ส่งออกของคนอื่น, rate limit ล็อกอิน
   (ใช้บัญชีทดสอบเท่านั้น สคริปต์ทำให้บัญชีที่ใช้ทดสอบ rate limit ถูกล็อก 15 นาที)
3. ZAP (ทางเลือกก่อน go-live): `docker run -t zaproxy/zap-stable zap-baseline.py -t https://<staging>` แล้วแนบผลไว้ท้ายไฟล์นี้
4. ทดสอบกับผู้ใช้จริง: `docs/user-test.md`
