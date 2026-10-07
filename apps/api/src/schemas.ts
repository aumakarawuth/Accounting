import { z } from 'zod';

// เงินเป็นสตริงทศนิยมเสมอ ห้าม number (กัน float ทุกชั้น)
export const Money = z.string().regex(/^\d{1,16}(\.\d{1,2})?$/, 'จำนวนเงินต้องเป็นตัวเลขทศนิยมไม่เกิน 2 ตำแหน่ง');
export const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'วันที่ต้องเป็น YYYY-MM-DD');
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
  })
  .strict();

export const Reverse = z.object({ date: IsoDate, description: z.string().max(500).optional() }).strict();

export const IdempotencyKey = z.string().min(8).max(100);

const Month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'เดือนต้องเป็น YYYY-MM');
export const MonthQuery = z.object({ month: Month.optional() });
export const TrialBalanceQuery = z.object({ month: Month, all: z.enum(['0', '1']).default('0') });
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
  salePrice: Money.nullable(),
  purchasePrice: Money.nullable(),
  salesAccount: AccountCode.nullable(),
  purchaseAccount: AccountCode.nullable(),
};
export const NewItem = z.object({ code: MasterCode, ...itemFields }).partial({
  unit: true, isService: true, salePrice: true, purchasePrice: true, salesAccount: true, purchaseAccount: true,
}).strict();
export const EditItem = z.object({ version: Version, active: z.boolean(), ...itemFields }).partial().required({ version: true }).strict();
export const ItemParams = z.object({ companyId: Uuid, code: MasterCode });

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
  kind: z.enum(['sales_invoice', 'cash_sale', 'receipt', 'credit_note', 'debit_note']).optional(),
  party: MasterCode.optional(),
  month: Month.optional(),
}).strict();
export const AsOfQuery = z.object({ asOf: IsoDate.optional() }).strict();
