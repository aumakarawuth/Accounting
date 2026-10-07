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
export type WorkStatus = 'draft' | 'submitted' | 'reviewing' | 'returned' | 'passed' | 'closed';
export type Company = { id: string; name: string; version: number; can_write: boolean; mode: 'practice' | 'submit'; status: WorkStatus | null; locked: boolean };
export type Account = { code: string; name: string; type: string; normal_side: 'debit' | 'credit' };
export type EntryRow = { id: string; doc_no: string; date: string; description: string; total: string; reverses_doc_no: string | null };
export type Classroom = { id: string; name: string; students: { id: string; studentCode: string; name: string; companies: number }[] };
export type Alert = { id: number; kind: 'locked'; at: string; studentCode: string; name: string };
export type Staff = { id: string; email: string; name: string; role: 'teacher' | 'admin' | 'ta'; active: boolean; classrooms: number };
export type AdminClassroom = { id: string; name: string; teacherId: string; teacherName: string; students: number };
export type AuditRow = {
  id: number; at: string; table: string; op: string; rowPk: string | null; client: string | null;
  userName: string | null; userCode: string | null; changed: string[] | null; detail: Record<string, unknown> | null;
  target: string | null;
};
export type TrialBalance = {
  month: string;
  rows: { code: string; name: string; type: string; normalSide: 'debit' | 'credit'; debit: string; credit: string }[];
  totalDebit: string; totalCredit: string;
};
export type LedgerAccount = { code: string; name: string; normalSide: 'debit' | 'credit'; opening: string; debit: string; credit: string; closing: string };
export type Ledger = {
  month: string;
  account: { code: string; name: string; type: string; normalSide: 'debit' | 'credit' };
  opening: string; closing: string; totalDebit: string; totalCredit: string;
  lines: { date: string; docNo: string; description: string; memo: string; debit: string; credit: string; balance: string; reversal: boolean }[];
};
export type MyCompany = { id: string; name: string; classroom: string | null };
type Line = { code: string; name: string; amount: string };
export type Statements = {
  month: string; scope: 'month' | 'ytd'; from: string;
  revenue: Line[]; expense: Line[]; assets: Line[]; liabilities: Line[]; equity: Line[];
  totalRevenue: string; totalExpense: string; netIncome: string; unclosedProfit: string;
  totalAssets: string; totalLiabilities: string; totalEquity: string; totalLiabilitiesEquity: string; balanced: boolean;
};
export type SubmissionEvent = { id: number; at: string; action: string; from: string; to: string; round: number; note: string | null; score: string | null; actorName: string | null; byOwner: boolean };
export type Submission = { mode: 'practice' | 'submit'; status: WorkStatus | null; round: number; score: string | null; maxScore: string; events: SubmissionEvent[] };
export type TeacherSubmission = { companyId: string; company: string; classroom: string; studentCode: string; studentName: string; status: WorkStatus; round: number; score: string | null; maxScore: string; updatedAt: string };
