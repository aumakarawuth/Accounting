import { Money } from '@/components/Money';
import { serverApi } from '@/lib/server-api';
import { ImportStatement } from '@/components/bank/ImportStatement';
import { MatchLine } from '@/components/bank/MatchLine';

type Bank = { statements: { id: string; accountCode: string; accountName: string; periodStart: string; periodEnd: string; openingBalance: string; closingBalance: string }[]; statement: { id: string } | null; entries: { id: string; docNo: string; amount: string }[]; lines: { id: string; date: string; description: string; reference: string; amount: string; balance: string | null; matched: string }[]; summary: { opening_balance: string; closing_balance: string; statement_total: string; book_balance: string; unmatched_bank: string; unmatched_book: string } | null };

export default async function BankReconciliationPage({ params, searchParams }: { params: Promise<{ companyId: string }>; searchParams: Promise<{ statementId?: string }> }) {
  const { companyId } = await params; const { statementId } = await searchParams;
  const r = await serverApi<Bank>(`/companies/${companyId}/bank-reconciliation${statementId ? `?statementId=${statementId}` : ''}`);
  return <div className="flex min-h-full flex-col gap-5 p-4 sm:p-6"><h1 className="font-doc text-2xl font-bold">กระทบยอดธนาคาร</h1>
    <ImportStatement companyId={companyId} />
    {r.summary && <section className="grid gap-2 border border-ink p-4 sm:grid-cols-3"><p>ยอดตามธนาคาร <Money value={r.summary.closing_balance} /></p><p>ยอดตามสมุด <Money value={r.summary.book_balance} /></p><p>ยังไม่จับคู่ <Money value={r.summary.unmatched_bank} /></p></section>}
    <section className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b"><th className="p-2 text-left">วันที่</th><th className="p-2 text-left">รายการ</th><th className="p-2 text-right">จำนวน</th><th className="p-2 text-right">จับคู่แล้ว</th><th /></tr></thead><tbody>{r.lines.map((l) => <tr key={l.id} className="border-b"><td className="p-2">{l.date}</td><td className="p-2">{l.description} {l.reference && `(${l.reference})`}</td><td className="p-2 text-right"><Money value={l.amount} /></td><td className="p-2 text-right"><Money value={l.matched} /></td><td><MatchLine companyId={companyId} lineId={l.id} amount={l.amount} entries={r.entries} /></td></tr>)}</tbody></table>{r.lines.length === 0 && <p className="p-4 text-ink2">ยังไม่มี statement ให้เลือกนำเข้า</p>}</section>
  </div>;
}
