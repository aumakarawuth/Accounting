'use client';
import { postJson } from '@/lib/api';
export function MatchLine({ companyId, lineId, amount, entries }: { companyId: string; lineId: string; amount: string; entries: { id: string; docNo: string; amount: string }[] }) {
  async function match(form: FormData) { const entryId = String(form.get('entryId')); if (!entryId) return; await postJson(`/companies/${companyId}/bank-reconciliation/matches`, { statementLineId: lineId, entryId, amount }); location.reload(); }
  return <form action={match} className="flex gap-1"><select name="entryId" defaultValue=""><option value="">จับคู่…</option>{entries.filter((e) => e.amount === amount).map((e) => <option key={e.id} value={e.id}>{e.docNo}</option>)}</select><button className="border px-2">บันทึก</button></form>;
}
