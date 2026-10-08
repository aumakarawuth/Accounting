// รายการบัญชีที่เอกสารขาย/ซื้อจะสร้าง คิดบนหน้าจอด้วยกติกาเดียวกับฟังก์ชันใน DB
// (acc.post_sales_document / acc.post_purchase_document migration 015/016) มีเทสต์เทียบกับรายการจริงทุกสตางค์
// ใช้แสดงตัวอย่างก่อนบันทึก และส่งให้ครูดูร่างสด · DB คิดซ้ำเองตอนบันทึก ไม่เชื่อค่าจากหน้าจอ

export type EntryLine = { code: string; debit: bigint; credit: bigint };

/** แบ่งยอดลงบัญชีตามสัดส่วนจำนวนเงินรายบรรทัด ตัดทศนิยม เศษสตางค์ไปบัญชีที่ยอดมากสุด (เท่ากันเอารหัสน้อยกว่า) */
export function splitShares(lines: { code: string; amount: bigint }[], split: bigint): { code: string; share: bigint }[] {
  const by = new Map<string, bigint>();
  for (const l of lines) by.set(l.code, (by.get(l.code) ?? 0n) + l.amount);
  const gross = [...by.values()].reduce((a, b) => a + b, 0n);
  if (gross === 0n) return [];
  const rows = [...by].map(([code, amt]) => ({ code, amt, share: (split * amt) / gross }));
  const top = [...rows].sort((a, b) => (b.amt === a.amt ? (a.code < b.code ? -1 : 1) : b.amt > a.amt ? 1 : -1))[0]!;
  top.share += split - rows.reduce((s, r) => s + r.share, 0n);
  return rows.filter((r) => r.share > 0n).map(({ code, share }) => ({ code, share }));
}

type Totals = { base: bigint; vat: bigint; total: bigint };

export function salesEntry(o: Totals & {
  kind: 'sales_invoice' | 'cash_sale' | 'credit_note' | 'debit_note';
  lines: { code: string; amount: bigint }[]; service: boolean; cashAccount: string; wht: bigint;
}): EntryLine[] {
  const shares = splitShares(o.lines, o.base);
  const vatCode = o.service && o.kind !== 'cash_sale' ? '2211' : '2210';
  const dr = (code: string, v: bigint): EntryLine => ({ code, debit: v, credit: 0n });
  const cr = (code: string, v: bigint): EntryLine => ({ code, debit: 0n, credit: v });
  if (o.kind === 'credit_note') {
    return [...shares.map((s) => dr(s.code, s.share)), ...(o.vat > 0n ? [dr(vatCode, o.vat)] : []), cr('1210', o.total)];
  }
  const head = o.kind === 'cash_sale'
    ? [dr(o.cashAccount, o.total - o.wht), ...(o.wht > 0n ? [dr('1420', o.wht)] : [])]
    : [dr('1210', o.total)];
  return [...head, ...shares.map((s) => cr(s.code, s.share)), ...(o.vat > 0n ? [cr(vatCode, o.vat)] : [])];
}

export function purchaseEntry(o: Totals & {
  kind: 'purchase_invoice' | 'cash_purchase' | 'purchase_credit_note';
  lines: { code: string; amount: bigint }[]; service: boolean; claimable: boolean; cashAccount: string; wht: bigint;
}): EntryLine[] {
  const claim = o.claimable && o.vat > 0n;
  const shares = splitShares(o.lines, claim ? o.base : o.total);
  const dr = (code: string, v: bigint): EntryLine => ({ code, debit: v, credit: 0n });
  const cr = (code: string, v: bigint): EntryLine => ({ code, debit: 0n, credit: v });
  if (o.kind === 'purchase_credit_note') {
    return [dr('2110', o.total), ...shares.map((s) => cr(s.code, s.share)), ...(claim ? [cr(o.service ? '1411' : '1410', o.vat)] : [])];
  }
  const vatCode = o.service && o.kind === 'purchase_invoice' ? '1411' : '1410';
  const tail = o.kind === 'cash_purchase'
    ? [cr(o.cashAccount, o.total - o.wht), ...(o.wht > 0n ? [cr('2230', o.wht)] : [])]
    : [cr('2110', o.total)];
  return [...shares.map((s) => dr(s.code, s.share)), ...(claim ? [dr(vatCode, o.vat)] : []), ...tail];
}

/** หัก ณ ที่จ่าย: ฐาน = มูลค่าก่อน VAT ของแต่ละส่วนที่จ่าย ปัดสตางค์ แล้วรวม × อัตรา ปัดสตางค์ (เหมือน acc.post_payment) */
const divRound = (a: bigint, b: bigint) => (2n * a + b) / (2n * b);
export function whtFor(parts: { amount: bigint; base: bigint; total: bigint }[], rateHundredths: bigint) {
  const base = parts.reduce((s, p) => s + divRound(p.amount * p.base, p.total), 0n);
  return { base, amount: divRound(base * rateHundredths, 10000n) };
}
