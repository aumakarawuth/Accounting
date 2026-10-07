import { z } from 'zod';

export const Login = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('student'), identifier: z.string().trim().regex(/^[0-9A-Za-z-]{1,20}$/), password: z.string().min(1).max(256) }).strict(),
  z.object({ kind: z.literal('staff'), identifier: z.string().trim().toLowerCase().pipe(z.email().max(254)), password: z.string().min(1).max(256) }).strict(),
]);

export const ChangePassword = z
  .object({ currentPassword: z.string().max(256).optional(), newPassword: z.string().max(512) })
  .strict();

export const StudentParams = z.object({ studentId: z.uuid() });
