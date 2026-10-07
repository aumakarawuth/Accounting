// ฝั่งเซิร์ฟเวอร์ (Server Component) เรียก API ตรง; ฝั่งเบราว์เซอร์เรียก /api (rewrite)
const base = typeof window === 'undefined' ? (process.env.API_URL ?? 'http://127.0.0.1:4000') : '/api';

export type ApiError = { status: number; code: string; message: string; ref?: string };

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${base}${path}`, { cache: 'no-store', ...init });
  const body = await res.json().catch(() => ({ code: 'server', message: 'server' }));
  if (!res.ok) throw { status: res.status, ...body } as ApiError;
  return body as T;
}

export type Company = { id: string; name: string; version: number; can_write: boolean };
export type Account = { code: string; name: string; type: string; normal_side: 'debit' | 'credit' };
export type EntryRow = { id: string; doc_no: string; date: string; description: string; total: string; reverses_doc_no: string | null };
