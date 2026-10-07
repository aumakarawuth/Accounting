// เรียกจากเบราว์เซอร์ผ่าน /api (Next rewrite ไป API ที่ origin เดียวกัน cookie จึงติดไปเอง)
export type ApiError = { status: number; code: string; message: string; ref?: string; [k: string]: unknown };

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, { cache: 'no-store', credentials: 'same-origin', ...init });
  const body = await res.json().catch(() => ({ code: 'server', message: 'server' }));
  if (!res.ok) throw { status: res.status, ...body } as ApiError;
  return body as T;
}

export const postJson = <T>(path: string, data: unknown, headers: Record<string, string> = {}) =>
  api<T>(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(data) });

export type Me = { id: string; role: 'admin' | 'teacher' | 'student' | 'ta'; displayName: string; studentCode: string | null; mustChange: boolean };
export type Company = { id: string; name: string; version: number; can_write: boolean };
export type Account = { code: string; name: string; type: string; normal_side: 'debit' | 'credit' };
export type EntryRow = { id: string; doc_no: string; date: string; description: string; total: string; reverses_doc_no: string | null };
export type Classroom = { id: string; name: string; students: { id: string; studentCode: string; name: string }[] };
export type Alert = { id: number; kind: 'locked'; at: string; studentCode: string; name: string };
