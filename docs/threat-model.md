# Threat model (ฉบับร่างเฟส 0 — ขยายในเฟส 1)

| ภัย | มาตรการที่มีแล้ว (DB) | ที่ยังต้องทำ |
|---|---|---|
| นักเรียนอ่าน/เขียนข้อมูลบริษัทอื่น (IDOR) | RLS ทุกตาราง + ตรวจสิทธิ์ซ้ำใน `post_journal()` ; เทสต์ `isolation.test.ts` รันทุก PR | ตรวจเจ้าของ resource ที่ชั้น API |
| ข้อมูลบัญชีเพี้ยน | NUMERIC(18,2), deferred trigger เดบิต=เครดิต, append-only, ยอดคงเหลือใน txn เดียว | — |
| กดซ้ำ/เน็ตหลุด | idempotency key + hash คำขอ | ฝั่ง client สร้าง key |
| แก้ย้อนหลังหลังปิดงวด | ตรวจใน `post_journal()` และ trigger | — |
| ผู้ใช้ลบร่องรอย | audit_log เขียนด้วย trigger, แก้/ลบไม่ได้ | ส่ง log ออกนอกเครื่อง (self-host) |
| ใช้ superuser ในแอป | role แยก app_rw/app_ro/migrator | ตั้งรหัส/การเชื่อมต่อใน infra |
| เดารหัสนักเรียน | — | rate limit/ล็อกชั่วคราว (เฟส 1) |
