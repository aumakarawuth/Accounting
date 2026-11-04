import { notFound } from 'next/navigation';
import { JournalForm, type EditSource, type Prefill } from '@/components/JournalForm';
import type { Account, ApiError, AssignmentView, Company, JournalEntry } from '@/lib/api';
import { serverApi } from '@/lib/server-api';

// ?adjusting=1 รายการปรับปรุง · ?edit=<id> แก้ไขรายการที่ผ่านแล้ว (กลับรายการเดิม + ลงใหม่)
export default async function NewJournal({
  params, searchParams,
}: { params: Promise<{ companyId: string }>; searchParams: Promise<{ adjusting?: string; edit?: string; exercise?: string }> }) {
  const { companyId } = await params;
  const sp = await searchParams;
  const [accounts, company] = await Promise.all([
    serverApi<Account[]>(`/companies/${companyId}/accounts`),
    serverApi<Company>(`/companies/${companyId}`),
  ]);
  let edit: EditSource | undefined;
  if (sp.edit) {
    const e = await serverApi<JournalEntry>(`/companies/${companyId}/journal/${sp.edit}`).catch((err: ApiError) => {
      if ([400, 404].includes(err.status)) notFound();
      throw err;
    });
    if (e.reverses || e.reversedBy || !/^(JV|AJ)-/.test(e.docNo)) notFound();
    edit = { id: e.id, docNo: e.docNo, date: e.date, description: e.description, lines: e.lines.map(({ code, debit, credit, memo }) => ({ code, debit, credit, memo })) };
  }
  // ?exercise=<ข้อ> ลงตามเฉลย (ครูในโหมดสาธิตเท่านั้น: DB ส่งเฉลยให้เฉพาะครู)
  let prefill: Prefill | undefined;
  if (!edit && sp.exercise && /^\d{1,3}$/.test(sp.exercise) && company.assignment) {
    const v = await serverApi<AssignmentView>(`/companies/${companyId}/assignment`);
    const it = v.items?.find((i) => i.no === Number(sp.exercise));
    if (it?.answer) prefill = { key: String(it.no), date: it.date, description: it.narrative.slice(0, 500), lines: it.answer };
  }
  const adjusting = edit ? edit.docNo.startsWith('AJ-') : sp.adjusting === '1';
  // key: สลับรายการปกติ/ปรับปรุง/แก้ไขแล้วฟอร์มเริ่มใหม่ (ร่างแยกกัน)
  return <JournalForm key={edit ? `edit:${edit.id}` : prefill ? `ex:${prefill.key}` : adjusting ? 'aj' : 'jv'} companyId={companyId} accounts={accounts}
    locked={company.locked || !company.can_write} adjusting={adjusting} edit={edit} prefill={prefill} />;
}
