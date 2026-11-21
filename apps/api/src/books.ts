import type pg from 'pg';

// สมุดรายวันเฉพาะ (docs/phase6-spec.md ข้อ 1): มุมมองของรายการที่ลงแล้ว ไม่ลงซ้ำ
// ทุกรายการของเดือนอยู่ในสมุดเล่มเดียว · เงินคิดเป็นสตางค์ (BigInt) ไม่ผ่าน float · ผู้เรียกต้องตรวจสิทธิ์อ่านก่อน

export const BOOKS = ['sales', 'purchases', 'receipts', 'payments', 'general'] as const;
export type BookKey = (typeof BOOKS)[number];

export type BookColumn = { key: string; code: string; name: string; side: 'debit' | 'credit'; total: string };
export type BookOther = { code: string; name: string; debit: string; credit: string; memo: string };
export type BookRow = {
  entryId: string; date: string; docNo: string; vendorDocNo: string | null; party: string | null; description: string;
  /** กลับรายการ: ยอดในคอลัมน์เฉพาะเป็นค่าติดลบ (หักออกจากรายการเดิม) */
  reversal: boolean; reversesDocNo: string | null;
  cells: Record<string, string>;
  /** บรรทัดที่ไม่เข้าคอลัมน์เฉพาะ (สมุดทั่วไป = ทุกบรรทัด) ตามด้านจริงของรายการ */
  others: BookOther[];
};
export type BookPosting = { code: string; name: string; debit: string; credit: string; via: 'column' | 'others' | 'both' };
export type SpecialJournalData = {
  month: string; book: BookKey;
  columns: BookColumn[];
  rows: BookRow[];
  othersTotal: { debit: string; credit: string };
  /** ยอดรวมผ่านไปบัญชีแยกประเภท: คอลัมน์เฉพาะผ่านเป็นยอดรวม ช่องบัญชีอื่น ๆ ผ่านรายตัว (สุทธิต่อบัญชี) */
  posting: BookPosting[];
  totalDebit: string; totalCredit: string; balanced: boolean;
  counts: Record<BookKey, number>;
};

type ColDef = { code: string; side: 'debit' | 'credit'; core?: boolean };
// คอลัมน์เฉพาะตามแบบที่สอน (เงินสด/เงินฝากเพิ่มตามบัญชี 11xx ที่มีรายการ)
const FIXED: Record<Exclude<BookKey, 'general'>, { before: ColDef[]; after: ColDef[]; cash?: 'debit' | 'credit' }> = {
  sales: { before: [{ code: '1210', side: 'debit', core: true }, { code: '4110', side: 'credit', core: true }, { code: '4120', side: 'credit' },
    { code: '2210', side: 'credit', core: true }, { code: '2211', side: 'credit' }], after: [] },
  purchases: { before: [{ code: '5110', side: 'debit', core: true }, { code: '1410', side: 'debit', core: true }, { code: '1411', side: 'debit' },
    { code: '2110', side: 'credit', core: true }], after: [] },
  receipts: { cash: 'debit', before: [], after: [{ code: '4210', side: 'debit' }, { code: '1420', side: 'debit' },
    { code: '1210', side: 'credit', core: true }, { code: '4110', side: 'credit', core: true }, { code: '2210', side: 'credit', core: true }] },
  payments: { cash: 'credit', before: [{ code: '2110', side: 'debit', core: true }, { code: '5110', side: 'debit', core: true },
    { code: '1410', side: 'debit', core: true }, { code: '2230', side: 'credit' }, { code: '5120', side: 'credit' }], after: [] },
};

export const isCashCode = (code: string) => code.startsWith('11');

const toC = (v: string): bigint => {
  const neg = v.startsWith('-');
  const [i, f = ''] = (neg ? v.slice(1) : v).split('.');
  const c = BigInt(i || '0') * 100n + BigInt((f + '00').slice(0, 2));
  return neg ? -c : c;
};
const money = (c: bigint) => {
  const neg = c < 0n;
  const a = neg ? -c : c;
  return `${neg ? '-' : ''}${a / 100n}.${String(a % 100n).padStart(2, '0')}`;
};

type DbLine = { code: string; name: string; type: string; debit: string; credit: string; memo: string };
type DbEntry = {
  id: string; date: string; docNo: string; prefix: string; description: string; book: BookKey;
  reversesDocNo: string | null; party: string | null; vendorDocNo: string | null; lines: DbLine[];
};

/** รายการของเดือนพร้อมสมุดที่จัดให้ (จัดใน SQL ที่เดียว ใช้ร่วมกับเทสต์ตรวจว่าไม่ลงซ้ำ) */
export async function bookEntries(c: pg.PoolClient, companyId: string, month: string): Promise<DbEntry[]> {
  const r = await c.query(
    // แต่ละตารางอ่านครั้งเดียว (materialized + = any(array)) กันแผนวนซ้อนเมื่อบริษัทใหม่ยังไม่มีสถิติ
    `with ents as materialized (
       select e.id, e.entry_date, e.posted_at, e.doc_no, e.doc_prefix, e.description, e.reverses_entry_id,
              coalesce(e.reverses_entry_id, e.id) as subject
         from acc.journal_entries e
        where e.company_id = $1 and e.entry_date >= $2::date and e.entry_date < ($2::date + interval '1 month')
     ), subj as materialized (
       select s.id, s.doc_no, s.doc_prefix from acc.journal_entries s
        where s.company_id = $1 and s.id = any (array(select subject from ents))
     ), sl as materialized (
       select l.entry_id,
              bool_or(a.type = 'asset' and a.code like '11%') as has_cash,
              coalesce(sum(l.debit - l.credit) filter (where a.type = 'asset' and a.code like '11%'), 0) as cash_net
         from acc.journal_lines l join acc.chart_of_accounts a on a.company_id = l.company_id and a.id = l.account_id
        where l.company_id = $1 and l.entry_id = any (array(select id from subj))
        group by l.entry_id
     ), cls as (
       select subj.id,
              case when sl.has_cash and sl.cash_net > 0 then 'receipts'
                   when sl.has_cash then 'payments'
                   when subj.doc_prefix = 'IV' then 'sales'
                   when subj.doc_prefix = 'PI' then 'purchases'
                   else 'general' end as book,
              subj.doc_no
         from subj join sl on sl.entry_id = subj.id
     ), lines as materialized (
       select l.entry_id, json_agg(json_build_object('code', a.code, 'name', a.name, 'type', a.type,
                'debit', l.debit::text, 'credit', l.credit::text, 'memo', l.memo) order by l.line_no) as lines
         from acc.journal_lines l join acc.chart_of_accounts a on a.company_id = l.company_id and a.id = l.account_id
        where l.company_id = $1 and l.entry_id = any (array(select id from ents))
        group by l.entry_id
     ), sdoc as materialized (
       select d.entry_id, d.party_name, null::text as vendor_doc_no from acc.documents d
        where d.company_id = $1 and d.entry_id = any (array(select subject from ents))
       union all
       select p.entry_id, p.party_name, p.vendor_doc_no from acc.purchase_documents p
        where p.company_id = $1 and p.entry_id = any (array(select subject from ents))
       union all
       select q.entry_id, q.party_name, null from acc.cheques q
        where q.company_id = $1 and q.entry_id = any (array(select subject from ents))
     )
     select e.id, e.entry_date::text as date, e.doc_no as "docNo", e.doc_prefix as prefix, e.description,
            cls.book, case when e.reverses_entry_id is null then null else cls.doc_no end as "reversesDocNo",
            (select sd.party_name from sdoc sd where sd.entry_id = e.subject limit 1) as party,
            (select sd.vendor_doc_no from sdoc sd where sd.entry_id = e.subject limit 1) as "vendorDocNo",
            lines.lines
       from ents e join cls on cls.id = e.subject join lines on lines.entry_id = e.id
      order by e.entry_date, e.posted_at, e.doc_no`,
    [companyId, `${month}-01`],
  );
  return r.rows as DbEntry[];
}

export async function specialJournal(c: pg.PoolClient, companyId: string, month: string, book: BookKey): Promise<SpecialJournalData> {
  const all = await bookEntries(c, companyId, month);
  const counts = Object.fromEntries(BOOKS.map((b) => [b, 0])) as Record<BookKey, number>;
  for (const e of all) counts[e.book]++;
  const entries = all.filter((e) => e.book === book);
  const coa = new Map<string, string>(
    (await c.query(`select code, name from acc.chart_of_accounts where company_id = $1`, [companyId])).rows.map((x) => [x.code as string, x.name as string]));

  // คอลัมน์เฉพาะของเล่มนี้
  const defs: ColDef[] = [];
  if (book !== 'general') {
    const f = FIXED[book];
    const cash: ColDef[] = [];
    if (f.cash) {
      const codes = new Set<string>(coa.has('1110') ? ['1110'] : []);
      for (const e of entries) for (const l of e.lines) if (l.type === 'asset' && isCashCode(l.code)) codes.add(l.code);
      for (const code of [...codes].sort()) cash.push({ code, side: f.cash, core: code === '1110' });
    }
    defs.push(...(f.cash === 'debit' ? cash : []), ...f.before, ...f.after, ...(f.cash === 'credit' ? cash : []));
  }
  const keyOf = (d: ColDef) => `${d.side === 'debit' ? 'dr' : 'cr'}${d.code}`;
  const colIndex = new Map(defs.filter((d) => coa.has(d.code)).map((d) => [keyOf(d), d]));

  const totals = new Map<string, bigint>();
  const othersAcc = new Map<string, { name: string; d: bigint; c: bigint }>();
  let oD = 0n, oC = 0n;
  const rows: BookRow[] = entries.map((e) => {
    const rev = e.reversesDocNo !== null;
    const cells = new Map<string, bigint>();
    const others: BookOther[] = [];
    for (const l of e.lines) {
      const d = toC(l.debit), cr = toC(l.credit);
      // กลับรายการ: มองด้านเดิมของรายการต้นทาง แล้วใส่ยอดติดลบในคอลัมน์เดียวกัน
      const origSide: 'debit' | 'credit' = (d > 0n) !== rev ? 'debit' : 'credit';
      const amt = d > 0n ? d : cr;
      const key = `${origSide === 'debit' ? 'dr' : 'cr'}${l.code}`;
      if (book !== 'general' && colIndex.has(key)) {
        cells.set(key, (cells.get(key) ?? 0n) + (rev ? -amt : amt));
      } else {
        others.push({ code: l.code, name: l.name, debit: money(d), credit: money(cr), memo: l.memo });
        const o = othersAcc.get(l.code) ?? { name: l.name, d: 0n, c: 0n };
        o.d += d; o.c += cr; othersAcc.set(l.code, o);
        oD += d; oC += cr;
      }
    }
    for (const [k, v] of cells) totals.set(k, (totals.get(k) ?? 0n) + v);
    return {
      entryId: e.id, date: e.date, docNo: e.docNo, vendorDocNo: e.vendorDocNo, party: e.party,
      description: e.description, reversal: rev, reversesDocNo: e.reversesDocNo,
      cells: Object.fromEntries([...cells].map(([k, v]) => [k, money(v)])), others,
    };
  });

  const columns: BookColumn[] = [...colIndex.values()]
    .filter((d) => d.core || (totals.get(keyOf(d)) ?? 0n) !== 0n || rows.some((r) => keyOf(d) in r.cells))
    .map((d) => ({ key: keyOf(d), code: d.code, name: coa.get(d.code) ?? d.code, side: d.side, total: money(totals.get(keyOf(d)) ?? 0n) }));

  // ยอดผ่านบัญชี: ยอดคอลัมน์ติดลบ (กลับรายการมากกว่า) ผ่านด้านตรงข้าม
  const post = new Map<string, { name: string; d: bigint; c: bigint; col: boolean; oth: boolean }>();
  const at = (code: string, name: string) => {
    const p = post.get(code) ?? { name, d: 0n, c: 0n, col: false, oth: false };
    post.set(code, p);
    return p;
  };
  for (const col of columns) {
    const t = totals.get(col.key) ?? 0n;
    if (t === 0n) continue;
    const p = at(col.code, col.name);
    p.col = true;
    if ((col.side === 'debit') === (t > 0n)) p.d += t > 0n ? t : -t; else p.c += t > 0n ? t : -t;
  }
  for (const [code, o] of othersAcc) {
    const p = at(code, o.name);
    p.oth = true;
    p.d += o.d; p.c += o.c;
  }
  let td = 0n, tc = 0n;
  const posting: BookPosting[] = [...post].sort(([a], [b]) => a.localeCompare(b)).map(([code, p]) => {
    // สุทธิต่อบัญชี (เดบิตกับเครดิตของบัญชีเดียวกันหักกันก่อนผ่าน)
    const net = p.d - p.c;
    const d = net > 0n ? net : 0n, cr = net < 0n ? -net : 0n;
    td += d; tc += cr;
    const via: BookPosting['via'] = p.col && p.oth ? 'both' : p.col ? 'column' : 'others';
    return { code, name: p.name, debit: money(d), credit: money(cr), via };
  }).filter((p) => p.debit !== '0.00' || p.credit !== '0.00');

  return {
    month, book, columns, rows,
    othersTotal: { debit: money(oD), credit: money(oC) },
    posting, totalDebit: money(td), totalCredit: money(tc), balanced: td === tc,
    counts,
  };
}
