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
export const LedgerQuery = z.object({ month: Month, account: z.string().min(1).max(20) });
