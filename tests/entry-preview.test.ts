import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { pool as db, asUser, newSchool, newUser, newClassroom, newCompany, taxId } from './helpers';
import { lineAmount, vatCalc, type PriceMode } from '../apps/web/lib/vat';
import { purchaseEntry, salesEntry, whtFor } from '../apps/web/lib/entry-preview';
import { fromCents, toCents } from '../apps/web/lib/money';

// รายการบัญชีที่หน้าจอแสดงก่อนบันทึก (lib/entry-preview.ts) ต้องตรงกับที่ฟังก์ชันใน DB ลงจริงทุกบรรทัดทุกสตางค์
afterAll(async () => { await db.end(); });

let owner: string, co: string;
beforeAll(async () => {
  const school = await newSchool();
  const teacher = await newUser(school, 'teacher');
  owner = await newUser(school, 'student');
  const room = await newClassroom(school, teacher, [owner]);
  co = await newCompany(owner, room);
  await db.query(`update acc.companies set tax_id = $2, version = version + 1 where id = $1`, [co, taxId(5)]);
  await db.query(`insert into acc.parties (company_id, code, name, is_customer, is_vendor, vat_registered, tax_id) values
    ($1, 'P1', 'คู่ค้าจด VAT', true, true, true, $2), ($1, 'P2', 'คู่ค้าไม่จด', true, true, false, $3)`, [co, taxId(6), taxId(7)]);
});

let seed = 99;
const rnd = (n: number) => { seed = (seed * 48271) % 2147483647; return seed % n; };
const money = (max: number) => (rnd(max * 100) / 100 + 0.01).toFixed(2);
const pick = <T,>(xs: T[]) => xs[rnd(xs.length)]!;
const fmt = (lines: { code: string; debit: bigint; credit: bigint }[]) =>
  lines.map((l) => [l.code, fromCents(l.debit), fromCents(l.credit)]).sort((a, b) => (a.join() < b.join() ? -1 : 1));

async function dbEntry(table: string, id: string) {
  const r = await db.query(
    `select a.code, l.debit::text, l.credit::text from ${table} d
       join acc.journal_lines l on l.company_id = d.company_id and l.entry_id = d.entry_id
       join acc.chart_of_accounts a on a.company_id = l.company_id and a.id = l.account_id where d.id = $1`, [id]);
  return r.rows.map((x) => [x.code, x.debit, x.credit]).sort((a, b) => (a.join() < b.join() ? -1 : 1));
}

function randomLines(codes: string[]) {
  return Array.from({ length: rnd(4) + 1 }, () => ({ description: 'ทดสอบ', qty: String(rnd(5) + 1) + (rnd(3) ? '' : '.5'), unit_price: money(5000), account_code: pick(codes) }));
}
const amounts = (lines: { qty: string; unit_price: string; account_code: string }[]) =>
  lines.map((l) => ({ code: l.account_code, amount: lineAmount(l.qty, toCents(l.unit_price)!)! }));

describe('ตัวอย่างรายการบัญชีบนหน้าจอ = รายการที่ DB ลงจริง', () => {
  it('เอกสารขาย 150 ใบสุ่ม (ขายเชื่อ/ขายสด/ลดหนี้/เพิ่มหนี้ สินค้า/บริการ แยก/รวมภาษี ส่วนลด หัก ณ ที่จ่าย)', async () => {
    const ivs: { id: string; service: boolean; mode: PriceMode; open: bigint }[] = [];
    for (let i = 0; i < 150; i++) {
      const kind = ivs.length && rnd(3) === 0 ? pick(['credit_note', 'debit_note'] as const) : pick(['sales_invoice', 'cash_sale'] as const);
      const ref = kind === 'credit_note' || kind === 'debit_note' ? pick(ivs) : null;
      const service = ref ? ref.service : rnd(2) === 0;
      const mode: PriceMode = ref ? ref.mode : pick(['exclusive', 'inclusive'] as const);
      let lines = randomLines(['4110', '4120', '4320', '4310']);
      if (kind === 'credit_note') lines = [{ description: 'ลด', qty: '1', unit_price: fromCents(ref!.open / 3n + 1n), account_code: pick(['4220', '4210']) }];
      const gross = amounts(lines).reduce((s, l) => s + l.amount, 0n);
      const discount = kind !== 'credit_note' && rnd(3) === 0 ? gross / 10n : 0n;
      const t = vatCalc(gross, discount, '7', mode);
      const wht = kind === 'cash_sale' && rnd(2) === 0 ? t.base * 3n / 100n : 0n;
      const id = await asUser(owner, (c) => c.query('select acc.post_sales_document($1, $2, $3::jsonb, $4) id', [co, kind, JSON.stringify({
        date: '2026-10-05', party_code: 'P1', is_service: service, price_mode: mode, discount: fromCents(discount), lines,
        ref_document_id: ref?.id, reason: ref ? 'ทดสอบ' : undefined, cash_account: '1120', wht_amount: fromCents(wht),
      }), randomUUID()]).then((r) => r.rows[0].id as string));
      if (kind === 'sales_invoice') ivs.push({ id, service, mode, open: t.total });
      if (kind === 'credit_note') ref!.open -= t.total;
      const expected = salesEntry({ kind, lines: amounts(lines), ...t, service, cashAccount: '1120', wht });
      expect(fmt(expected)).toEqual(await dbEntry('acc.documents', id));
    }
  });

  it('เอกสารซื้อ 150 ใบสุ่ม (ซื้อเชื่อ/ซื้อสด/ลดหนี้ ผู้ขายจด/ไม่จด VAT หัก ณ ที่จ่าย) และยอดหักของการจ่ายชำระ', async () => {
    const pis: { id: string; service: boolean; mode: PriceMode; claim: boolean; open: bigint; base: bigint; total: bigint }[] = [];
    for (let i = 0; i < 150; i++) {
      const kind = pis.length && rnd(4) === 0 ? 'purchase_credit_note' : pick(['purchase_invoice', 'cash_purchase'] as const);
      const ref = kind === 'purchase_credit_note' ? pick(pis.filter((p) => p.open > 10n)) ?? null : null;
      if (kind === 'purchase_credit_note' && !ref) continue;
      const party = ref ? null : pick(['P1', 'P2']);
      const service = ref ? ref.service : rnd(2) === 0;
      const mode: PriceMode = ref ? ref.mode : party === 'P1' ? pick(['exclusive', 'inclusive'] as const) : 'none';
      let lines = randomLines(['5110', '5260', '5220', '1630']);
      if (ref) lines = [{ description: 'ลด', qty: '1', unit_price: fromCents(ref.open / 3n), account_code: pick(['5140', '5260']) }];
      const gross = amounts(lines).reduce((s, l) => s + l.amount, 0n);
      const discount = !ref && rnd(3) === 0 ? gross / 10n : 0n;
      const t = vatCalc(gross, discount, '7', mode);
      const claim = ref ? ref.claim : t.vat > 0n;
      const whtRate = kind === 'cash_purchase' && rnd(2) === 0 ? pick(['1', '3', '5']) : null;
      const wht = whtRate ? whtFor([{ amount: t.total, base: t.base, total: t.total }], BigInt(whtRate) * 100n).amount : 0n;
      const id = await asUser(owner, (c) => c.query('select acc.post_purchase_document($1, $2, $3::jsonb, $4) id', [co, kind, JSON.stringify({
        date: '2026-10-05', party_code: party, vendor_doc_no: randomUUID().slice(0, 12), is_service: service, price_mode: mode === 'none' ? undefined : mode,
        discount: fromCents(discount), lines, ref_document_id: ref?.id, reason: ref ? 'ทดสอบ' : undefined, cash_account: '1130',
        ...(whtRate ? { wht_kind: 'other', wht_rate: whtRate } : {}),
      }), randomUUID()]).then((r) => r.rows[0].id as string));
      if (kind === 'purchase_invoice') pis.push({ id, service, mode, claim, open: t.total, base: t.base, total: t.total });
      if (ref) ref.open -= t.total;
      const expected = purchaseEntry({ kind, lines: amounts(lines), ...t, service, claimable: claim, cashAccount: '1130', wht });
      expect(fmt(expected)).toEqual(await dbEntry('acc.purchase_documents', id));
      const doc = (await db.query('select wht_amount::text from acc.purchase_documents where id = $1', [id])).rows[0];
      expect(doc.wht_amount).toBe(fromCents(wht));
    }
    // จ่ายชำระหลายใบพร้อมหัก: ฐานและยอดหักบนจอเท่ากับใน DB
    for (const party of ['P1', 'P2']) {
      const open = (await db.query(`select o.document_id, o.open, d.base, d.total from acc.ap_open_items($1) o
        join acc.purchase_documents d on d.id = o.document_id where o.party_code = $2 limit 5`, [co, party])).rows;
      const parts = open.map((o) => ({ id: o.document_id, amount: toCents(o.open)! / 2n + 1n, base: toCents(o.base)!, total: toCents(o.total)! }));
      const w = whtFor(parts, 300n);
      const id = await asUser(owner, (c) => c.query('select acc.post_payment($1, $2::jsonb, $3) id', [co, JSON.stringify({
        date: '2026-10-06', party_code: party, wht_kind: 'service', allocations: parts.map((p) => ({ document_id: p.id, amount: fromCents(p.amount) })),
      }), randomUUID()]).then((r) => r.rows[0].id as string));
      const d = (await db.query('select wht_base::text, wht_amount::text from acc.purchase_documents where id = $1', [id])).rows[0];
      expect(d).toEqual({ wht_base: fromCents(w.base), wht_amount: fromCents(w.amount) });
    }
  });
});
