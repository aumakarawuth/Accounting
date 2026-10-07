import { z } from 'zod';

export const Login = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('student'), identifier: z.string().trim().regex(/^[0-9A-Za-z-]{1,20}$/), password: z.string().min(1).max(256) }).strict(),
  z.object({ kind: z.literal('staff'), identifier: z.string().trim().toLowerCase().pipe(z.email().max(254)), password: z.string().min(1).max(256) }).strict(),
]);

export const ChangePassword = z
  .object({ currentPassword: z.string().max(256).optional(), newPassword: z.string().max(512) })
  .strict();

export const StudentParams = z.object({ studentId: z.uuid() });

export const UserParams = z.object({ userId: z.uuid() });
export const ClassroomParams = z.object({ classroomId: z.uuid() });

const Name = z.string().trim().min(1).max(120);
export const StudentCode = z.string().trim().regex(/^[0-9A-Za-z-]{1,20}$/, 'รหัสนักเรียนใช้ได้เฉพาะตัวเลข ตัวอักษรอังกฤษ และขีด');

export const CreateStaff = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  name: Name,
  role: z.enum(['teacher', 'admin']).default('teacher'),
}).strict();
export const SetActive = z.object({ active: z.boolean() }).strict();
export const CreateClassroom = z.object({ name: Name, teacherId: z.uuid() }).strict();
export const AssignTeacher = z.object({ teacherId: z.uuid() }).strict();
export const AuditQuery = z.object({ before: z.coerce.number().int().positive().optional() });

// PDPA: เก็บแค่รหัสนักเรียนและชื่อ (ไม่รับคอลัมน์อื่น)
export const ImportStudents = z.object({
  rows: z.array(z.object({ studentCode: StudentCode, name: Name }).strict()).min(1).max(1000)
    .refine((rows) => new Set(rows.map((r) => r.studentCode)).size === rows.length, 'มีรหัสนักเรียนซ้ำในไฟล์'),
}).strict();
