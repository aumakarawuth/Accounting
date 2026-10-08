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
export const patchJson = <T>(path: string, data: unknown) =>
  api<T>(path, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });

export type Me = { id: string; role: 'admin' | 'teacher' | 'student' | 'ta'; displayName: string; studentCode: string | null; mustChange: boolean };
export type WorkStatus = 'draft' | 'submitted' | 'reviewing' | 'returned' | 'passed' | 'closed';
export type Company = { id: string; name: string; version: number; can_write: boolean; mode: 'practice' | 'submit'; status: WorkStatus | null; locked: boolean };
export type Account = { code: string; name: string; type: string; normal_side: 'debit' | 'credit' };
export type EntryRow = { id: string; doc_no: string; date: string; description: string; total: string; reverses_doc_no: string | null; comments: number };
export type Classroom = { id: string; name: string; joinCode: string | null; students: { id: string; studentCode: string; name: string; companies: number }[] };
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
export type LiveRow = {
  studentId: string; studentCode: string; name: string; companyId: string | null; companyName: string | null;
  page: string | null; draftDebit: string | null; draftCredit: string | null; draftLines: number | null;
  presenceAt: string | null; lastSeenAt: string | null; lastPostedAt: string | null; now: string;
};
export type LiveCompany = {
  company: { id: string; name: string };
  presence: null | {
    page: string; updatedAt: string; draftDebit: string | null; draftCredit: string | null; draftLines: number | null;
    draft: null | { date?: string; description?: string; lines: { account_code: string; debit: string; credit: string }[] };
  };
  entries: { id: string; docNo: string; date: string; description: string; total: string; reversal: boolean; postedAt: string }[];
};
export type JournalEntry = {
  id: string; docNo: string; date: string; description: string; total: string; postedAt: string; periodClosed: boolean;
  reverses: { id: string; docNo: string } | null; reversedBy: { id: string; docNo: string } | null;
  lines: { lineNo: number; code: string; name: string; debit: string; credit: string; memo: string }[];
  comments: EntryComment[];
};
export type EntryComment = { id: string; lineNo: number | null; body: string; at: string; authorName: string | null; mine: boolean };
export type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
export type ChartRow = { code: string; name: string; type: AccountType; normalSide: 'debit' | 'credit'; active: boolean; version: number; used: boolean };
export type CompanyProfile = {
  name: string; taxId: string | null; branchNo: string; address: string; vatRegistered: boolean; vatRate: string;
  version: number; canEdit: boolean; locked: boolean;
};
export type WhtKind = 'transport' | 'advertising' | 'service' | 'professional' | 'rent' | 'other';
export type Party = {
  code: string; name: string; isCustomer: boolean; isVendor: boolean; taxId: string | null; branchNo: string; address: string;
  vatRegistered: boolean; creditDays: number; whtKind: WhtKind | null; whtRate: string | null; active: boolean; version: number;
};
export type Item = {
  code: string; name: string; unit: string; isService: boolean; salePrice: string | null; purchasePrice: string | null;
  salesAccount: string | null; purchaseAccount: string | null; active: boolean; version: number;
};
export type SalesKindSql = 'sales_invoice' | 'cash_sale' | 'receipt' | 'credit_note' | 'debit_note';
export type SalesFormData = {
  company: { name: string; taxId: string | null; branchNo: string; address: string; vatRegistered: boolean; vatRate: string; canWrite: boolean; locked: boolean };
  customers: { code: string; name: string; creditDays: number; vatRegistered: boolean; taxId: string | null; branchNo: string; address: string }[];
  items: { code: string; name: string; unit: string; isService: boolean; salePrice: string | null; salesAccount: string | null }[];
  revenueAccounts: { code: string; name: string }[];
  cashAccounts: { code: string; name: string }[];
};
export type SalesRow = {
  id: string; kind: SalesKindSql; docNo: string; date: string; partyCode: string; partyName: string; isService: boolean; isTaxInvoice: boolean;
  priceMode: 'exclusive' | 'inclusive' | 'none'; vatRate: string; gross: string; discount: string; base: string; vat: string; total: string;
  whtAmount: string; creditDays: number | null; dueDate: string | null; refDocumentId: string | null; reason: string | null; description: string;
  voidedAt: string | null; voidReason: string | null; open: string | null;
};
export type SalesDocument = SalesRow & {
  partyTaxId: string | null; partyBranchNo: string; partyAddress: string; sellerName: string; sellerTaxId: string | null; sellerBranchNo: string;
  sellerAddress: string; cashAccount: string | null; entryId: string; entryDocNo: string; voidDocNo: string | null; refDocNo: string | null;
  lines: { lineNo: number; description: string; qty: string; unit: string; unitPrice: string; amount: string; accountCode: string; accountName: string }[];
  settles: { id: string; docNo: string; amount: string; vatTransfer: string }[];
  settledBy: { id: string; kind: SalesKindSql; docNo: string; date: string; amount: string; voided: boolean }[];
  notes: { id: string; kind: SalesKindSql; docNo: string; total: string; voided: boolean }[];
};
export type AgingBucket = 'current' | 'd30' | 'd60' | 'd90' | 'over90';
export type PurchaseKindSql = 'purchase_invoice' | 'cash_purchase' | 'purchase_credit_note' | 'payment';
export type PurchaseFormData = {
  company: { name: string; taxId: string | null; branchNo: string; address: string; vatRegistered: boolean; vatRate: string; canWrite: boolean; locked: boolean };
  vendors: { code: string; name: string; creditDays: number; vatRegistered: boolean; taxId: string | null; branchNo: string; address: string; whtKind: WhtKind | null; whtRate: string | null }[];
  items: { code: string; name: string; unit: string; isService: boolean; purchasePrice: string | null; purchaseAccount: string | null }[];
  expenseAccounts: { code: string; name: string }[];
  cashAccounts: { code: string; name: string }[];
  systemAccounts: { code: string; name: string }[];
};
export type PurchaseRow = {
  id: string; kind: PurchaseKindSql; docNo: string; date: string; vendorDocNo: string | null; partyCode: string; partyName: string;
  isService: boolean; vatClaimable: boolean; priceMode: 'exclusive' | 'inclusive' | 'none'; vatRate: string;
  gross: string; discount: string; base: string; vat: string; total: string;
  whtKind: WhtKind | null; whtRate: string | null; whtBase: string; whtAmount: string;
  creditDays: number | null; dueDate: string | null; refDocumentId: string | null; reason: string | null; description: string;
  voidedAt: string | null; voidReason: string | null; open: string | null;
  /** ภาษีซื้อบริการที่ยังไม่ถึงกำหนด (มีเฉพาะในรายการ ใช้คิดภาษีที่โอนตอนจ่าย) */
  undueVat?: string;
};
export type WhtCertificate = {
  certNo: string; date: string; form: 'pnd3' | 'pnd53'; payerName: string; payerTaxId: string | null; payerBranchNo: string; payerAddress: string;
  payeeName: string; payeeTaxId: string; payeeBranchNo: string; payeeAddress: string; whtKind: WhtKind; whtRate: string; base: string; amount: string; voided: boolean;
};
export type PurchaseDocument = PurchaseRow & {
  partyTaxId: string | null; partyBranchNo: string; partyAddress: string;
  companyName: string; companyTaxId: string | null; companyBranchNo: string; companyAddress: string;
  cashAccount: string | null; cashAccountName: string | null; entryId: string; entryDocNo: string; voidDocNo: string | null; refDocNo: string | null;
  lines: { lineNo: number; description: string; qty: string; unit: string; unitPrice: string; amount: string; accountCode: string; accountName: string }[];
  settles: { id: string; docNo: string; vendorDocNo: string | null; amount: string; vatTransfer: string }[];
  settledBy: { id: string; kind: PurchaseKindSql; docNo: string; date: string; amount: string; voided: boolean }[];
  notes: { id: string; kind: PurchaseKindSql; docNo: string; total: string; voided: boolean }[];
  certificate: WhtCertificate | null;
};
export type Payables = Omit<Receivables, 'items'> & {
  items: { id: string; docNo: string; vendorDocNo: string; date: string; dueDate: string; partyCode: string; partyName: string; total: string; open: string; daysOverdue: number; bucket: AgingBucket }[];
};
export type Receivables = {
  asOf: string;
  items: { id: string; docNo: string; kind: SalesKindSql; date: string; dueDate: string; partyCode: string; partyName: string; total: string; open: string; daysOverdue: number; bucket: AgingBucket }[];
  totals: Record<'all' | AgingBucket, string>;
  byParty: ({ partyCode: string; partyName: string } & Record<'all' | AgingBucket, string>)[];
};
export type Periods = {
  canClose: boolean; canReopen: boolean; locked: boolean;
  periods: { month: string; closed: boolean; closedAt: string | null; entries: number }[];
};
