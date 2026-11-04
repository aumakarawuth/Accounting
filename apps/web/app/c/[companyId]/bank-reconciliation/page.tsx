import { Money } from '@/components/Money';
import { serverApi } from '@/lib/server-api';
import { ImportStatement } from '@/components/bank/ImportStatement';
import { MatchLine } from '@/components/bank/MatchLine';
import { th } from '@/i18n/th';

const t = th.bankRec;

type Bank = {
  statements: { id: string; accountCode: string; accountName: string; periodStart: string; periodEnd: string; openingBalance: string; closingBalance: string }[];
  statement: { id: string } | null;
  entries: { id: string; docNo: string; amount: string }[];
  lines: { id: string; date: string; description: string; reference: string; amount: string; balance: string | null; matched: string }[];
  summary: { opening_balance: string; closing_balance: string; statement_total: string; book_balance: string; unmatched_bank: string; unmatched_book: string } | null;
};

export default async function BankReconciliationPage({ params, searchParams }: { params: Promise<{ companyId: string }>; searchParams: Promise<{ statementId?: string }> }) {
  const { companyId } = await params;
  const { statementId } = await searchParams;
  const r = await serverApi<Bank>(`/companies/${companyId}/bank-reconciliation${statementId ? `?statementId=${statementId}` : ''}`);
  const s = r.summary;
  const cell = 'border-b border-rule px-3 py-2';
  return (
    <div className="flex min-h-full flex-col gap-5 p-4 sm:p-6">
      <h1 className="border-b-2 border-ink pb-2.5 font-doc text-2xl font-bold">{t.title}</h1>
      <ImportStatement companyId={companyId} />
      {r.statements.length > 0 && (
        <nav aria-label={t.chooseStatement} className="flex flex-wrap gap-2">
          {r.statements.map((x) => (
            <a key={x.id} href={`?statementId=${x.id}`} aria-current={x.id === r.statement?.id ? 'page' : undefined}
              className={`flex min-h-11 items-center rounded-doc border px-3 text-sm ${x.id === r.statement?.id ? 'border-ink bg-ink text-paper' : 'border-rule-strong bg-paper'}`}>
              {x.accountCode} {x.accountName} · <span className="font-num">{x.periodStart} – {x.periodEnd}</span>
            </a>
          ))}
        </nav>
      )}
      {s && (
        <section className="grid grid-cols-2 gap-px border border-rule-strong bg-rule sm:grid-cols-3">
          {([
            [t.bankBalance, s.closing_balance], [t.bookBalance, s.book_balance], [t.difference, String(Number(s.closing_balance) - Number(s.book_balance))],
            [t.unmatchedBank, s.unmatched_bank], [t.unmatchedBook, s.unmatched_book],
          ] as const).map(([label, v]) => (
            <p key={label} className="flex flex-col gap-1 bg-paper p-3 text-sm text-ink2">{label}<span className="text-lg text-ink"><Money value={v} /></span></p>
          ))}
        </section>
      )}
      {r.lines.length === 0 ? (
        <p className="text-ink2">{t.empty}</p>
      ) : (
        <section className="overflow-x-auto border border-rule-strong bg-paper">
          <table className="w-full text-sm">
            <thead><tr className="bg-ground text-left">
              <th className={`${cell} font-medium`}>{t.date}</th><th className={`${cell} font-medium`}>{t.description}</th>
              <th className={`${cell} text-right font-medium`}>{t.amount}</th><th className={`${cell} text-right font-medium`}>{t.matched}</th>
              <th className={`${cell} font-medium`}>{t.match}</th>
            </tr></thead>
            <tbody>
              {r.lines.map((l) => (
                <tr key={l.id}>
                  <td className={`${cell} font-num whitespace-nowrap`}>{l.date}</td>
                  <td className={cell}>{l.description}{l.reference && <span className="text-ink2"> ({l.reference})</span>}</td>
                  <td className={`${cell} text-right`}><Money value={l.amount} /></td>
                  <td className={`${cell} text-right`}><Money value={l.matched} /></td>
                  <td className={cell}>{Number(l.matched) === Number(l.amount) ? '✓' : <MatchLine companyId={companyId} lineId={l.id} amount={l.amount} entries={r.entries} />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
