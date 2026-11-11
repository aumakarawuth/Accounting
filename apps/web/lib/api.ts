import { th } from '@/i18n/th';

// เรียกจากเบราว์เซอร์ผ่าน /api (Next rewrite ไป API ที่ origin เดียวกัน cookie จึงติดไปเอง)
export type ApiError = { status: number; code: string; message: string; ref?: string; [k: string]: unknown };

/** เน็ตหลุดระหว่างส่ง (fetch โยน TypeError ข้อความอังกฤษของเบราว์เซอร์) → ApiError ข้อความไทยรูปแบบเดียวกับ error จาก API
 *  คำขอที่มี idempotency-key ส่งใหม่ด้วยคีย์เดิมได้ปลอดภัย (ถ้าเซิร์ฟเวอร์บันทึกไปแล้วได้ผลเดิม) */

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { cache: 'no-store', credentials: 'same-origin', ...init });
  } catch {
    throw { status: 0, code: 'network', message: th.error.network } as ApiError;
  }
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
export type Company = { id: string; name: string; version: number; can_write: boolean; mode: 'practice' | 'submit'; status: WorkStatus | null; locked: boolean; assignment: CompanyAssignment | null };
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
  stage: 'before' | 'after'; fiscalYear: FiscalYearRange; closingDocNos: string[]; priorYearUnclosed: boolean;
};
export type FiscalYearRange = { start: string; end: string };
export type FiscalYearClosing = { closedAt: string; netIncome: string; docNo: string | null };
export type FiscalYears = {
  startMonth: number; version: number; canClose: boolean; locked: boolean; canChangeStart: boolean;
  years: { start: string; end: string; entries: number; closing: FiscalYearClosing | null; reopened: (FiscalYearClosing & { reopenedAt: string })[] }[];
};
export type YearClosingPreview = { yearEnd: string; lines: { code: string; name: string; debit: string; credit: string }[]; netIncome: string; totalDebit: string };
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
  fiscalYear: FiscalYearRange; yearProfit: string; priorUnclosedProfit: string;
  multiStep: IncomeMultiStep; classified: ClassifiedPosition;
  totalAssets: string; totalLiabilities: string; totalEquity: string; totalLiabilitiesEquity: string; balanced: boolean;
};
export type CostOfSales = {
  opening: string; purchases: string; discounts: string; returns: string; otherCosts: Line[];
  netPurchases: string; available: string; closing: string; adjustments: string; total: string;
};
export type IncomeMultiStep = {
  sales: Line[]; netSales: string; costOfSales: CostOfSales | null; grossProfit: string;
  otherIncome: Line[]; totalOtherIncome: string; sellingAdmin: Line[]; totalSellingAdmin: string;
  otherExpenses: Line[]; totalOtherExpenses: string; profitBeforeFinance: string;
  financeCosts: Line[]; totalFinanceCosts: string; profitBeforeTax: string; incomeTax: Line[]; totalIncomeTax: string; netIncome: string;
};
export type ClassifiedPosition = {
  currentAssets: Line[]; totalCurrentAssets: string; nonCurrentAssets: Line[]; totalNonCurrentAssets: string;
  currentLiabilities: Line[]; totalCurrentLiabilities: string; nonCurrentLiabilities: Line[]; totalNonCurrentLiabilities: string;
};
export type EndingInventory = { month: string; glBalance: string; perpetual: boolean; canWrite: boolean };
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
    draft: null | { title?: string; date?: string; description?: string; lines: { account_code: string; debit: string; credit: string }[] };
  };
  entries: { id: string; docNo: string; date: string; description: string; total: string; reversal: boolean; postedAt: string }[];
};
export type JournalEntry = {
  id: string; docNo: string; date: string; description: string; total: string; postedAt: string; periodClosed: boolean;
  /** ลงจากสมุดรายวันเอง (JV/AJ) แก้/กลับรายการได้ · false = มาจากเอกสาร/ทะเบียน ต้องยกเลิกที่ตัวเอกสาร */
  manual: boolean;
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
  code: string; name: string; unit: string; isService: boolean; trackInventory: boolean; salePrice: string | null; purchasePrice: string | null;
  salesAccount: string | null; purchaseAccount: string | null; active: boolean; version: number;
};
export type InventoryItem = { code: string; name: string; unit: string; active: boolean; quantity: string; value: string; unitCost: string };
export type InventoryOverview = {
  company: { name: string; canWrite: boolean; locked: boolean };
  items: InventoryItem[]; totalValue: string; glBalance: string; accounts: { code: string; name: string }[];
};
export type StockCardRow = {
  date: string; kind: string; reference: string; entryId: string; entryDocNo: string; qtyIn: string; qtyOut: string; unitCost: string;
  valueIn: string; valueOut: string; balanceQty: string; balanceValue: string;
  restated: boolean;
};
export type StockCard = { item: { code: string; name: string; unit: string; trackInventory: boolean }; card: StockCardRow[] };
export type SalesKindSql = 'sales_invoice' | 'cash_sale' | 'receipt' | 'credit_note' | 'debit_note' | 'deposit' | 'deposit_applied';
export type SalesFormData = {
  company: { name: string; taxId: string | null; branchNo: string; address: string; vatRegistered: boolean; vatRate: string; canWrite: boolean; locked: boolean };
  customers: { code: string; name: string; creditDays: number; vatRegistered: boolean; taxId: string | null; branchNo: string; address: string }[];
  items: { code: string; name: string; unit: string; isService: boolean; trackInventory: boolean; salePrice: string | null; salesAccount: string | null }[];
  revenueAccounts: { code: string; name: string }[];
  cashAccounts: { code: string; name: string }[];
};
export type SalesRow = {
  id: string; kind: SalesKindSql; docNo: string; date: string; partyCode: string; partyName: string; isService: boolean; isTaxInvoice: boolean;
  priceMode: 'exclusive' | 'inclusive' | 'none'; vatRate: string; gross: string; discount: string; base: string; vat: string; total: string;
  whtAmount: string; creditDays: number | null; dueDate: string | null; refDocumentId: string | null; reason: string | null; description: string;
  voidedAt: string | null; voidReason: string | null; open: string | null;
  /** ภาษีขายบริการที่ยังไม่ถึงกำหนด (มีเฉพาะในรายการ) */
  undueVat?: string;
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
export type PurchaseKindSql = 'purchase_invoice' | 'cash_purchase' | 'purchase_credit_note' | 'payment'
  | 'goods_receipt' | 'purchase_debit_note' | 'deposit' | 'deposit_applied';
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
  refKind: PurchaseKindSql | null; depositRemaining: string | null; order: { id: string; docNo: string } | null;
  lines: {
    lineNo: number; itemCode: string | null; description: string; qty: string; unit: string; unitPrice: string; amount: string;
    accountCode: string; accountName: string; invoiced: string;
  }[];
  /** ใบรับสินค้า ↔ ใบซื้อ ที่จับคู่กัน (docNo = เอกสารอีกฝั่ง) */
  matches: { id: string; docNo: string; invoiceLineNo: number; receiptLineNo: number; qty: string; amount: string; voided: boolean }[];
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

// ---- เฟส 2.4 ภาษี ----
export type VatRow = {
  date: string; documentId: string; docNo: string; refNo: string | null; kind: string; partyName: string; partyTaxId: string | null;
  partyBranchNo: string; base: string; vat: string; status: 'normal' | 'voided' | 'void_reversal';
};
export type VatClosing = {
  id: string; month: string; outputVat: string; inputVat: string; carryUsed: string; payable: string; refundable: string;
  entryDocNo: string | null; entryId: string | null; paidDocNo: string | null; paidDate: string | null; paidEntryId: string | null;
  voidedAt: string | null; voidReason: string | null; voidDocNo: string | null; createdAt: string;
};
export type TaxCompany = { name: string; taxId: string | null; branchNo: string; address: string; vatRegistered: boolean; canWrite: boolean; locked: boolean };
export type VatReport = {
  month: string; company: TaxCompany; sales: VatRow[]; purchases: VatRow[]; closing: VatClosing | null;
  preview: { outputVat: string; inputVat: string; carryAvailable: string; carryUsed: string; payable: string; refundable: string; earlierOpen: boolean; laterClosed: boolean };
  history: VatClosing[]; cashAccounts: { code: string; name: string }[];
};
export type WhtCertRow = {
  certNo: string; date: string; form: 'pnd3' | 'pnd53'; documentId: string; docNo: string; payeeName: string; payeeTaxId: string;
  payeeBranchNo: string; payeeAddress: string; whtKind: string; whtRate: string; base: string; amount: string; voided: boolean;
};
export type WhtRemittance = { id: string; form: string; amount: string; certCount: number; entryDocNo: string; entryId: string; date: string };
export type WhtReport = {
  month: string; company: TaxCompany; certificates: WhtCertRow[];
  forms: { form: 'pnd3' | 'pnd53'; count: number; base: string; amount: string; remittance: WhtRemittance | null }[];
  cashAccounts: { code: string; name: string }[];
};

// ---- กระดาษทำการ ----
export type WsPair = { debit: string; credit: string };
export type WorksheetRow = { code: string; name: string; type: string; tb: WsPair; adj: WsPair; atb: WsPair; is: WsPair | null; bs: WsPair | null };
export type Worksheet = {
  month: string; formats: number[]; format: number | null; rows?: WorksheetRow[];
  totals?: { tb: WsPair; adj: WsPair; atb: WsPair; is: WsPair; bs: WsPair };
  netIncome?: string; result?: { is: WsPair; bs: WsPair }; grand?: { is: WsPair; bs: WsPair };
  fiscalYear?: FiscalYearRange; priorYearUnclosed?: boolean;
};

// ---- เฟส 3.3 เช็ค ----
export type ChequeStatus = 'on_hand' | 'deposited' | 'issued' | 'cleared' | 'bounced' | 'cancelled';
export type ChequeRow = {
  id: string; direction: 'received' | 'paid'; chequeNo: string; bankName: string; bankBranch: string; chequeDate: string; issueDate: string;
  amount: string; partyName: string; holdingCode: string; bankCode: string | null; counterCode: string | null; status: ChequeStatus;
  statusDate: string; depositCode: string | null; documentId: string | null; documentNo: string | null; entryId: string; entryDocNo: string;
  statusEntryId: string | null; statusDocNo: string | null; postdated: boolean; description: string;
};
export type CodeName = { code: string; name: string };
export type ChequePage = {
  company: { name: string; canWrite: boolean; locked: boolean };
  cheques: ChequeRow[]; bankAccounts: CodeName[]; accounts: CodeName[];
};

// ---- เฟส 3.4 สินทรัพย์ถาวร ----
export type AssetStatus = 'active' | 'fully_depreciated' | 'disposed' | 'voided';
export type AssetRow = {
  id: string; code: string; name: string; acquiredDate: string; depStart: string; cost: string; salvage: string; lifeMonths: number;
  monthly: string; assetCode: string; accumCode: string; expenseCode: string; monthsPosted: number; accumulated: string;
  depThisMonth: string; bookValue: string; status: AssetStatus; disposalId: string | null; disposalDate: string | null;
  proceeds: string | null; gainLoss: string | null; entryId: string | null; disposalEntryId: string | null; nextMonth: string | null;
};
export type DepreciationRunRow = { id: string; month: string; entryId: string | null; docNo: string | null; date: string | null; amount: string; lines: number; voided: boolean; voidDocNo: string | null };
export type AssetPage = {
  company: { name: string; canWrite: boolean; locked: boolean };
  month: string; assets: AssetRow[]; runs: DepreciationRunRow[];
  assetAccounts: CodeName[]; expenseAccounts: CodeName[]; accounts: CodeName[];
};

// ---- เฟส 4 โจทย์ / มอบหมาย / สอบ / สาธิต ----
export type AssignmentMode = 'practice' | 'submit' | 'exam' | 'demo';
export type Feedback = 'none' | 'score' | 'items' | 'answers';
export type Reveal = 'anytime' | 'after_submit' | 'after_release';
export type LockReason = 'submitted' | 'closed' | 'not_open' | 'exam_not_started' | 'exam_over';
export type CompanyAssignment = {
  id: string; mode: AssignmentMode; title: string; startedAt: string | null; deadline: string | null; closesAt: string | null;
  lockReason: LockReason | null; now: string;
};
export type ExerciseLine = { account_code: string; debit?: string | null; credit?: string | null };
export type ExerciseItem = { no?: number; date: string; narrative: string; points: string; lines: ExerciseLine[] };
export type ExerciseSetSummary = { id: string; title: string; companyName: string; version: number; updatedAt: string; items: number; points: string; assignments: number };
export type AssignmentSummary = {
  id: string; mode: AssignmentMode; title: string; companyName: string; classroom: string | null; createdAt: string;
  releasedAt: string | null; closedAt: string | null; durationMinutes: number | null; companies: number; demoCompanyId: string | null;
};
export type ExerciseSetDetail = {
  id: string; title: string; companyName: string; description: string; version: number; updatedAt: string;
  items: (ExerciseItem & { no: number })[];
  assignments: { id: string; mode: AssignmentMode; classroom: string | null; companyName: string; createdAt: string; closedAt: string | null; demoCompanyId: string | null }[];
  classrooms: { id: string; name: string }[];
};
export type ItemStatus = 'correct' | 'wrong' | 'date' | 'missing';
export type GradeItem = {
  no: number; status: ItemStatus; points: string; earned: string; entryId: string | null; docNo: string | null; entryDate: string | null;
  missing?: string[]; extra?: string[];
};
export type AssignmentInfo = {
  id: string; mode: AssignmentMode; title: string; feedback: Feedback; reveal: Reveal; checkDate: boolean;
  opensAt: string | null; closesAt: string | null; durationMinutes: number | null; releasedAt: string | null; closedAt: string | null;
};
export type AssignmentView = {
  assignment: AssignmentInfo;
  attempt: { startedAt: string; deadline: string } | null;
  now: string;
  lockReason: LockReason | null;
  viewer: 'teacher' | 'student';
  itemsVisible: boolean;
  items: { no: number; date: string; narrative: string; points: string; answer: { code: string; debit: string; credit: string }[] | null }[] | null;
  result: null | {
    level: Exclude<Feedback, 'none'>; score: string; maxScore: string; correct: number; total: number;
    items?: GradeItem[]; extraEntries?: { id: string; docNo: string; date: string }[];
    answers?: { no: number; lines: { code: string; debit: string; credit: string }[] }[];
  };
  resultHidden: 'teacher_only' | Reveal | null;
};
export type OverviewStudent = {
  studentId: string; studentCode: string; name: string; companyId: string | null; companyName: string | null; status: WorkStatus | null;
  teacherScore: string | null; maxScore: string | null; startedAt: string | null; deadline: string | null; extraMinutes: number | null;
  lockReason: LockReason | null; entries: number;
  grade: null | { score: string; maxScore: string; correct: number; extra: number; items: { no: number; status: ItemStatus; earned: string }[] };
};
export type AssignmentOverview = {
  assignment: AssignmentInfo & { companyName: string; setId: string | null; classroomId: string | null; classroom: string | null; createdAt: string };
  items: { no: number; date: string; narrative: string; points: string }[];
  students: OverviewStudent[];
  now: string;
};

// ---- เฟส 5 โมดูล 3: ยอดยกมา ----
export type OpeningItem = { docNo: string; ref?: string; partyCode: string; partyName: string; date: string; dueDate: string; amount: string; undueVat: string };
export type OpeningData = {
  opening: null | {
    id: string; date: string; entryId: string; docNo: string; total: string; createdAt: string;
    receivables: OpeningItem[]; payables: OpeningItem[];
    assets: { code: string; name: string; cost: string; accumulated: string; months: number }[];
    inventory: { itemCode: string; name: string; qty: string; unitCost: string; value: string }[];
  };
  canWrite: boolean; vatRegistered: boolean; firstEntryDate: string | null;
  accounts: { code: string; name: string; type: string }[];
  customers: { code: string; name: string; creditDays: number }[];
  vendors: { code: string; name: string; creditDays: number }[];
  items: { code: string; name: string; unit: string }[];
};

// ---- เฟส 5 โมดูล 4: ใบเสนอราคา ใบสั่งขาย เงินมัดจำ ใบวางบิล ----
export type OrderKind = 'quotation' | 'sales_order';
export type OrderStatus = 'open' | 'expired' | 'accepted' | 'partial' | 'closed' | 'cancelled';
export type SalesOrderRow = {
  id: string; kind: OrderKind; docNo: string; date: string; untilDate: string | null; partyCode: string; partyName: string;
  isService: boolean; priceMode: 'exclusive' | 'inclusive' | 'none'; vatRate: string; gross: string; discount: string; base: string;
  vat: string; total: string; description: string; cancelReason: string | null; status: OrderStatus;
};
export type SalesOrderDetail = SalesOrderRow & {
  partyTaxId: string | null; partyBranchNo: string; partyAddress: string;
  sellerName: string; sellerTaxId: string | null; sellerBranchNo: string; sellerAddress: string;
  source: { id: string; docNo: string } | null;
  lines: { lineNo: number; itemCode: string | null; description: string; qty: string; unit: string; unitPrice: string; amount: string; delivered: string }[];
  invoices: { id: string; docNo: string; date: string; total: string; voided: boolean }[];
  deposits: { id: string; docNo: string; date: string; total: string; voided: boolean; remaining: string }[];
  orders: { id: string; docNo: string; cancelled: boolean }[];
};
export type OpenDeposit = { id: string; docNo: string; date: string; partyCode: string; partyName: string; total: string; vat: string; remaining: string; orderDocNo: string | null; orderId: string | null };
export type BillingNoteRow = { id: string; docNo: string; date: string; dueDate: string; partyCode: string; partyName: string; total: string; description: string; cancelReason: string | null; open: string; status: 'open' | 'paid' | 'cancelled' };
export type BillingNoteDetail = BillingNoteRow & {
  partyTaxId: string | null; partyBranchNo: string; partyAddress: string;
  sellerName: string; sellerTaxId: string | null; sellerBranchNo: string; sellerAddress: string;
  items: { id: string; docNo: string; date: string; dueDate: string; amount: string; open: string }[];
};

// ---- เฟส 5 โมดูล 5: ใบสั่งซื้อ ใบรับสินค้า เงินมัดจำจ่าย ----
export type PurchaseOrderStatus = 'open' | 'partial' | 'closed' | 'cancelled';
export type PurchaseOrderRow = {
  id: string; docNo: string; date: string; untilDate: string | null; partyCode: string; partyName: string; isService: boolean;
  priceMode: 'exclusive' | 'inclusive' | 'none'; vatRate: string; gross: string; discount: string; base: string; vat: string; total: string;
  description: string; cancelReason: string | null; status: PurchaseOrderStatus;
};
export type PurchaseOrderDetail = PurchaseOrderRow & {
  partyTaxId: string | null; partyBranchNo: string; partyAddress: string;
  buyerName: string; buyerTaxId: string | null; buyerBranchNo: string; buyerAddress: string;
  lines: { lineNo: number; itemCode: string | null; isService: boolean | null; description: string; qty: string; unit: string; unitPrice: string; amount: string; received: string }[];
  documents: { id: string; kind: PurchaseKindSql; docNo: string; date: string; total: string; voided: boolean }[];
  deposits: { id: string; docNo: string; date: string; total: string; voided: boolean; remaining: string }[];
};
export type OpenReceiptLine = {
  receiptId: string; docNo: string; vendorDocNo: string; date: string; partyCode: string; lineNo: number; itemCode: string;
  description: string; unit: string; qty: string; unitPrice: string; amount: string; account: string; remaining: string; remainingAmount: string;
};
export type OpenPurchaseDeposit = {
  id: string; docNo: string; vendorDocNo: string; date: string; partyCode: string; partyName: string; total: string; vat: string;
  remaining: string; remainingVat: string; orderDocNo: string | null; orderId: string | null;
};
