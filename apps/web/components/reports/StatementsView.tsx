import { Money } from '@/components/Money';
import type { CostOfSales, Statements } from '@/lib/api';
import { monthEndLabel, monthLabel } from '@/lib/date';
import { formatMoney, isNegative, toCents } from '@/lib/money';

const isZero = (v: string) => (toCents(v) ?? 0n) === 0n;
import { th } from '@/i18n/th';

type Line = { code: string; name: string; amount: string };

// งบการเงินแบบกระดาษ: หัวเอกสาร serif, เส้นบาง, เส้นคู่ใต้ยอดสุดท้าย (ใช้ทั้งหน้านักเรียนและหน้าครูตรวจ)
function Section({ title, lines, total, totalLabel }: { title: string; lines: Line[]; total: string; totalLabel: string }) {
  return (
    <div className="flex flex-col">
      <h3 className="border-b border-rule pb-1 font-semibold">{title}</h3>
      {lines.length === 0 && <p className="py-1.5 pl-4 text-sm text-ink2">{th.statements.none}</p>}
      {lines.map((l) => (
        <div key={l.code || l.name} className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 border-b border-rule-faint py-1.5 pl-4">
          <span>{/^\d/.test(l.code) && <span className="font-num text-[13px] text-ink2">{l.code} </span>}{l.name}</span>
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

/** บรรทัดเดี่ยวในงบ: ชื่อ + ยอด (deduct = รายการหัก แสดงยอดบวกพร้อมคำว่า "หัก") */
function Row({ label, value, indent = false, strong = false, rule = false }: { label: string; value: string; indent?: boolean; strong?: boolean; rule?: boolean }) {
  return (
    <div className={`grid grid-cols-[minmax(0,1fr)_auto] gap-3 py-1.5 ${indent ? 'pl-4 border-b border-rule-faint' : ''} ${strong ? 'font-medium' : ''}`}>
      <span>{label}</span>
      <Money value={value} className={rule ? 'border-t border-ink pt-0.5' : ''} />
    </div>
  );
}

function CostOfSalesBlock({ c }: { c: CostOfSales }) {
  const t = th.statements;
  return (
    <div className="flex flex-col">
      <h3 className="border-b border-rule pb-1 font-semibold">{t.costOfSales}</h3>
      <Row indent label={t.openingInventory} value={c.opening} />
      <Row indent label={t.purchases} value={c.purchases} />
      {!isZero(c.discounts) && <Row indent label={t.lessDiscounts} value={c.discounts} />}
      {!isZero(c.returns) && <Row indent label={t.lessReturns} value={c.returns} />}
      {c.otherCosts.map((l) => <Row key={l.code} indent label={t.plus(l.name)} value={l.amount} />)}
      <Row indent strong label={t.netPurchases} value={c.netPurchases} />
      <Row indent strong label={t.available} value={c.available} />
      <Row indent label={t.lessClosingInventory} value={c.closing} />
      {!isZero(c.adjustments) && <Row indent label={t.inventoryAdjustments} value={c.adjustments} />}
      <Row strong rule label={t.totalCostOfSales} value={c.total} />
    </div>
  );
}

export function StatementsView({ st, company }: { st: Statements; company: string }) {
  const t = th.statements;
  const m = st.multiStep;
  const k = st.classified;
  const profit = !isNegative(st.netIncome);
  const hasContra = [...st.assets, ...st.equity, ...st.revenue, ...st.expense].some((l) => isNegative(l.amount));
  const showFinance = m.financeCosts.length > 0 || m.incomeTax.length > 0;
  const paper = 'flex flex-col gap-4 border border-rule-strong bg-paper p-5 sm:p-7';
  const step = (label: [string, string], value: string) => (
    <Row strong label={isNegative(value) ? label[1] : label[0]} value={value} />
  );
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <article className={paper} aria-label={t.income}>
        <header className="border-b-2 border-ink pb-2 text-center">
          <h2 className="font-doc text-[20px] font-bold">{t.income}</h2>
          <p className="text-sm">{t.incomePeriod(company, monthLabel(st.from), monthLabel(st.month))}</p>
          <p className="text-[13px] text-ink2">{t.unit}</p>
        </header>
        <Section title={t.sales} lines={m.sales} total={m.netSales} totalLabel={t.netSales} />
        {m.costOfSales && <CostOfSalesBlock c={m.costOfSales} />}
        {step([t.grossProfit, t.grossLoss], m.grossProfit)}
        {m.otherIncome.length > 0 && <Section title={t.otherIncome} lines={m.otherIncome} total={m.totalOtherIncome} totalLabel={t.totalOtherIncome} />}
        <Section title={t.sellingAdmin} lines={m.sellingAdmin} total={m.totalSellingAdmin} totalLabel={t.totalSellingAdmin} />
        {m.otherExpenses.length > 0 && <Section title={t.otherExpenses} lines={m.otherExpenses} total={m.totalOtherExpenses} totalLabel={t.totalOtherExpenses} />}
        {showFinance && step([t.profitBeforeFinance, t.lossBeforeFinance], m.profitBeforeFinance)}
        {m.financeCosts.length > 0 && <Section title={t.financeCosts} lines={m.financeCosts} total={m.totalFinanceCosts} totalLabel={t.totalFinanceCosts} />}
        {m.incomeTax.length > 0 && step([t.profitBeforeTax, t.lossBeforeTax], m.profitBeforeTax)}
        {m.incomeTax.length > 0 && <Section title={t.incomeTax} lines={m.incomeTax} total={m.totalIncomeTax} totalLabel={t.totalIncomeTax} />}
        <Final label={profit ? t.netProfit : t.netLoss} value={st.netIncome} />
      </article>

      <article className={paper} aria-label={t.position}>
        <header className="border-b-2 border-ink pb-2 text-center">
          <h2 className="font-doc text-[20px] font-bold">{t.position}</h2>
          <p className="text-sm">{t.positionAt(company, monthEndLabel(st.month))}</p>
          <p className="text-[13px] text-ink2">{t.unit}</p>
        </header>
        <Section title={t.currentAssets} lines={k.currentAssets} total={k.totalCurrentAssets} totalLabel={t.totalCurrentAssets} />
        <Section title={t.nonCurrentAssets} lines={k.nonCurrentAssets} total={k.totalNonCurrentAssets} totalLabel={t.totalNonCurrentAssets} />
        <Row strong rule label={t.totalAssets} value={st.totalAssets} />
        <Section title={t.currentLiabilities} lines={k.currentLiabilities} total={k.totalCurrentLiabilities} totalLabel={t.totalCurrentLiabilities} />
        <Section title={t.nonCurrentLiabilities} lines={k.nonCurrentLiabilities} total={k.totalNonCurrentLiabilities} totalLabel={t.totalNonCurrentLiabilities} />
        <Row strong rule label={t.totalLiabilities} value={st.totalLiabilities} />
        <Section
          title={t.equity}
          lines={[
            ...st.equity,
            { code: '', name: t.yearProfit, amount: st.yearProfit },
            ...(isZero(st.priorUnclosedProfit) ? [] : [{ code: '', name: t.priorUnclosed, amount: st.priorUnclosedProfit }]),
          ]}
          total={st.totalEquity}
          totalLabel={t.totalEquity}
        />
        <Final label={t.totalLiabilitiesEquity} value={st.totalLiabilitiesEquity} />
        <p role="status" className={`text-sm ${st.balanced ? '' : 'neg font-semibold'}`}>
          {st.balanced ? t.balanced : t.unbalanced(formatMoney(st.totalAssets), formatMoney(st.totalLiabilitiesEquity))}
        </p>
      </article>
      {hasContra && <p className="text-sm text-ink2 lg:col-span-2">{t.contraNote}</p>}
    </div>
  );
}
