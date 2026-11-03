import { z } from 'zod';

export const Login = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('student'), identifier: z.string().trim().regex(/^[0-9A-Za-z-]{1,20}$/), password: z.string().min(1).max(256) }).strict(),
  z.object({ kind: z.literal('staff'), identifier: z.string().trim().toLowerCase().pipe(z.string().min(1).max(254)), password: z.string().min(1).max(256) }).strict(),
]);

export const ChangePassword = z
  .object({ currentPassword: z.string().max(256).optional(), newPassword: z.string().max(512) })
  .strict();

export const StudentParams = z.object({ studentId: z.uuid() });

export const UserParams = z.object({ userId: z.uuid() });
export const ClassroomParams = z.object({ classroomId: z.uuid() });

const Name = z.string().trim().min(1).max(120);
export const StudentCode = z.string().trim().regex(/^[0-9A-Za-z-]{1,20}$/, 'รหัสนักเรียนใช้ได้เฉพาะตัวเลข ตัวอักษรอังกฤษ และขีด');

// ชื่อผู้ใช้ของครู/ผู้ดูแล (เก็บในคอลัมน์ email เดิม)
export const Username = z.string().trim().toLowerCase()
  .regex(/^[a-z0-9][a-z0-9._-]{2,39}$/, 'ชื่อผู้ใช้ 3-40 ตัว ใช้ a-z 0-9 . _ - และขึ้นต้นด้วยตัวอักษรหรือตัวเลข');
export const CreateStaff = z.object({
  email: Username,
  name: Name,
  role: z.enum(['teacher', 'admin']).default('teacher'),
}).strict();
export const SetActive = z.object({ active: z.boolean() }).strict();
export const CreateClassroom = z.object({ name: Name, teacherId: z.uuid() }).strict();
export const AssignTeacher = z.object({ teacherId: z.uuid() }).strict();
export const AuditQuery = z.object({ before: z.coerce.number().int().positive().optional() });

// PDPA: เก็บแค่รหัสนักเรียนและชื่อ (ไม่รับคอลัมน์อื่น)
export const ImportStudents = z.object({
  rows: z.array(z.object({ studentCode: StudentCode, name: Name, password: z.string().trim().max(128).refine((v) => v === '' || [...v].length >= 6, 'รหัสผ่านเริ่มต้นต้องยาวอย่างน้อย 6 ตัว').optional() }).strict()).min(1).max(1000)
    .refine((rows) => new Set(rows.map((r) => r.studentCode)).size === rows.length, 'มีรหัสนักเรียนซ้ำในไฟล์'),
}).strict();

export const OpenCompanies = z.object({
  name: z.string().trim().min(1).max(120),
  mode: z.enum(['practice', 'submit']).default('practice'),
}).strict();

// รหัสห้อง: 6 ตัวจากชุดที่อ่านไม่สับสน (ตรงกับ check ใน DB) พิมพ์ตัวเล็ก/มีช่องว่างได้
export const JoinCodeChars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const JoinClassroom = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-HJ-NP-Z2-9]{6}$/, 'รหัสห้องมี 6 ตัว (ตัวอักษรอังกฤษและตัวเลข)'),
}).strict();
export const SetJoinCode = z.object({ enabled: z.boolean() }).strict();
export const WorksheetFormats = z.object({ formats: z.array(z.union([z.literal(6), z.literal(8), z.literal(10)])).max(3) }).strict();

// ผู้ดูแลตั้งรหัสเองได้ (ว่าง = สุ่ม) ผู้ใช้ยังต้องเปลี่ยนเองเมื่อเข้าครั้งแรก
export const ResetPassword = z.object({
  password: z.string().trim().max(128).refine((v) => v === '' || [...v].length >= 6, 'รหัสผ่านต้องยาวอย่างน้อย 6 ตัว').optional(),
}).strict();
