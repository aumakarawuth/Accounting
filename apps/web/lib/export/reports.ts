import { th } from '../../i18n/th';
import type { AssignmentOverview, CashFlow, EquityChanges, PayrollPage, Ledger, SpecialJournal, Statements, TrialBalance, Worksheet, WsPair } from '../api';
import { isoToThai, monthEndLabel, monthLabel } from '../date';
import { formatMoney, fromCents, toCents } from '../money';
import type { Column, Report, Row, Section } from './model';
import { cashFlowRows } from '../cashflow-lines';
import { equityLabels } from '../equity-labels';

// แปลงข้อมูลจาก API (ชุดเดียวกับหน้าจอ) เป็นโครงรายงานกลาง หัวคอลัมน์/ข้อความมาจาก i18n/th.ts

const blankZero = (v: string | null | undefined) => (v === null || v === undefined || /^-?0+(\.0+)?$/.test(v) ? null : v);
const printedAt = (now: Date) => th.export.printedAt(now.toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok' }));
// eslint-disable-next-line no-control-regex
const safe = (s: string) => s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);

export function fileName(title: string, company: string, tag: string) {
  return safe(`${title} ${company} ${tag}`);
}

const money = (label: string, width = 15): Column => ({ label, width, kind: 'money' });

export function trialBalanceReport(company: string, tb: TrialBalance, now = new Date()): Report {
  const t = th.trialBalance;
  const unbalanced = tb.totalDebit !== tb.totalCredit;
  return {
    fileName: fileName(t.title, company, tb.month), sheetName: t.title, company, title: t.title,
    subtitle: `${tb.stage === 'after' ? t.stageAfter : t.stageBefore} · ${th.export.asOf(monthEndLabel(tb.month))}`, orientation: 'portrait', printedAt: printedAt(now),
    sections: [{
      columns: [{ label: t.code, width: 10, kind: 'mono' }, { label: t.account, width: 40 }, money(th.money.debit), money(th.money.credit)],
      rows: [
        ...tb.rows.map((r): Row => ({ cells: [r.code, r.name, blankZero(r.debit), blankZero(r.credit)] })),
        { cells: [null, th.money.total, tb.totalDebit, tb.totalCredit], style: 'total' },
      ],
    }],
    notes: [t.cumulativeNote, th.export.unit,
      ...(unbalanced ? [t.unbalanced(tb.totalDebit, tb.totalCredit, fromCents((toCents(tb.totalDebit) ?? 0n) - (toCents(tb.totalCredit) ?? 0n)))] : [])],
  };
}

export function ledgerReport(company: string, month: string, ledgers: Ledger[], now = new Date()): Report {
  const l = th.ledger;
  const sections: Section[] = ledgers.map((g) => ({
    heading: `${g.account.code} ${g.account.name} · ${th.export.normalSide(g.account.normalSide)}`,
    columns: [
      { label: l.date, width: 11, kind: 'mono' }, { label: l.docNo, width: 11, kind: 'mono' }, { label: l.description, width: 34 },
      money(th.money.debit, 14), money(th.money.credit, 14), money(l.balance, 15),
    ],
    rows: [
      { cells: [null, null, l.opening, null, null, g.opening] },
      ...g.lines.map((x): Row => ({
        cells: [isoToThai(x.date), x.docNo, x.memo ? `${x.description} · ${x.memo}` : x.description, blankZero(x.debit), blankZero(x.credit), x.balance],
      })),
      { cells: [null, null, l.totals, g.totalDebit, g.totalCredit, null], style: 'subtotal' },
      { cells: [null, null, l.closing, null, null, g.closing], style: 'total' },
    ],
  }));
  return {
    fileName: fileName(l.title, company, month), sheetName: l.title, company, title: l.title,
    subtitle: th.export.period(monthLabel(month)), orientation: 'portrait', printedAt: printedAt(now),
    sections: sections.length ? sections : [{ columns: [{ label: l.description, width: 60 }], rows: [{ cells: [th.export.noAccounts] }] }],
    notes: [l.oppositeNote, th.export.unit],
  };
}

export function statementsReport(company: string, st: Statements, now = new Date()): Report {
  const s = th.statements;
  const cols: Column[] = [{ label: th.trialBalance.code, width: 10, kind: 'mono' }, { label: th.ledger.description, width: 46 }, money(th.invoice.amount, 18)];
  const lines = (xs: { code: string; name: string; amount: string }[]): Row[] =>
    xs.length ? xs.map((x) => ({ cells: [x.code, x.name, x.amount], indent: 1 })) : [{ cells: [null, s.none, null], indent: 1 }];
  const loss = st.netIncome.startsWith('-');
  const zero = (v: string) => (toCents(v) ?? 0n) === 0n;
  const neg = (v: string) => v.startsWith('-');
  const m = st.multiStep;
  const k = st.classified;
  const group = (title: string, xs: { code: string; name: string; amount: string }[], totalLabel: string, total: string): Row[] => [
    { cells: [null, title, null], style: 'heading' }, ...lines(xs), { cells: [null, totalLabel, total], style: 'subtotal' }];
  const step = (label: [string, string], v: string): Row => ({ cells: [null, neg(v) ? label[1] : label[0], v], style: 'subtotal' });
  const c = m.costOfSales;
  const cogs: Row[] = c ? [
    { cells: [null, s.costOfSales, null], style: 'heading' },
    { cells: [null, s.openingInventory, c.opening], indent: 1 },
    { cells: [null, s.purchases, c.purchases], indent: 1 },
    ...(zero(c.discounts) ? [] : [{ cells: [null, s.lessDiscounts, c.discounts], indent: 1 } as Row]),
    ...(zero(c.returns) ? [] : [{ cells: [null, s.lessReturns, c.returns], indent: 1 } as Row]),
    ...c.otherCosts.map((x): Row => ({ cells: [x.code, s.plus(x.name), x.amount], indent: 1 })),
    { cells: [null, s.netPurchases, c.netPurchases], indent: 1 },
    { cells: [null, s.available, c.available], indent: 1 },
    { cells: [null, s.lessClosingInventory, c.closing], indent: 1 },
    ...(zero(c.adjustments) ? [] : [{ cells: [null, s.inventoryAdjustments, c.adjustments], indent: 1 } as Row]),
    { cells: [null, s.totalCostOfSales, c.total], style: 'subtotal' },
  ] : [];
  const showFinance = m.financeCosts.length > 0 || m.incomeTax.length > 0;
  const income: Section = {
    heading: `${s.income} · ${s.incomePeriod(company, monthLabel(st.from), monthLabel(st.month))}`,
    columns: cols,
    rows: [
      ...group(s.sales, m.sales, s.netSales, m.netSales),
      ...cogs,
      step([s.grossProfit, s.grossLoss], m.grossProfit),
      ...(m.otherIncome.length ? group(s.otherIncome, m.otherIncome, s.totalOtherIncome, m.totalOtherIncome) : []),
      ...group(s.sellingAdmin, m.sellingAdmin, s.totalSellingAdmin, m.totalSellingAdmin),
      ...(m.otherExpenses.length ? group(s.otherExpenses, m.otherExpenses, s.totalOtherExpenses, m.totalOtherExpenses) : []),
      ...(showFinance ? [step([s.profitBeforeFinance, s.lossBeforeFinance], m.profitBeforeFinance)] : []),
      ...(m.financeCosts.length ? group(s.financeCosts, m.financeCosts, s.totalFinanceCosts, m.totalFinanceCosts) : []),
      ...(m.incomeTax.length ? [step([s.profitBeforeTax, s.lossBeforeTax], m.profitBeforeTax),
        ...group(s.incomeTax, m.incomeTax, s.totalIncomeTax, m.totalIncomeTax)] : []),
      { cells: [null, loss ? s.netLoss : s.netProfit, loss ? st.netIncome.slice(1) : st.netIncome], style: 'total' },
      ...(st.allocation?.length ? [
        { cells: [null, th.entity.allocation, null], style: 'heading' } as Row,
        ...st.allocation.map((a): Row => ({ cells: [null, th.entity.allocationLine(a.name, formatMoney(a.salary), formatMoney(a.interest), formatMoney(a.share)), a.total], indent: 1 })),
      ] : []),
    ],
  };
  const position: Section = {
    heading: `${s.position} · ${s.positionAt(company, monthEndLabel(st.month))}`,
    columns: cols,
    rows: [
      ...group(s.currentAssets, k.currentAssets, s.totalCurrentAssets, k.totalCurrentAssets),
      ...group(s.nonCurrentAssets, k.nonCurrentAssets, s.totalNonCurrentAssets, k.totalNonCurrentAssets),
      { cells: [null, s.totalAssets, st.totalAssets], style: 'total' },
      ...group(s.currentLiabilities, k.currentLiabilities, s.totalCurrentLiabilities, k.totalCurrentLiabilities),
      ...group(s.nonCurrentLiabilities, k.nonCurrentLiabilities, s.totalNonCurrentLiabilities, k.totalNonCurrentLiabilities),
      { cells: [null, s.totalLiabilities, st.totalLiabilities], style: 'subtotal' },
      { cells: [null, th.entity.equityHeadings[st.entityType ?? 'sole'] ?? s.equity, null], style: 'heading' },
      ...lines(st.equity),
      { cells: [null, s.yearProfit, st.yearProfit], indent: 1 },
      ...(zero(st.priorUnclosedProfit) ? [] : [{ cells: [null, s.priorUnclosed, st.priorUnclosedProfit], indent: 1 } as Row]),
      { cells: [null, th.entity.totalEquity[st.entityType ?? 'sole'] ?? s.totalEquity, st.totalEquity], style: 'subtotal' },
      { cells: [null, s.totalLiabilitiesEquity, st.totalLiabilitiesEquity], style: 'total' },
    ],
  };
  return {
    fileName: fileName(s.title, company, st.month), sheetName: s.title, company, title: s.title,
    subtitle: `${st.scope === 'month' ? s.scopeMonth : s.scopeYtd} · ${th.export.asOf(monthEndLabel(st.month))}`,
    orientation: 'portrait', printedAt: printedAt(now), sections: [income, position],
    notes: [st.balanced ? s.balanced : s.unbalanced(st.totalAssets, st.totalLiabilitiesEquity), s.contraNote, s.unit],
  };
}

/** สมุดรายวันเฉพาะ (docs/phase6-spec.md ข้อ 1): ตารางหลายช่องตามแบบที่สอน + ยอดรวมผ่านไปบัญชีแยกประเภท */
export function specialJournalReport(company: string, j: SpecialJournal, now = new Date()): Report {
  const t = th.books;
  const title = t.names[j.book]!;
  const general = j.book === 'general';
  const label = (r: SpecialJournal['rows'][number]) => (r.reversal && r.reversesDocNo ? t.reversalOf(r.reversesDocNo) : (r.party ?? r.description) || '');
  let main: Section;
  if (general) {
    main = {
      columns: [{ label: t.date, width: 11, kind: 'mono' }, { label: t.docNo, width: 11, kind: 'mono' }, { label: t.account, width: 40 },
        { label: t.ref, width: 8, kind: 'mono' }, money(t.debit, 14), money(t.credit, 14)],
      rows: [],
    };
    main.rows = j.rows.flatMap((r): Row[] => [
      { cells: [isoToThai(r.date), r.docNo, r.reversal && r.reversesDocNo ? t.reversalOf(r.reversesDocNo) : r.description, null, null, null], style: 'heading' },
      ...r.others.map((o): Row => ({ cells: [null, null, o.memo ? `${o.name} · ${o.memo}` : o.name, o.code, blankZero(o.debit), blankZero(o.credit)], indent: blankZero(o.debit) ? 0 : 1 })),
    ]);
  } else {
    const rows: Row[] = j.rows.flatMap((r): Row[] => {
      const n = Math.max(1, r.others.length);
      return Array.from({ length: n }, (_, i): Row => {
        const o = r.others[i];
        const head = i === 0
          ? [isoToThai(r.date), r.docNo, label(r), ...j.columns.map((c) => blankZero(r.cells[c.key]))]
          : [null, null, null, ...j.columns.map(() => null)];
        return { cells: [...head, o ? o.name : null, o ? o.code : null, o ? blankZero(o.debit) : null, o ? blankZero(o.credit) : null] };
      });
    });
    rows.push({ cells: [null, null, t.total, ...j.columns.map((c) => c.total), null, null, j.othersTotal.debit, j.othersTotal.credit], style: 'total' });
    main = {
      groups: [{ label: '', span: 3 + j.columns.length }, { label: t.others, span: 4 }],
      columns: [{ label: t.date, width: 10, kind: 'mono' }, { label: t.docNo, width: 10, kind: 'mono' }, { label: t.party[j.book]!, width: 20 },
        ...j.columns.map((c): Column => money(`${t.column(c.side, c.name)} ${c.code}`, 12)),
        { label: t.othersAccount, width: 16 }, { label: t.ref, width: 6, kind: 'mono' }, money(t.debit, 11), money(t.credit, 11)],
      rows,
    };
  }
  const posting: Section = {
    heading: t.posting,
    columns: [{ label: t.ref, width: 8, kind: 'mono' }, { label: t.othersAccount, width: 34 }, { label: '', width: 14 }, money(t.debit, 14), money(t.credit, 14)],
    rows: [
      ...j.posting.map((p): Row => ({ cells: [p.code, p.name, t.via[p.via]!, blankZero(p.debit), blankZero(p.credit)] })),
      { cells: [null, t.total, null, j.totalDebit, j.totalCredit], style: 'total' },
    ],
  };
  return {
    fileName: fileName(title, company, j.month), sheetName: title, company, title,
    subtitle: th.export.period(monthLabel(j.month)), orientation: general ? 'portrait' : 'landscape', printedAt: printedAt(now),
    sections: j.rows.length ? [main, posting] : [{ columns: [{ label: t.account, width: 60 }], rows: [{ cells: [t.empty] }] }],
    notes: [j.balanced ? t.balanced(formatMoney(j.totalDebit)) : t.unbalanced(formatMoney(j.totalDebit), formatMoney(j.totalCredit)), t.postingNote, t.rule, th.export.unit],
  };
}

/** งบกระแสเงินสด (docs/phase6-spec.md ข้อ 2) บรรทัดชุดเดียวกับหน้าจอ */
export function cashFlowReport(company: string, cf: CashFlow, method: 'indirect' | 'direct', now = new Date()): Report {
  const t = th.cashFlow;
  const rows: Row[] = cashFlowRows(cf, method).map((r): Row => ({
    cells: [r.code ?? null, r.label, r.amount], ...(r.style === 'line' ? { indent: 1 } : { style: r.style }),
  }));
  const sections: Section[] = [{
    heading: `${t.title} (${method === 'indirect' ? t.indirect : t.direct}) · ${t.period(company, monthLabel(cf.from), monthLabel(cf.month))}`,
    columns: [{ label: th.trialBalance.code, width: 10, kind: 'mono' }, { label: th.ledger.description, width: 52 }, money(th.invoice.amount, 18)],
    rows,
  }, {
    heading: t.cashAccounts,
    columns: [{ label: th.trialBalance.code, width: 10, kind: 'mono' }, { label: th.books.othersAccount, width: 34 }, money(t.accountOpening, 18), money(t.accountClosing, 18)],
    rows: [...cf.cashAccounts.map((a): Row => ({ cells: [a.code, a.name, a.opening, a.closing] })),
      { cells: [null, th.books.total, cf.openingCash, cf.ledgerCash], style: 'total' }],
  }];
  if (cf.nonCash.length) sections.push({
    heading: t.nonCash,
    columns: [{ label: th.books.docNo, width: 12, kind: 'mono' }, { label: th.books.date, width: 12, kind: 'mono' }, { label: th.ledger.description, width: 38 }, money(th.invoice.amount, 16)],
    rows: cf.nonCash.map((n): Row => ({ cells: [n.docNo, isoToThai(n.date), n.description, n.amount] })),
  });
  return {
    fileName: fileName(t.title, company, cf.month), sheetName: t.title, company, title: t.title,
    subtitle: `${cf.scope === 'month' ? th.statements.scopeMonth : th.statements.scopeYtd} · ${th.export.asOf(monthEndLabel(cf.month))}`,
    orientation: 'portrait', printedAt: printedAt(now), sections,
    notes: [cf.matches ? t.matches(formatMoney(cf.closingCash)) : t.mismatch(formatMoney(cf.closingCash), formatMoney(cf.ledgerCash)), t.note, th.export.unit],
  };
}

/** งบแสดงการเปลี่ยนแปลงส่วนของเจ้าของ (docs/phase6-spec.md ข้อ 3) */
export function equityChangesReport(company: string, e: EquityChanges, now = new Date()): Report {
  const t = th.equityChanges;
  const L = equityLabels(e);
  return {
    fileName: fileName(L.title, company, e.month), sheetName: L.title.slice(0, 31), company, title: L.title,
    subtitle: `${e.scope === 'month' ? th.statements.scopeMonth : th.statements.scopeYtd} · ${t.period(company, monthLabel(e.from), monthLabel(e.month))}`,
    orientation: 'landscape', printedAt: printedAt(now),
    sections: [{
      columns: [{ label: t.item, width: 30 }, ...e.columns.map((c) => money(L.column(c), 16)), money(t.total, 16)],
      rows: e.rows.map((r): Row => ({
        cells: [L.row(r.key), ...e.columns.map((c) => r.values[c.key] ?? null), r.total],
        ...(r.key === 'closing' ? { style: 'total' as const } : r.key === 'opening' ? { style: 'subtotal' as const } : { indent: 1 }),
      })),
    }],
    notes: [e.matches ? t.matches(formatMoney(e.positionEquity)) : t.mismatch(formatMoney(e.rows.at(-1)?.total ?? '0.00'), formatMoney(e.positionEquity)), L.note, th.export.unit],
  };
}

const WS_GROUPS: Record<number, ('tb' | 'adj' | 'atb' | 'is' | 'bs')[]> = { 6: ['tb', 'is', 'bs'], 8: ['tb', 'adj', 'is', 'bs'], 10: ['tb', 'adj', 'atb', 'is', 'bs'] };

export function worksheetReport(company: string, ws: Worksheet, now = new Date()): Report {
  const w = th.worksheet;
  const format = ws.format ?? 10;
  const groups = WS_GROUPS[format] ?? WS_GROUPS[10]!;
  const pair = (p: WsPair | null | undefined) => [blankZero(p?.debit), blankZero(p?.credit)];
  const rows: Row[] = (ws.rows ?? []).map((r) => ({ cells: [r.code, r.name, ...groups.flatMap((g) => pair(r[g]))] }));
  if (ws.totals) {
    rows.push({ cells: [null, w.total, ...groups.flatMap((g) => [ws.totals![g].debit, ws.totals![g].credit])], style: 'subtotal' });
    const loss = (ws.netIncome ?? '0').startsWith('-');
    rows.push({ cells: [null, loss ? w.loss : w.profit, ...groups.flatMap((g) => (g === 'is' || g === 'bs' ? pair(ws.result![g]) : [null, null]))] });
    rows.push({ cells: [null, w.total, ...groups.flatMap((g) => (g === 'is' || g === 'bs' ? [ws.grand![g].debit, ws.grand![g].credit] : [null, null]))], style: 'total' });
  }
  return {
    fileName: fileName(w.title, company, `${ws.month} ${w.format(format)}`), sheetName: w.title, company, title: `${w.title} ${w.format(format)}`,
    subtitle: th.export.asOf(monthEndLabel(ws.month)), orientation: 'landscape', printedAt: printedAt(now),
    sections: [{
      groups: [{ label: '', span: 2 }, ...groups.map((g) => ({ label: w.groups[g], span: 2 }))],
      columns: [{ label: w.code, width: 7, kind: 'mono' }, { label: w.account, width: 24 },
        ...groups.flatMap((): Column[] => [money(w.dr, 11), money(w.cr, 11)])],
      rows,
    }],
    notes: [w.note, ...(format === 6 ? [w.noteSix] : []), th.export.unit],
  };
}

/** คะแนน: สรุปรายคน (+ รายข้อเมื่อไม่เกิน maxItemColumns ข้อ) แถวสุดท้ายเป็นค่าเฉลี่ย (คิดเป็นสตางค์ BigInt) */
export function scoresReport(ov: AssignmentOverview, opts: { maxItemColumns?: number; orientation?: 'portrait' | 'landscape' } = {}, now = new Date()): Report {
  const a = th.assignment;
  const a4 = ov.assignment;
  // งานสลับชุด: เพิ่มคอลัมน์ชุด และคอลัมน์รายข้อตามชุดที่มีข้อมากสุด (ข้อที่ n ของแต่ละคน = ข้อที่ n ของชุดตัวเอง)
  const sets = ov.sets ?? [];
  const multi = sets.length > 1;
  const itemNos = multi ? Array.from({ length: Math.max(...sets.map((x) => x.items.length)) }, (_, i) => i + 1) : ov.items.map((i) => i.no);
  const showItems = itemNos.length <= (opts.maxItemColumns ?? Infinity);
  const graded = ov.students.filter((s) => s.grade);
  const sum = graded.reduce((acc, s) => acc + (toCents(s.grade!.score) ?? 0n), 0n);
  const avg = graded.length ? (sum * 2n + BigInt(graded.length)) / (2n * BigInt(graded.length)) : 0n; // ปัดครึ่งขึ้น
  const status = (s: AssignmentOverview['students'][number]) =>
    !s.companyId ? a.noCompany
      : s.lockReason ? a.lock[s.lockReason]
        : a4.mode === 'exam' && s.deadline ? a.exam.running(new Date(s.deadline).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bangkok' }))
          : s.status ? th.work.state[s.status] : '';
  const columns: Column[] = [
    { label: a.code, width: 11, kind: 'mono' }, { label: a.name, width: 24 },
    ...(multi ? [{ label: a.set, width: 7 } as Column] : []),
    { label: a.score, width: 11, kind: 'money' }, { label: a.correct, width: 7, kind: 'number' },
    { label: a.teacherScore, width: 9, kind: 'money' }, { label: a.status, width: 14 },
    ...(showItems ? itemNos.map((no): Column => ({ label: a.item(no), width: 6, kind: 'money' })) : []),
  ];
  const rows: Row[] = ov.students.map((s) => ({
    cells: [s.studentCode, s.name, ...(multi ? [s.setNo ? th.assign.setLabel(s.setNo) : null] : []),
      s.grade?.score ?? null, s.grade ? String(s.grade.correct) : null, s.teacherScore, status(s),
      ...(showItems ? itemNos.map((no) => s.grade?.items.find((x) => x.no === no)?.earned ?? null) : [])],
  }));
  rows.push({ cells: [null, `${a.average} (${a.count(graded.length)})`, ...(multi ? [null] : []), fromCents(avg), null, null, null,
    ...(showItems ? itemNos.map(() => null) : [])], style: 'total' });
  const total = (items: { points: string }[]) => fromCents(items.reduce((acc, i) => acc + (toCents(i.points) ?? 0n), 0n));
  const max = multi ? sets.map((x) => `${th.assign.setLabel(x.no)} ${total(x.items)}`).join(' · ')
    : graded[0]?.grade?.maxScore ?? total(ov.items);
  return {
    fileName: fileName(th.export.scores, a4.title, a4.classroom ?? ''), sheetName: th.export.scores, company: a4.title,
    title: th.export.scoresTitle(a4.classroom ?? ''),
    subtitle: `${th.assign.modes[a4.mode]} · ${a4.companyName} · ${th.export.maxScore(max)}`,
    orientation: opts.orientation ?? (showItems && itemNos.length > 6 ? 'landscape' : 'portrait'), printedAt: printedAt(now),
    sections: [{ columns, rows }],
    notes: showItems ? [] : [th.export.itemsInExcel],
  };
}

/** รายงานเงินเดือนของเดือน: รายคน · นำส่ง · สรุปทั้งปีรายคน (docs/phase7-spec.md ข้อ 3) */
export function payrollReport(company: string, p: PayrollPage, now = new Date()): Report {
  const t = th.payroll;
  const run = p.runs.find((r) => !r.voided);
  const lines = run ? p.lines.filter((l) => l.runId === run.id) : [];
  const y = String(Number(p.month.slice(0, 4)) + 543);
  return {
    fileName: fileName(t.exportTitle, company, p.month), sheetName: t.exportTitle, company, title: t.exportTitle,
    subtitle: t.run(monthLabel(p.month)), orientation: 'landscape', printedAt: printedAt(now),
    sections: [
      {
        heading: run ? `${t.run(monthLabel(p.month))} · ${run.docNo} · ${t.paidOn(isoToThai(run.payDate))}` : t.notYet,
        columns: [{ label: t.code, width: 8, kind: 'mono' }, { label: t.name, width: 24 }, money(t.salary, 13), money(t.otherIncome, 13),
          money(t.wageBase, 13), money(t.ssoEmployee, 13), money(t.ssoEmployer, 13), money(t.wht, 13), money(t.net, 14)],
        rows: [
          ...lines.map((l): Row => ({ cells: [l.code, l.name, l.salary, l.otherIncome, l.wageBase, l.ssoEmployee, l.ssoEmployer, l.wht, l.net] })),
          ...(run ? [{ cells: [null, t.total, null, null, null, run.ssoEmployee, run.ssoEmployer, run.wht, run.net], style: 'total' } as Row] : []),
        ],
      },
      {
        heading: t.year(y),
        columns: [{ label: t.code, width: 8, kind: 'mono' }, { label: t.name, width: 24 }, { label: t.months, width: 8, kind: 'number' },
          money(t.income, 15), money(t.ssoEmployee, 15), money(t.wht, 15)],
        rows: p.year.map((r): Row => ({ cells: [r.code, r.name, String(r.months), r.income, r.sso, r.wht] })),
      },
    ],
    notes: [t.note(formatMoney(p.ceiling)), th.export.unit],
  };
}
