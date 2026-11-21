import { th } from '../i18n/th';
import type { CashFlow } from './api';

// บรรทัดของงบกระแสเงินสดชุดเดียว ใช้ทั้งหน้าจอและไฟล์ส่งออก (ตัวเลขตรงกันเสมอ)
export type CfRow = { label: string; amount: string | null; style: 'heading' | 'line' | 'subtotal' | 'total'; code?: string };

const neg = (v: string) => v.startsWith('-');

export function cashFlowRows(cf: CashFlow, method: 'indirect' | 'direct'): CfRow[] {
  const t = th.cashFlow;
  const rows: CfRow[] = [{ label: t.operating, amount: null, style: 'heading' }];
  if (method === 'indirect') {
    rows.push({ label: t.netIncome, amount: cf.operating.netIncome, style: 'line' });
    if (cf.operating.adjustments.length) {
      rows.push({ label: t.adjustHeading, amount: null, style: 'heading' });
      for (const a of cf.operating.adjustments) rows.push({ label: neg(a.amount) ? t.deduct(a.name) : t.addBack(a.name), amount: a.amount, style: 'line', code: a.code });
    }
    if (cf.operating.workingCapital.length) {
      rows.push({ label: t.wcHeading, amount: null, style: 'heading' });
      for (const w of cf.operating.workingCapital) {
        const pos = !neg(w.amount);
        rows.push({ label: w.kind === 'asset' ? t.assetChange(w.name, pos) : t.liabilityChange(w.name, pos), amount: w.amount, style: 'line', code: w.code });
      }
    }
  } else {
    if (!cf.operating.direct.length) rows.push({ label: t.none, amount: null, style: 'line' });
    for (const d of cf.operating.direct) rows.push({ label: t.directLines[d.key] ?? d.key, amount: d.amount, style: 'line' });
  }
  rows.push({ label: t.netOperating, amount: cf.operating.total, style: 'subtotal' });
  rows.push({ label: t.investing, amount: null, style: 'heading' });
  if (!cf.investing.lines.length) rows.push({ label: t.none, amount: null, style: 'line' });
  for (const l of cf.investing.lines) rows.push({ label: l.kind === 'in' ? t.investIn(l.name) : t.investOut(l.name), amount: l.amount, style: 'line', code: l.code });
  rows.push({ label: t.netInvesting, amount: cf.investing.total, style: 'subtotal' });
  rows.push({ label: t.financing, amount: null, style: 'heading' });
  if (!cf.financing.lines.length) rows.push({ label: t.none, amount: null, style: 'line' });
  for (const l of cf.financing.lines) rows.push({ label: l.kind === 'in' ? t.finIn(l.name) : t.finOut(l.name), amount: l.amount, style: 'line', code: l.code });
  rows.push({ label: t.netFinancing, amount: cf.financing.total, style: 'subtotal' });
  rows.push({ label: t.netChange, amount: cf.netChange, style: 'subtotal' });
  rows.push({ label: t.opening, amount: cf.openingCash, style: 'line' });
  rows.push({ label: t.closing, amount: cf.closingCash, style: 'total' });
  return rows;
}
