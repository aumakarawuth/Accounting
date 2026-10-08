import { Money } from '@/components/Money';
import type { Statements } from '@/lib/api';
import { monthEndLabel, monthLabel } from '@/lib/date';
import { formatMoney, isNegative } from '@/lib/money';
import { th } from '@/i18n/th';

type Line = { code: string; name: string; amount: string };

// งบการเงินแบบกระดาษ: หัวเอกสาร serif, เส้นบาง, เส้นคู่ใต้ยอดสุดท้าย (ใช้ทั้งหน้านักเรียนและหน้าครูตรวจ)
function Section({ title, lines, total, totalLabel }: { title: string; lines: Line[]; total: string; totalLabel: string }) {
  return (
    <div className="flex flex-col">
      <h3 className="border-b border-rule pb-1 font-semibold">{title}</h3>
      {lines.length === 0 && <p className="py-1.5 pl-4 text-sm text-ink2">{th.statements.none}</p>}
      {lines.map((l) => (
        <div key={l.code} className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 border-b border-rule-faint py-1.5 pl-4">
          <span><span className="font-num text-[13px] text-ink2">{l.code}</span> {l.name}</span>
          <Money value={l.amount} />
        </div>
      ))}
      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 py-1.5 font-medium">
        <span>{totalLabel}</span>
        <Money value={total} className="border-t border-ink pt-0.5" />
      </div>
    </div>
  );
}

function Final({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 border-t-2 border-ink pt-2 font-semibold">
      <span>{label}</span>
      <Money value={value} className="border-b-[3px] border-double border-ink" />
    </div>
  );
}

export function StatementsView({ st, company }: { st: Statements; company: string }) {
  const profit = !isNegative(st.netIncome);
  const hasContra = [...st.assets, ...st.equity, ...st.revenue, ...st.expense].some((l) => isNegative(l.amount));
  const paper = 'flex flex-col gap-4 border border-rule-strong bg-paper p-5 sm:p-7';
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <article className={paper} aria-label={th.statements.income}>
        <header className="border-b-2 border-ink pb-2 text-center">
          <h2 className="font-doc text-[20px] font-bold">{th.statements.income}</h2>
          <p className="text-sm">{th.statements.incomePeriod(company, monthLabel(st.from), monthLabel(st.month))}</p>
          <p className="text-[13px] text-ink2">{th.statements.unit}</p>
        </header>
        <Section title={th.statements.revenue} lines={st.revenue} total={st.totalRevenue} totalLabel={th.statements.totalRevenue} />
        <Section title={th.statements.expense} lines={st.expense} total={st.totalExpense} totalLabel={th.statements.totalExpense} />
        <Final label={profit ? th.statements.netProfit : th.statements.netLoss} value={st.netIncome} />
      </article>

      <article className={paper} aria-label={th.statements.position}>
        <header className="border-b-2 border-ink pb-2 text-center">
          <h2 className="font-doc text-[20px] font-bold">{th.statements.position}</h2>
          <p className="text-sm">{th.statements.positionAt(company, monthEndLabel(st.month))}</p>
          <p className="text-[13px] text-ink2">{th.statements.unit}</p>
        </header>
        <Section title={th.statements.assets} lines={st.assets} total={st.totalAssets} totalLabel={th.statements.totalAssets} />
        <Section title={th.statements.liabilities} lines={st.liabilities} total={st.totalLiabilities} totalLabel={th.statements.totalLiabilities} />
        <Section
          title={th.statements.equity}
          lines={[...st.equity, { code: '', name: th.statements.unclosed, amount: st.unclosedProfit }]}
          total={st.totalEquity}
          totalLabel={th.statements.totalEquity}
        />
        <Final label={th.statements.totalLiabilitiesEquity} value={st.totalLiabilitiesEquity} />
        <p role="status" className={`text-sm ${st.balanced ? '' : 'neg font-semibold'}`}>
          {st.balanced ? th.statements.balanced : th.statements.unbalanced(formatMoney(st.totalAssets), formatMoney(st.totalLiabilitiesEquity))}
        </p>
      </article>
      {hasContra && <p className="text-sm text-ink2 lg:col-span-2">{th.statements.contraNote}</p>}
    </div>
  );
}
