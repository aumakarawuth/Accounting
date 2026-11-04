import PDFDocument from 'pdfkit';
import { formatMoney, isNegative } from '../money';
import { th } from '../../i18n/th';
import { color } from '../../design/tokens';
import { PLEX_THAI_REGULAR, PLEX_THAI_SEMIBOLD } from './fonts';
import type { Column, Report, Section } from './model';

// PDF ภาษาไทย: ฝังฟอนต์ IBM Plex Sans Thai Looped (pdfkit + fontkit จัดสระ/วรรณยุกต์ด้วย GPOS ของฟอนต์)
// ตัดบรรทัดเองตามคำไทยด้วย Intl.Segmenter (pdfkit ตัดได้แค่ที่ช่องว่าง) แล้ววาดทีละบรรทัดโดยไม่ให้ pdfkit ตัดซ้ำ

let fonts: { regular: Buffer; bold: Buffer } | null = null;
const loadFonts = () => (fonts ??= { regular: Buffer.from(PLEX_THAI_REGULAR, 'base64'), bold: Buffer.from(PLEX_THAI_SEMIBOLD, 'base64') });

const words = new Intl.Segmenter('th', { granularity: 'word' });
const graphemes = new Intl.Segmenter('th', { granularity: 'grapheme' });

type Doc = PDFKit.PDFDocument;

/** ตัดข้อความให้พอดีความกว้าง ตามขอบเขตคำ (ภาษาไทยไม่มีช่องว่างระหว่างคำ) */
export function wrapText(doc: Doc, text: string, width: number): string[] {
  const out: string[] = [];
  const fits = (s: string) => doc.widthOfString(s) <= width;
  for (const para of text.split('\n')) {
    let line = '';
    for (const { segment } of words.segment(para)) {
      if (fits(line + segment)) { line += segment; continue; }
      if (line.trim()) { out.push(line.trimEnd()); line = ''; }
      const seg = segment.trimStart();
      if (fits(seg)) { line = seg; continue; }
      // คำเดียวยาวเกินช่อง (เช่น เลขบัญชียาว ๆ) ตัดตามกลุ่มอักษร ไม่แยกสระ/วรรณยุกต์จากพยัญชนะ
      for (const { segment: g } of graphemes.segment(seg)) {
        if (!fits(line + g) && line) { out.push(line); line = ''; }
        line += g;
      }
    }
    out.push(line.trimEnd());
  }
  return out;
}

const PAD_X = 4;
const PAD_Y = 3;

export async function toPdf(report: Report): Promise<Buffer> {
  const { regular, bold } = loadFonts();
  const doc = new PDFDocument({
    size: 'A4', layout: report.orientation, bufferPages: true, font: regular as unknown as string,
    margins: { top: 40, bottom: 44, left: 36, right: 36 }, lang: 'th-TH', displayTitle: true,
    info: { Title: `${report.title} ${report.company}`, Creator: th.app.name, Producer: th.app.name },
  });
  doc.registerFont('r', regular);
  doc.registerFont('b', bold);
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((resolve, reject) => { doc.on('end', resolve); doc.on('error', reject); });

  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  const bottom = () => doc.page.height - doc.page.margins.bottom;
  const size = report.orientation === 'landscape' ? 8 : 9;
  const lh = size * 1.55; // เผื่อสระบน/ล่างและวรรณยุกต์ซ้อน

  const say = (text: string, x: number, y: number, opts: { font?: 'r' | 'b'; size?: number; color?: string; w?: number; align?: 'left' | 'right' | 'center' } = {}) => {
    doc.font(opts.font ?? 'r').fontSize(opts.size ?? size).fillColor(opts.color ?? color.ink);
    let dx = 0;
    if (opts.w !== undefined && opts.align && opts.align !== 'left') {
      const tw = doc.widthOfString(text);
      dx = opts.align === 'right' ? opts.w - tw : (opts.w - tw) / 2;
    }
    doc.text(text, x + dx, y, { lineBreak: false });
  };

  // หัวกระดาษหน้าแรก
  let y = doc.page.margins.top;
  say(report.company, left, y, { font: 'b', size: 14 });
  y += 22;
  say(report.title, left, y, { font: 'b', size: 12 });
  say(report.printedAt, left, y + 2, { size: 8, color: color.ink2, w: width, align: 'right' });
  y += 18;
  for (const line of (doc.font('r').fontSize(10), wrapText(doc, report.subtitle, width))) {
    say(line, left, y, { size: 10, color: color.ink2 });
    y += 15;
  }
  doc.moveTo(left, y + 2).lineTo(left + width, y + 2).lineWidth(1.5).strokeColor(color.ink).stroke();
  y += 10;

  for (const sec of report.sections) y = drawSection(sec, y);

  if (report.notes.length) {
    y += 6;
    doc.font('r').fontSize(size);
    for (const n of report.notes) {
      for (const line of wrapText(doc, n, width)) {
        if (y + lh > bottom()) { doc.addPage(); y = doc.page.margins.top; }
        say(line, left, y, { color: color.ink2 });
        y += lh;
      }
    }
  }

  // ท้ายกระดาษทุกหน้า
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const fy = doc.page.height - doc.page.margins.bottom + 14;
    say(`${report.company} · ${report.title}`, left, fy, { size: 7.5, color: color.ink2 });
    say(th.export.page(i - range.start + 1, range.count), left, fy, { size: 7.5, color: color.ink2, w: width, align: 'right' });
  }
  doc.end();
  await done;
  return Buffer.concat(chunks);

  function colWidths(cols: Column[]) {
    const total = cols.reduce((s, c) => s + c.width, 0);
    return cols.map((c) => (c.width / total) * width);
  }

  function drawSection(sec: Section, y0: number): number {
    let y = y0;
    const ws = colWidths(sec.columns);
    const xs = ws.map((_, i) => left + ws.slice(0, i).reduce((s, w) => s + w, 0));
    if (sec.heading) {
      if (y + 18 + lh * 3 > bottom()) { doc.addPage(); y = doc.page.margins.top; }
      y += 6;
      say(sec.heading, left, y, { font: 'b', size: size + 1.5 });
      y += lh + 4;
    }

    const header = () => {
      if (sec.groups) {
        let c = 0;
        for (const g of sec.groups) {
          const x = xs[c]!;
          const w = ws.slice(c, c + g.span).reduce((s, v) => s + v, 0);
          cellBox(x, y, w, lh + PAD_Y * 2, true);
          if (g.label) say(g.label, x + PAD_X, y + PAD_Y, { font: 'b', w: w - PAD_X * 2, align: 'center' });
          c += g.span;
        }
        y += lh + PAD_Y * 2;
      }
      doc.font('b').fontSize(size);
      const lines = sec.columns.map((col, i) => wrapText(doc, col.label, ws[i]! - PAD_X * 2));
      const h = Math.max(...lines.map((l) => l.length)) * lh + PAD_Y * 2;
      sec.columns.forEach((_, i) => {
        cellBox(xs[i]!, y, ws[i]!, h, true);
        lines[i]!.forEach((l, k) => say(l, xs[i]! + PAD_X, y + PAD_Y + k * lh, { font: 'b', w: ws[i]! - PAD_X * 2, align: 'center' }));
      });
      y += h;
    };
    header();

    for (const row of sec.rows) {
      const strong = row.style === 'total' || row.style === 'subtotal' || row.style === 'heading';
      doc.font(strong ? 'b' : 'r').fontSize(size);
      const cells = sec.columns.map((col, i) => {
        const v = row.cells[i] ?? null;
        if (v === null || v === '') return { lines: [] as string[], neg: false };
        if (col.kind === 'money' && /^-?\d+(\.\d+)?$/.test(v)) return { lines: [formatMoney(v)], neg: isNegative(v) };
        const indent = i === firstText(sec) ? row.indent ?? 0 : 0;
        return { lines: wrapText(doc, v, ws[i]! - PAD_X * 2 - indent * 10), neg: false, indent };
      });
      const h = Math.max(1, ...cells.map((c) => c.lines.length)) * lh + PAD_Y * 2;
      if (y + h > bottom()) { doc.addPage(); y = doc.page.margins.top; header(); }
      sec.columns.forEach((col, i) => {
        cellBox(xs[i]!, y, ws[i]!, h, false);
        const c = cells[i]!;
        const align = col.align ?? (col.kind === 'money' || col.kind === 'number' ? 'right' : 'left');
        const ind = ('indent' in c ? c.indent ?? 0 : 0) * 10;
        c.lines.forEach((l, k) => say(l, xs[i]! + PAD_X + ind, y + PAD_Y + k * lh, {
          font: strong ? 'b' : 'r', color: c.neg ? color.red : color.ink, w: ws[i]! - PAD_X * 2 - ind, align,
        }));
      });
      if (row.style === 'total' || row.style === 'subtotal') {
        doc.lineWidth(row.style === 'total' ? 1.2 : 0.8).strokeColor(color.ink)
          .moveTo(left, y).lineTo(left + width, y).stroke();
      }
      if (row.style === 'total') {
        // เส้นคู่ใต้ยอดเงิน (ธรรมเนียมสมุดบัญชี)
        sec.columns.forEach((col, i) => {
          if (col.kind !== 'money' || !cells[i]!.lines.length) return;
          for (const off of [-1.6, 0]) {
            doc.lineWidth(0.6).strokeColor(color.ink).moveTo(xs[i]! + 2, y + h + off).lineTo(xs[i]! + ws[i]! - 2, y + h + off).stroke();
          }
        });
      }
      y += h;
    }
    if (sec.note) {
      doc.font('r').fontSize(size);
      for (const line of wrapText(doc, sec.note, width)) {
        if (y + lh > bottom()) { doc.addPage(); y = doc.page.margins.top; }
        say(line, left, y + 2, { color: color.ink2 });
        y += lh;
      }
    }
    return y + 8;
  }

  function cellBox(x: number, y: number, w: number, h: number, head: boolean) {
    if (head) doc.rect(x, y, w, h).fillColor(color.band).fill();
    doc.rect(x, y, w, h).lineWidth(0.5).strokeColor(color.rule).stroke();
  }
}

const firstText = (sec: Section) => sec.columns.findIndex((c) => (c.kind ?? 'text') === 'text');
