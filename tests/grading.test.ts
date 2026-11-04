import { describe, it, expect, afterAll } from 'vitest';
import { pool } from './helpers';

// ตัวตรวจคำตอบ app.grade_match (เฟส 4) เทียบกับตัวอ้างอิงที่เขียนแยกใน TypeScript ด้วยข้อมูลสุ่ม
// และกรณีที่ครูต้องการ: ไม่สนลำดับบรรทัด แยกบรรทัดบัญชีเดียวกันได้ วันที่ผิด ยอดผิด ไม่ได้ลง รายการเกิน
afterAll(() => pool.end());

type Key = string[];
type Item = { no: number; date: string; points: string; key: Key };
type Entry = { id: string; doc: string; date: string; key: Key };
type Out = {
  items: { no: number; status: string; earned: string; points: string; docNo: string | null; missing: string[]; extra: string[] }[];
  extraEntries: { docNo: string }[]; score: string; maxScore: string; correct: number; total: number;
};

const grade = async (items: Item[], entries: Entry[], checkDate = true) =>
  (await pool.query('select app.grade_match($1::jsonb, $2::jsonb, $3) g', [JSON.stringify(items), JSON.stringify(entries), checkDate])).rows[0].g as Out;

/** ตัวอ้างอิง: อัลกอริทึมเดียวกับ docs/phase4-spec.md ข้อ 3 เขียนตรง ๆ */
function reference(items: Item[], entries: Entry[], checkDate: boolean) {
  const used = entries.map(() => false);
  const same = (a: Key, b: Key) => a.length === b.length && [...a].sort().join() === [...b].sort().join();
  const out = items.map((it) => {
    let best = entries.findIndex((e, k) => !used[k] && same(e.key, it.key) && (!checkDate || e.date === it.date));
    let status = best >= 0 ? 'correct' : 'missing';
    if (best < 0 && checkDate) {
      best = entries.findIndex((e, k) => !used[k] && same(e.key, it.key));
      if (best >= 0) status = 'date';
    }
    if (best < 0) {
      let n = 0;
      entries.forEach((e, k) => {
        if (used[k] || (checkDate && e.date !== it.date)) return;
        const c = it.key.filter((x) => e.key.includes(x)).length;
        if (c > n) { n = c; best = k; }
      });
      if (best >= 0) status = 'wrong';
    }
    if (best >= 0) used[best] = true;
    const e = best >= 0 ? entries[best]! : null;
    return {
      no: it.no, status, docNo: e?.doc ?? null,
      missing: status === 'wrong' ? it.key.filter((x) => !e!.key.includes(x)).sort() : [],
      extra: status === 'wrong' ? e!.key.filter((x) => !it.key.includes(x)).sort() : [],
      earned: status === 'correct' ? it.points : '0',
    };
  });
  return { items: out, extra: entries.filter((_, k) => !used[k]).map((e) => e.doc) };
}

let seed = 20261110;
const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
const CODES = ['1110', '1120', '1130', '1140', '1310', '2110', '3110', '4110', '5110', '5120'];
const amount = () => `${rnd(90000) + 1}.${String(rnd(100)).padStart(2, '0')}`;
const day = (d: number) => `2026-10-${String(d).padStart(2, '0')}`;

function randomKey(): Key {
  const [dr, cr] = [CODES[rnd(5)]!, CODES[5 + rnd(5)]!];
  const a = amount();
  if (rnd(3) === 0) {
    const c2 = CODES[rnd(5)] === dr ? '1140' : CODES[rnd(5)]!;
    if (c2 !== dr) return [`${dr}|D|${a}`, `${c2}|D|1.00`, `${cr}|C|${(Number(a) + 1).toFixed(2)}`];
  }
  return [`${dr}|D|${a}`, `${cr}|C|${a}`];
}

describe('app.grade_match', () => {
  it('ตรงกับตัวอ้างอิง 400 ชุดสุ่ม (ถูก วันที่ผิด ยอดผิด บัญชีผิด ไม่ได้ลง รายการเกิน · ตรวจ/ไม่ตรวจวันที่)', async () => {
    for (let round = 0; round < 400; round++) {
      const n = rnd(12) + 1;
      const items: Item[] = Array.from({ length: n }, (_, i) => ({ no: i + 1, date: day(rnd(28) + 1), points: rnd(4) ? '1.00' : '2.50', key: randomKey() }));
      const entries: Entry[] = [];
      let doc = 0;
      for (const it of items) {
        const r = rnd(6);
        const key = [...it.key];
        if (r === 5) continue; // ไม่ได้ลง
        if (r === 1) key[0] = key[0]!.replace(/\|[\d.]+$/, `|${amount()}`); // ยอดผิด (บรรทัดเดบิต)
        if (r === 2) key[0] = key[0]!.replace(/^\d+/, '1150'); // บัญชีผิด
        entries.push({ id: `e${doc}`, doc: `JV-${String(++doc).padStart(4, '0')}`, date: r === 3 ? day(rnd(28) + 1) : it.date, key: key.reverse() });
      }
      for (let k = rnd(3); k > 0; k--) entries.push({ id: `x${doc}`, doc: `JV-${String(++doc).padStart(4, '0')}`, date: day(rnd(28) + 1), key: randomKey() });
      entries.sort((a, b) => a.date.localeCompare(b.date) || a.doc.localeCompare(b.doc));
      const checkDate = rnd(4) !== 0;

      const got = await grade(items, entries, checkDate);
      const want = reference(items, entries, checkDate);
      expect(got.items.map((x) => ({ no: x.no, status: x.status, docNo: x.docNo, missing: [...x.missing].sort(), extra: [...x.extra].sort() })))
        .toEqual(want.items.map(({ earned: _e, ...x }) => x));
      expect(got.extraEntries.map((e) => e.docNo)).toEqual(want.extra);
      const cents = (s: string) => Math.round(Number(s) * 100);
      expect(cents(got.score)).toBe(want.items.reduce((s, x) => s + cents(x.earned), 0));
      expect(cents(got.maxScore)).toBe(items.reduce((s, x) => s + cents(x.points), 0));
      expect(got.correct).toBe(want.items.filter((x) => x.status === 'correct').length);
    }
  });

  it('ไม่สนลำดับบรรทัด · วันที่ผิด = 0 คะแนนแต่บอกว่าเป็นวันที่ · ใกล้เคียงบอกบรรทัดที่ขาด/เกิน · ไม่มีรายการ = ไม่ได้ลง', async () => {
    const items: Item[] = [
      { no: 1, date: '2026-10-01', points: '2.00', key: ['1110|D|50000.00', '3110|C|50000.00'] },
      { no: 2, date: '2026-10-03', points: '1.00', key: ['1310|D|8000.00', '1110|C|3000.00', '2110|C|5000.00'] },
      { no: 3, date: '2026-10-05', points: '1.00', key: ['1110|D|1200.00', '4110|C|1200.00'] },
      { no: 4, date: '2026-10-09', points: '1.00', key: ['5120|D|900.00', '1110|C|900.00'] },
    ];
    const entries: Entry[] = [
      { id: 'a', doc: 'JV-0001', date: '2026-10-01', key: ['3110|C|50000.00', '1110|D|50000.00'] },
      { id: 'b', doc: 'JV-0002', date: '2026-10-03', key: ['2110|C|5000.00', '1310|D|8000.00', '1120|C|3000.00'] },
      { id: 'c', doc: 'JV-0003', date: '2026-10-06', key: ['4110|C|1200.00', '1110|D|1200.00'] },
      { id: 'd', doc: 'JV-0004', date: '2026-10-20', key: ['5110|D|10.00', '1110|C|10.00'] },
    ];
    const g = await grade(items, entries);
    expect(g.items.map((x) => [x.no, x.status, x.earned, x.docNo])).toEqual([
      [1, 'correct', '2.00', 'JV-0001'], [2, 'wrong', '0.00', 'JV-0002'], [3, 'date', '0.00', 'JV-0003'], [4, 'missing', '0.00', null],
    ]);
    expect(g.items[1]).toMatchObject({ missing: ['1110|C|3000.00'], extra: ['1120|C|3000.00'] });
    expect(g.extraEntries.map((e) => e.docNo)).toEqual(['JV-0004']);
    expect(g).toMatchObject({ score: '2.00', maxScore: '5.00', correct: 1, total: 4 });

    // ไม่ตรวจวันที่: ข้อ 3 ถูก
    const g2 = await grade(items, entries, false);
    expect(g2.items[2]).toMatchObject({ status: 'correct', earned: '1.00' });
    // รายการเดียวใช้ได้ข้อเดียว: โจทย์ซ้ำสองข้อ ลงครั้งเดียว ได้ข้อเดียว
    const twice = await grade([items[0]!, { ...items[0]!, no: 2 }], [entries[0]!]);
    expect(twice.items.map((x) => x.status)).toEqual(['correct', 'missing']);
    // ไม่มีข้อ/ไม่มีรายการ
    expect(await grade([], [])).toMatchObject({ items: [], extraEntries: [], score: '0.00', correct: 0, total: 0 });
  });
});
