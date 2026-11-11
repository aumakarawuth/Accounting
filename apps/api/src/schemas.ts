import { z } from 'zod';

// เงินเป็นสตริงทศนิยมเสมอ ห้าม number (กัน float ทุกชั้น)
export const Money = z.string().regex(/^\d{1,16}(\.\d{1,2})?$/, 'จำนวนเงินต้องเป็นตัวเลขทศนิยมไม่เกิน 2 ตำแหน่ง');
// วันที่ต้องมีจริง (2026-02-30 / 2026-13-01 ผ่าน regex แต่ Postgres ปฏิเสธ เคยตอบ 500)
const realDate = (s: string) => {
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(Date.UTC(y!, m! - 1, d!));
  t.setUTCFullYear(y!);
  return t.getUTCFullYear() === y && t.getUTCMonth() === m! - 1 && t.getUTCDate() === d;
};
export const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'วันที่ต้องเป็น YYYY-MM-DD').refine(realDate, 'ไม่มีวันที่นี้ในปฏิทิน');
/** จำนวนเงินมีเครื่องหมาย (รายการเดินบัญชี: ฝาก +, ถอน −) */
export const SignedMoney = z.string().regex(/^-?\d{1,16}(\.\d{1,2})?$/, 'จำนวนเงินต้องเป็นตัวเลขทศนิยมไม่เกิน 2 ตำแหน่ง');
export const Uuid = z.uuid();

export const CompanyParams = z.object({ companyId: Uuid });
export const EntryParams = z.object({ companyId: Uuid, entryId: Uuid });

export const JournalLine = z
  .object({
    account_code: z.string().min(1).max(20),
    debit: Money.optional(),
    credit: Money.optional(),
    memo: z.string().max(200).optional(),
  })
  .strict();

export const PostJournal = z
  .object({
    date: IsoDate,
    description: z.string().max(500).default(''),
    lines: z.array(JournalLine).min(2).max(200),
    adjusting: z.boolean().optional(), // รายการปรับปรุง: เลขที่ชุด AJ ลงวันสิ้นเดือน
  })
  .strict();

export const Reverse = z.object({ date: IsoDate, description: z.string().max(500).optional() }).strict();

export const IdempotencyKey = z.string().min(8).max(100);

const Month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'เดือนต้องเป็น YYYY-MM');
export const MonthQuery = z.object({ month: Month.optional() });
export const TrialBalanceQuery = z.object({ month: Month, all: z.enum(['0', '1']).default('0'), stage: z.enum(['before', 'after']).default('before') });
export const YearEndParams = z.object({ companyId: z.string().uuid(), yearEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'วันที่ต้องเป็น YYYY-MM-DD') });
export const EndingInventory = z.object({
  month: Month,
  amount: z.string().regex(/^\d{1,15}(\.\d{1,2})?$/, 'มูลค่าเป็นตัวเลขไม่ติดลบ ทศนิยมไม่เกิน 2 ตำแหน่ง'),
}).strict();
export const FiscalYearStart = z.object({ month: z.number().int().min(1).max(12), version: z.number().int().positive() }).strict();
export const StatementsQuery = z.object({ month: Month, scope: z.enum(['month', 'ytd']).default('ytd') });
export const SubmissionAction = z.object({
  action: z.enum(['submit', 'review', 'return', 'pass', 'close']),
  expected: z.enum(['draft', 'submitted', 'reviewing', 'returned', 'passed', 'closed']),
  note: z.string().trim().max(2000).optional(),
  score: z.string().regex(/^\d{1,3}(\.\d{1,2})?$/, 'คะแนนต้องเป็นตัวเลข').optional(),
}).strict();
export const LedgerQuery = z.object({ month: Month, account: z.string().min(1).max(20) });

// ผังบัญชี: รหัสตัวเลข 3–10 หลัก (ตรงกับ check ใน DB) ประเภทตามหมวดบัญชี
const AccountCode = z.string().regex(/^[0-9]{3,10}$/, 'รหัสบัญชีต้องเป็นตัวเลข 3–10 หลัก');
const AccountName = z.string().trim().min(1, 'ต้องมีชื่อบัญชี').max(120);
export const AccountParams = z.object({ companyId: Uuid, code: AccountCode });
export const NewAccount = z.object({
  code: AccountCode,
  name: AccountName,
  type: z.enum(['asset', 'liability', 'equity', 'revenue', 'expense']),
}).strict();
export const EditAccount = z.object({
  name: AccountName.optional(),
  active: z.boolean().optional(),
  version: z.number().int().positive(),
}).strict();
export const PeriodParams = z.object({ companyId: Uuid, month: Month });

export const NewComment = z.object({
  lineNo: z.number().int().positive().nullable().default(null),
  body: z.string().trim().min(1, 'ต้องมีข้อความ').max(1000),
}).strict();
export const CommentParams = z.object({ companyId: Uuid, commentId: Uuid });

// ---- เฟส 2.1 ข้อมูลหลัก (ตรงกับ check ใน migration 014) ----

/** หลักตรวจสอบเลขผู้เสียภาษี 13 หลัก (สูตรเดียวกับ app.valid_tax_id) */
export function validTaxId(s: string) {
  if (!/^\d{13}$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(s[i]) * (13 - i);
  return (11 - (sum % 11)) % 10 === Number(s[12]);
}
const TaxId = z.string().trim().refine(validTaxId, 'เลขประจำตัวผู้เสียภาษีไม่ถูกต้อง (13 หลัก หลักสุดท้ายไม่ตรงหลักตรวจสอบ)');
const BranchNo = z.string().regex(/^\d{5}$/, 'สาขาต้องเป็นเลข 5 หลัก (สำนักงานใหญ่ = 00000)');
const Address = z.string().trim().max(400);
const MasterCode = z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9-]{0,19}$/, 'รหัสใช้ตัวอักษรอังกฤษ ตัวเลข และขีด ไม่เกิน 20 ตัว');
const MasterName = z.string().trim().min(1, 'ต้องมีชื่อ').max(160);
const Version = z.number().int().positive();
const Rate = z.string().regex(/^\d{1,2}(\.\d{1,2})?$/, 'อัตราต้องเป็นตัวเลข เช่น 3 หรือ 1.5');

export const CompanyProfile = z.object({
  version: Version,
  taxId: TaxId.nullable().optional(),
  branchNo: BranchNo.optional(),
  address: Address.optional(),
  vatRegistered: z.boolean().optional(),
  vatRate: Rate.optional(),
}).strict();

// อัตราหัก ณ ที่จ่ายมาตรฐาน (docs/phase2-spec.md T5) อื่น ๆ ใส่เอง
export const WHT_STANDARD = { transport: '1.00', advertising: '2.00', service: '3.00', professional: '3.00', rent: '5.00' } as const;
const WhtKind = z.enum(['transport', 'advertising', 'service', 'professional', 'rent', 'other']);

const partyFields = {
  name: MasterName,
  isCustomer: z.boolean(),
  isVendor: z.boolean(),
  taxId: TaxId.nullable(),
  branchNo: BranchNo,
  address: Address,
  vatRegistered: z.boolean(),
  creditDays: z.number().int().min(0, 'เครดิตต้องไม่ติดลบ').max(365, 'เครดิตไม่เกิน 365 วัน'),
  whtKind: WhtKind.nullable(),
  whtRate: Rate.nullable(),
};
type PartyCheck = { isCustomer?: boolean; isVendor?: boolean; vatRegistered?: boolean; taxId?: string | null; whtKind?: string | null; whtRate?: string | null };
function partyRules(p: PartyCheck, ctx: z.RefinementCtx) {
  if (p.isCustomer === false && p.isVendor === false) ctx.addIssue({ code: 'custom', path: ['isCustomer'], message: 'ต้องเป็นลูกค้าหรือผู้ขายอย่างน้อยหนึ่งอย่าง' });
  if (p.vatRegistered && !p.taxId) ctx.addIssue({ code: 'custom', path: ['taxId'], message: 'คู่ค้าที่จด VAT ต้องมีเลขประจำตัวผู้เสียภาษี' });
  if (p.whtKind === 'other' && !p.whtRate) ctx.addIssue({ code: 'custom', path: ['whtRate'], message: 'หัก ณ ที่จ่ายประเภทอื่นต้องใส่อัตรา' });
  if (p.whtRate && Number(p.whtRate) > 15) ctx.addIssue({ code: 'custom', path: ['whtRate'], message: 'อัตราหัก ณ ที่จ่ายไม่เกิน 15%' });
  if (p.whtRate && Number(p.whtRate) <= 0) ctx.addIssue({ code: 'custom', path: ['whtRate'], message: 'อัตราหัก ณ ที่จ่ายต้องมากกว่า 0' });
}
export const NewParty = z.object({ code: MasterCode, ...partyFields }).partial({
  taxId: true, branchNo: true, address: true, vatRegistered: true, creditDays: true, whtKind: true, whtRate: true,
}).strict().superRefine(partyRules);
// แก้บางช่อง: กติกาที่ข้ามช่อง (เช่น จด VAT ต้องมีเลขภาษี) ตรวจกับแถวที่รวมค่าเดิมแล้วด้วย PartyRules ใน route
export const EditParty = z.object({ version: Version, active: z.boolean(), ...partyFields }).partial().required({ version: true }).strict();
export const PartyRules = z.custom<PartyCheck>().superRefine(partyRules);
export const PartyParams = z.object({ companyId: Uuid, code: MasterCode });
export const PartyQuery = z.object({ kind: z.enum(['customer', 'vendor']).optional() });

const itemFields = {
  name: MasterName,
  unit: z.string().trim().max(20),
  isService: z.boolean(),
  trackInventory: z.boolean(),
  salePrice: Money.nullable(),
  purchasePrice: Money.nullable(),
  salesAccount: AccountCode.nullable(),
  purchaseAccount: AccountCode.nullable(),
};
export const NewItem = z.object({ code: MasterCode, ...itemFields }).partial({
  unit: true, isService: true, trackInventory: true, salePrice: true, purchasePrice: true, salesAccount: true, purchaseAccount: true,
}).strict();
export const EditItem = z.object({ version: Version, active: z.boolean(), ...itemFields }).partial().required({ version: true }).strict();
export const ItemParams = z.object({ companyId: Uuid, code: MasterCode });
// ปรับสต็อก (เปิดยอด/ผลตรวจนับ): จำนวนมีเครื่องหมาย บวก = รับเข้า ลบ = ตัดออก
export const InventoryAdjustment = z.object({
  itemCode: MasterCode,
  date: IsoDate,
  quantity: z.string().regex(/^-?\d{1,11}(\.\d{1,3})?$/, 'จำนวนเป็นตัวเลข ทศนิยมไม่เกิน 3 ตำแหน่ง (ตัดออกใส่เครื่องหมายลบ)')
    .refine((s) => Number(s) !== 0, 'จำนวนต้องไม่เป็นศูนย์'),
  unitCost: z.string().regex(/^\d{1,12}(\.\d{1,6})?$/, 'ต้นทุนต่อหน่วยเป็นตัวเลข ทศนิยมไม่เกิน 6 ตำแหน่ง').optional(),
  offsetAccount: z.string().regex(/^[0-9]{3,10}$/, 'เลือกบัญชีคู่'),
  description: z.string().trim().max(300).optional(),
}).strict();

// ---- เฟส 2.2 เอกสารขาย (ตรวจรูปแบบที่นี่ กติกาบัญชีตรวจที่ฟังก์ชันใน DB) ----
const Qty = z.string().regex(/^\d{1,11}(\.\d{1,3})?$/, 'จำนวนเป็นตัวเลข ทศนิยมไม่เกิน 3 ตำแหน่ง');
export const SalesKind = z.enum(['invoice', 'cash-sale', 'credit-note', 'debit-note']);
export const SALES_KIND_SQL = { invoice: 'sales_invoice', 'cash-sale': 'cash_sale', 'credit-note': 'credit_note', 'debit-note': 'debit_note' } as const;
export const SalesKindParams = z.object({ companyId: Uuid, kind: SalesKind });
export const DocumentParams = z.object({ companyId: Uuid, documentId: Uuid });
const SalesLine = z.object({
  itemCode: MasterCode.optional(),
  description: z.string().trim().max(200).optional(),
  qty: Qty,
  unit: z.string().trim().max(20).optional(),
  unitPrice: Money,
  accountCode: AccountCode.optional(),
  orderLineNo: z.number().int().min(1).max(200).optional(),  // ขายเชื่อจากใบสั่งขาย: บรรทัดของใบสั่งขาย
}).strict();
export const NewSalesDocument = z.object({
  date: IsoDate,
  partyCode: MasterCode.optional(),
  isService: z.boolean().optional(),
  priceMode: z.enum(['exclusive', 'inclusive']).optional(),
  discount: Money.optional(),
  description: z.string().trim().max(300).optional(),
  creditDays: z.number().int().min(0).max(365).optional(),
  cashAccount: AccountCode.optional(),
  whtAmount: Money.optional(),
  refDocumentId: Uuid.optional(),
  reason: z.string().trim().max(300).optional(),
  lines: z.array(SalesLine).min(1, 'ต้องมีรายการอย่างน้อย 1 บรรทัด').max(200),
  orderId: Uuid.optional(),
  deposits: z.array(z.object({ documentId: Uuid, amount: Money }).strict()).max(20).optional(),
}).strict();
export const NewReceipt = z.object({
  date: IsoDate,
  partyCode: MasterCode,
  cashAccount: AccountCode.optional(),
  whtAmount: Money.optional(),
  description: z.string().trim().max(300).optional(),
  allocations: z.array(z.object({ documentId: Uuid, amount: Money }).strict()).min(1, 'เลือกใบที่รับชำระอย่างน้อย 1 ใบ').max(50),
}).strict();
export const VoidDocument = z.object({ date: IsoDate, reason: z.string().trim().min(1, 'ต้องระบุเหตุผลที่ยกเลิก').max(300) }).strict();
export const SalesListQuery = z.object({
  kind: z.enum(['sales_invoice', 'cash_sale', 'receipt', 'credit_note', 'debit_note', 'deposit', 'deposit_applied']).optional(),
  party: MasterCode.optional(),
  month: Month.optional(),
}).strict();
export const AsOfQuery = z.object({ asOf: IsoDate.optional() }).strict();

// ---- เฟส 2.3 เอกสารซื้อ ----
export const PurchaseKind = z.enum(['invoice', 'cash-purchase', 'credit-note']);
export const PURCHASE_KIND_SQL = { invoice: 'purchase_invoice', 'cash-purchase': 'cash_purchase', 'credit-note': 'purchase_credit_note' } as const;
export const PurchaseKindParams = z.object({ companyId: Uuid, kind: PurchaseKind });
const Wht = { whtKind: WhtKind.optional(), whtRate: Rate.optional() };
export const NewPurchaseDocument = z.object({
  date: IsoDate,
  partyCode: MasterCode.optional(),
  vendorDocNo: z.string().trim().min(1, 'ต้องใส่เลขที่เอกสารของผู้ขาย').max(40),
  isService: z.boolean().optional(),
  priceMode: z.enum(['exclusive', 'inclusive']).optional(),
  discount: Money.optional(),
  description: z.string().trim().max(300).optional(),
  creditDays: z.number().int().min(0).max(365).optional(),
  cashAccount: AccountCode.optional(),
  ...Wht,
  refDocumentId: Uuid.optional(),
  reason: z.string().trim().max(300).optional(),
  lines: z.array(SalesLine).min(1, 'ต้องมีรายการอย่างน้อย 1 บรรทัด').max(200),
}).strict();
export const NewPayment = z.object({
  date: IsoDate,
  partyCode: MasterCode,
  cashAccount: AccountCode.optional(),
  ...Wht,
  description: z.string().trim().max(300).optional(),
  allocations: z.array(z.object({ documentId: Uuid, amount: Money }).strict()).min(1, 'เลือกใบที่จ่ายชำระอย่างน้อย 1 ใบ').max(50),
}).strict();
export const PurchaseListQuery = z.object({
  kind: z.enum(['purchase_invoice', 'cash_purchase', 'purchase_credit_note', 'payment']).optional(),
  party: MasterCode.optional(),
  month: Month.optional(),
}).strict();

// ---- เฟส 2.4 ภาษี ----
export const TaxMonthParams = z.object({ companyId: Uuid, month: Month });
export const TaxMonthQuery = z.object({ month: Month.optional() }).strict();
export const VatClosingParams = z.object({ companyId: Uuid, closingId: Uuid });
export const WhtRemitParams = z.object({ companyId: Uuid, month: Month, form: z.enum(['pnd3', 'pnd53']) });
export const TaxPayment = z.object({ date: IsoDate, cashAccount: AccountCode.optional() }).strict();
export const VoidVatClose = z.object({ reason: z.string().trim().min(1, 'ต้องระบุเหตุผลที่ยกเลิก').max(300) }).strict();

// ---- กระดาษทำการ ----
export const WORKSHEET_FORMATS = [6, 8, 10] as const;
export const WorksheetQuery = z.object({ month: Month, format: z.enum(['6', '8', '10']).optional() }).strict();

// ---- เฟส 3.3 เช็ค ----
const ChequeNo = z.string().trim().regex(/^[0-9A-Za-z-]{1,20}$/, 'เลขที่เช็คเป็นตัวเลข/ตัวอักษร ไม่เกิน 20 ตัว');
const Allocations = z.array(z.object({ documentId: Uuid, amount: Money }).strict()).min(1, 'เลือกใบอย่างน้อย 1 ใบ').max(50);
export const NewCheque = z.object({
  direction: z.enum(['received', 'paid']),
  chequeNo: ChequeNo,
  bankName: z.string().trim().min(1, 'ต้องระบุธนาคาร').max(100),
  bankBranch: z.string().trim().max(100).optional(),
  chequeDate: IsoDate,
  date: IsoDate,
  amount: Money.optional(),
  partyName: z.string().trim().max(160).optional(),
  description: z.string().trim().max(300).optional(),
  bankAccount: AccountCode.optional(),
  counterAccount: AccountCode.optional(),
  // รับเช็คเป็นใบเสร็จรับชำระ / จ่ายเช็คเป็นการจ่ายชำระ (ตัดยอดค้างรายใบ)
  receipt: z.object({ partyCode: MasterCode, whtAmount: Money.optional(), allocations: Allocations }).strict().optional(),
  payment: z.object({ partyCode: MasterCode, ...Wht, allocations: Allocations }).strict().optional(),
}).strict();
export const ChequeParams = z.object({ companyId: Uuid, chequeId: Uuid });
export const ChequeAction = z.object({
  action: z.enum(['deposit', 'clear', 'bounce', 'cancel']),
  date: IsoDate,
  bankAccount: AccountCode.optional(),
  note: z.string().trim().max(300).optional(),
}).strict();

// ---- เฟส 3.4 สินทรัพย์ถาวร ----
export const NewFixedAsset = z.object({
  code: MasterCode,
  name: z.string().trim().min(1, 'ต้องมีชื่อสินทรัพย์').max(160),
  acquiredDate: IsoDate,
  depStart: Month.optional(),
  cost: Money,
  salvage: Money.optional(),
  lifeMonths: z.number().int().min(1).max(1200),
  assetAccount: AccountCode,
  accumAccount: AccountCode,
  expenseAccount: AccountCode.optional(),
  counterAccount: AccountCode.optional(),
  description: z.string().trim().max(300).optional(),
}).strict();
export const FixedAssetParams = z.object({ companyId: Uuid, assetId: Uuid });
export const DepreciationRunParams = z.object({ companyId: Uuid, runId: Uuid });
export const DisposalParams = z.object({ companyId: Uuid, disposalId: Uuid });
export const DepreciationRun = z.object({ month: Month }).strict();
export const DisposeAsset = z.object({
  date: IsoDate,
  proceeds: Money.optional(),
  proceedsAccount: AccountCode.optional(),
  description: z.string().trim().max(300).optional(),
}).strict();
export const VoidWithReason = z.object({ date: IsoDate.optional(), reason: z.string().trim().min(1, 'ต้องระบุเหตุผล').max(300) }).strict();
export const VoidRun = z.object({ date: IsoDate.optional() }).strict();

// ---- เฟส 4 โจทย์ / มอบหมาย / สอบ (ตรงกับ check ใน migration 20261110000100) ----
const ExerciseLine = z.object({
  account_code: z.string().regex(/^[0-9]{3,10}$/, 'รหัสบัญชีต้องเป็นตัวเลข 3–10 หลัก'),
  debit: Money.optional(),
  credit: Money.optional(),
}).strict();
const ExerciseItem = z.object({
  date: IsoDate,
  narrative: z.string().trim().min(1, 'ต้องมีข้อความรายการค้า').max(2000),
  points: z.string().regex(/^\d{1,3}(\.\d{1,2})?$/, 'คะแนนต้องเป็นตัวเลข').default('1'),
  lines: z.array(ExerciseLine).min(2, 'เฉลยต้องมีอย่างน้อย 2 บรรทัด').max(20),
}).strict();
export const ExerciseSetBody = z.object({
  title: z.string().trim().min(1, 'ต้องมีชื่อชุดโจทย์').max(200),
  companyName: z.string().trim().min(1, 'ต้องมีชื่อบริษัท').max(120),
  description: z.string().max(4000).default(''),
  items: z.array(ExerciseItem).min(1, 'ต้องมีอย่างน้อย 1 ข้อ').max(200),
  version: z.number().int().positive().optional(),
}).strict();
export const SetParams = z.object({ setId: Uuid });
export const AssignmentParams = z.object({ assignmentId: Uuid });
const Feedback = z.enum(['none', 'score', 'items', 'answers']);
const Reveal = z.enum(['anytime', 'after_submit', 'after_release']);
const Instant = z.iso.datetime({ offset: true });
export const AssignBody = z.object({
  classroomId: Uuid.nullable().default(null),
  mode: z.enum(['practice', 'submit', 'exam', 'demo']),
  companyName: z.string().trim().max(120).optional(),
  feedback: Feedback.default('items'),
  reveal: Reveal.default('anytime'),
  checkDate: z.boolean().default(true),
  opensAt: Instant.nullable().optional(),
  closesAt: Instant.nullable().optional(),
  durationMinutes: z.number().int().min(1).max(600).optional(),
}).strict();
export const DemoBody = z.object({ companyName: z.string().trim().min(1, 'ต้องมีชื่อบริษัท').max(120) }).strict();
export const AssignmentOptionsBody = z.object({ feedback: Feedback.optional(), reveal: Reveal.optional(), checkDate: z.boolean().optional() }).strict();
export const AssignmentActionBody = z.object({
  action: z.enum(['release', 'hide', 'close', 'reopen', 'open-companies', 'extend']),
  minutes: z.number().int().min(1).max(600).optional(),
  companyId: Uuid.optional(),
}).strict();


// ---- เฟส 5 โมดูล 3: ยอดยกมาพร้อมรายตัว ----
const OpenRef = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9/-]{0,19}$/, 'เลขที่ใบเดิมเป็นตัวอักษรอังกฤษ ตัวเลข / และ - ไม่เกิน 20 ตัว');
const OpenItem = z.object({
  partyCode: MasterCode, ref: OpenRef, date: IsoDate, dueDate: IsoDate.optional(), amount: Money, undueVat: Money.optional(),
}).strict();
export const OpeningBalances = z.object({
  date: IsoDate,
  accounts: z.array(z.object({ code: AccountCode, debit: Money.optional(), credit: Money.optional() }).strict()).max(200).default([]),
  receivables: z.array(OpenItem).max(300).default([]),
  payables: z.array(OpenItem).max(300).default([]),
  assets: z.array(z.object({
    code: MasterCode, name: z.string().trim().min(1).max(160), acquiredDate: IsoDate, depStart: IsoDate.optional(),
    cost: Money, salvage: Money.optional(), lifeMonths: z.number().int().min(1).max(1200),
    assetAccount: AccountCode, accumAccount: AccountCode, expenseAccount: AccountCode.optional(), accumulated: Money,
  }).strict()).max(200).default([]),
  inventory: z.array(z.object({
    itemCode: MasterCode,
    qty: z.string().regex(/^\d{1,11}(\.\d{1,3})?$/, 'จำนวนเป็นตัวเลข ทศนิยมไม่เกิน 3 ตำแหน่ง'),
    unitCost: z.string().regex(/^\d{1,12}(\.\d{1,6})?$/, 'ต้นทุนต่อหน่วยเป็นตัวเลข ทศนิยมไม่เกิน 6 ตำแหน่ง'),
  }).strict()).max(500).default([]),
}).strict();
export const VoidOpening = z.object({ reason: z.string().trim().min(1, 'ต้องระบุเหตุผลที่ยกเลิก').max(300) }).strict();

// ---- เฟส 5 โมดูล 4: ใบเสนอราคา ใบสั่งขาย เงินมัดจำ ใบวางบิล ----
const OrderLine = z.object({
  itemCode: MasterCode.optional(), description: z.string().trim().max(200).optional(), qty: Qty,
  unit: z.string().trim().max(20).optional(), unitPrice: Money,
}).strict();
export const NewSalesOrder = z.object({
  kind: z.enum(['quotation', 'sales_order']),
  date: IsoDate, partyCode: MasterCode, untilDate: IsoDate.optional(), sourceId: Uuid.optional(),
  isService: z.boolean().optional(), priceMode: z.enum(['exclusive', 'inclusive']).optional(), discount: Money.optional(),
  description: z.string().trim().max(300).optional(),
  lines: z.array(OrderLine).min(1, 'ต้องมีรายการอย่างน้อย 1 บรรทัด').max(200),
}).strict();
export const SalesOrderParams = z.object({ companyId: Uuid, orderId: Uuid });
export const SalesOrderListQuery = z.object({ kind: z.enum(['quotation', 'sales_order']).optional(), party: MasterCode.optional() }).strict();
export const CancelWithReason = z.object({ reason: z.string().trim().min(1, 'ต้องระบุเหตุผลที่ยกเลิก').max(300) }).strict();
export const NewDeposit = z.object({
  date: IsoDate, partyCode: MasterCode, amount: Money, priceMode: z.enum(['exclusive', 'inclusive']).optional(),
  isService: z.boolean().optional(), cashAccount: AccountCode.optional(), orderId: Uuid.optional(),
  description: z.string().trim().max(300).optional(),
}).strict();
export const PartyFilter = z.object({ party: MasterCode.optional() }).strict();
export const NewBillingNote = z.object({
  date: IsoDate, partyCode: MasterCode, dueDate: IsoDate.optional(), documentIds: z.array(Uuid).min(1, 'เลือกใบที่จะวางบิลอย่างน้อยหนึ่งใบ').max(200),
  description: z.string().trim().max(300).optional(),
}).strict();
export const BillingNoteParams = z.object({ companyId: Uuid, noteId: Uuid });
