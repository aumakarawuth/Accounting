import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { th } from '../apps/web/i18n/th';
import { color } from '../apps/web/design/tokens';
import { formatMoney, isNegative } from '../apps/web/lib/money';

// เก็บทุกข้อความใน th.ts (ฟังก์ชันเรียกด้วยค่าตัวอย่าง)
function collect(node: unknown, out: string[] = []): string[] {
  if (typeof node === 'string') out.push(node);
  else if (typeof node === 'function') out.push(String(node(...Array(4).fill('1'))));
  else if (node && typeof node === 'object') for (const v of Object.values(node)) collect(v, out);
  return out;
}

describe('ข้อความหน้าจอ (i18n/th.ts)', () => {
  const all = collect(th);

  it('ไม่มีคำและเครื่องหมายต้องห้าม', () => {
    const banned = [/!/, /ยินดีต้อนรับ/, /ปลดล็อก/, /ยกระดับ/, /ราบรื่น/, /เกิดข้อผิดพลาดบางอย่าง/, /บันทึกสำเร็จ/, /ยังไม่มีข้อมูล/, /→/];
    for (const s of all) for (const b of banned) expect(s, s).not.toMatch(b);
  });

  it('ไม่มีอีโมจิ', () => {
    for (const s of all) expect(s, s).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it('ชื่อการกระทำคงเดิมตลอดเส้นทาง: ปุ่มผ่านรายการ → ข้อความผ่านรายการเลขที่', () => {
    expect(th.journal.post).toBe('ผ่านรายการ');
    expect(th.journal.posted('JV-0042')).toBe('ผ่านรายการเลขที่ JV-0042');
    expect(th.stamp.posted).toBe(th.journal.post);
  });

  it('ข้อความไม่ดุลตรงกับที่ DB ส่ง (ACC01)', () => {
    expect(th.error.ACC01('12,500.00', '12,000.00', '500.00')).toBe('เดบิต 12,500.00 ไม่เท่าเครดิต 12,000.00 ผลต่าง 500.00');
  });
});

describe('design tokens', () => {
  it('tokens.css ตรงกับ tokens.ts', () => {
    const css = readFileSync(new URL('../apps/web/design/tokens.css', import.meta.url), 'utf8');
    const kebab = (k: string) => k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
    for (const [k, v] of Object.entries(color)) {
      expect(css, k).toMatch(new RegExp(`--${kebab(k)}:\\s*${v};`, 'i'));
    }
  });

  // WCAG 2.x contrast
  const lum = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a: string, b: string) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };

  it.each([
    ['ink', 'paper'], ['ink', 'ground'], ['ink', 'band'],
    ['ink2', 'paper'], ['ink2', 'ground'], ['ink2', 'band'],
    ['red', 'paper'], ['red', 'ground'], ['red', 'band'],
    ['paper', 'ink'],
  ] as const)('คอนทราสต์ %s บน %s ≥ 4.5 (WCAG AA)', (fg, bg) => {
    expect(ratio(color[fg], color[bg])).toBeGreaterThanOrEqual(4.5);
  });

  it('เส้นช่องกรอกแยกจากพื้นได้ ≥ 3:1 (WCAG 1.4.11)', () => {
    expect(ratio(color.ruleInput, color.paper)).toBeGreaterThanOrEqual(3);
  });
});

describe('จัดรูปแบบเงินโดยไม่ใช้ float', () => {
  it.each([
    ['0', '0.00'], ['5', '5.00'], ['12500.5', '12,500.50'], ['1234567.89', '1,234,567.89'],
    ['-1250', '(1,250.00)'], ['-0.00', '0.00'], ['007.10', '7.10'],
    ['9999999999999999.99', '9,999,999,999,999,999.99'],
  ])('%s → %s', (input, out) => expect(formatMoney(input)).toBe(out));

  it('แบบเครื่องหมายลบ และตรวจค่าติดลบ', () => {
    expect(formatMoney('-3.5', 'plain')).toBe('-3.50');
    expect(isNegative('-0.01')).toBe(true);
    expect(isNegative('-0.00')).toBe(false);
  });

  it('ปฏิเสธค่าที่ไม่ใช่ทศนิยม 2 ตำแหน่ง', () => {
    for (const bad of ['1.234', '1e5', 'abc', '', '1,000.00']) expect(() => formatMoney(bad)).toThrow();
  });
});
