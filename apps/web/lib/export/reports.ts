import { th } from '../../i18n/th';
import type { AssignmentOverview, Ledger, Statements, TrialBalance, Worksheet, WsPair } from '../api';
import { isoToThai, monthEndLabel, monthLabel } from '../date';
import { fromCents, toCents } from '../money';
import type { Column, Report, Row, Section } from './model';

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
  const income: Section = {
    heading: `${s.income} · ${s.incomePeriod(company, monthLabel(st.from), monthLabel(st.month))}`,
    columns: cols,
    rows: [
      { cells: [null, s.revenue, null], style: 'heading' },
      ...lines(st.revenue),
      { cells: [null, s.totalRevenue, st.totalRevenue], style: 'subtotal' },
      { cells: [null, s.expense, null], style: 'heading' },
      ...lines(st.expense),
      { cells: [null, s.totalExpense, st.totalExpense], style: 'subtotal' },
      { cells: [null, loss ? s.netLoss : s.netProfit, loss ? st.netIncome.slice(1) : st.netIncome], style: 'total' },
    ],
  };
  const position: Section = {
    heading: `${s.position} · ${s.positionAt(company, monthEndLabel(st.month))}`,
    columns: cols,
    rows: [
      { cells: [null, s.assets, null], style: 'heading' },
      ...lines(st.assets),
      { cells: [null, s.totalAssets, st.totalAssets], style: 'total' },
      { cells: [null, s.liabilities, null], style: 'heading' },
      ...lines(st.liabilities),
      { cells: [null, s.totalLiabilities, st.totalLiabilities], style: 'subtotal' },
      { cells: [null, s.equity, null], style: 'heading' },
      ...lines(st.equity),
      { cells: [null, s.yearProfit, st.yearProfit], indent: 1 },
      ...((toCents(st.priorUnclosedProfit) ?? 0n) === 0n ? [] : [{ cells: [null, s.priorUnclosed, st.priorUnclosedProfit], indent: 1 } as Row]),
      { cells: [null, s.totalEquity, st.totalEquity], style: 'subtotal' },
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
  const showItems = ov.items.length <= (opts.maxItemColumns ?? Infinity);
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
    { label: a.score, width: 11, kind: 'money' }, { label: a.correct, width: 7, kind: 'number' },
    { label: a.teacherScore, width: 9, kind: 'money' }, { label: a.status, width: 14 },
    ...(showItems ? ov.items.map((i): Column => ({ label: a.item(i.no), width: 6, kind: 'money' })) : []),
  ];
  const rows: Row[] = ov.students.map((s) => ({
    cells: [s.studentCode, s.name, s.grade?.score ?? null, s.grade ? String(s.grade.correct) : null, s.teacherScore, status(s),
      ...(showItems ? ov.items.map((i) => s.grade?.items.find((x) => x.no === i.no)?.earned ?? null) : [])],
  }));
  rows.push({ cells: [null, `${a.average} (${a.count(graded.length)})`, fromCents(avg), null, null, null, ...(showItems ? ov.items.map(() => null) : [])], style: 'total' });
  const max = graded[0]?.grade?.maxScore ?? fromCents(ov.items.reduce((acc, i) => acc + (toCents(i.points) ?? 0n), 0n));
  return {
    fileName: fileName(th.export.scores, a4.title, a4.classroom ?? ''), sheetName: th.export.scores, company: a4.title,
    title: th.export.scoresTitle(a4.classroom ?? ''),
    subtitle: `${th.assign.modes[a4.mode]} · ${a4.companyName} · ${th.export.maxScore(max)}`,
    orientation: opts.orientation ?? (showItems && ov.items.length > 6 ? 'landscape' : 'portrait'), printedAt: printedAt(now),
    sections: [{ columns, rows }],
    notes: showItems ? [] : [th.export.itemsInExcel],
  };
}
