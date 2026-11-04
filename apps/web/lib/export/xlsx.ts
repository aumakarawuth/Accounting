import { crc32, deflateRawSync } from 'node:zlib';
import type { Report, Row, Section } from './model';

// เขียน .xlsx (Office Open XML) เอง ไม่พึ่งไลบรารี: XML ไม่กี่ไฟล์ + zip (deflate จาก node:zlib)
// - ข้อความเป็น inline string: Excel ไม่ตีความเป็นสูตร (กันสูตรแฝงจากชื่อบัญชี/คำอธิบายที่ผู้ใช้พิมพ์)
// - เงินเป็นตัวเลขจริง (คำนวณต่อได้) รูปแบบ #,##0.00 ติดลบในวงเล็บ ค่ามาจากสตริงทศนิยมตรง ๆ ไม่ผ่าน float
// - ฟอนต์ Tahoma: มีในทุกเครื่องที่เปิด Excel/Numbers/LibreOffice และแสดงภาษาไทยถูกต้อง

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
// อักขระควบคุมที่ XML 1.0 ไม่รับ (ผู้ใช้วางข้อความแปลก ๆ มาได้)
// eslint-disable-next-line no-control-regex
const INVALID = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;
const esc = (s: string) => s.replace(INVALID, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** 0 → A, 25 → Z, 26 → AA */
export function colName(i: number): string {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

// ลำดับใน cellXfs (styles.xml)
const S = {
  text: 0, bold: 1, header: 2, money: 3, cell: 4, totalMoney: 5, totalText: 6, title: 7, muted: 8, heading: 9,
  subMoney: 10, subText: 11, number: 12, totalNumber: 13,
} as const;

const STYLES = `${XML}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00;(#,##0.00);0.00"/></numFmts>
<fonts count="4">
<font><sz val="11"/><color rgb="FF1B2A4A"/><name val="Tahoma"/><family val="2"/></font>
<font><b/><sz val="11"/><color rgb="FF1B2A4A"/><name val="Tahoma"/><family val="2"/></font>
<font><b/><sz val="14"/><color rgb="FF1B2A4A"/><name val="Tahoma"/><family val="2"/></font>
<font><sz val="10"/><color rgb="FF4B5874"/><name val="Tahoma"/><family val="2"/></font>
</fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFE4EAE2"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="4">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border><left style="thin"><color rgb="FFB9CBBE"/></left><right style="thin"><color rgb="FFB9CBBE"/></right><top style="thin"><color rgb="FFB9CBBE"/></top><bottom style="thin"><color rgb="FFB9CBBE"/></bottom><diagonal/></border>
<border><left style="thin"><color rgb="FFB9CBBE"/></left><right style="thin"><color rgb="FFB9CBBE"/></right><top style="medium"><color rgb="FF1B2A4A"/></top><bottom style="double"><color rgb="FF1B2A4A"/></bottom><diagonal/></border>
<border><left style="thin"><color rgb="FFB9CBBE"/></left><right style="thin"><color rgb="FFB9CBBE"/></right><top style="thin"><color rgb="FF1B2A4A"/></top><bottom style="thin"><color rgb="FFB9CBBE"/></bottom><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="14">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="164" fontId="1" fillId="0" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="2" xfId="0" applyFont="1" applyBorder="1"/>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1"/>
<xf numFmtId="164" fontId="1" fillId="0" borderId="3" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="3" xfId="0" applyFont="1" applyBorder="1"/>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="right"/></xf>
<xf numFmtId="0" fontId="1" fillId="0" borderId="2" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

const NUMBER = /^-?\d+(\.\d+)?$/;

type Cell = { v: string; t: 's' | 'n'; s: number };

function sheetXml(report: Report): string {
  const ncol = Math.max(...report.sections.map((s) => s.columns.length), 2);
  const rows: Cell[][] = [];
  const merges: string[] = [];
  const line = (cells: Cell[]) => rows.push(cells);
  const span = (r: number, c0: number, c1: number) => { if (c1 > c0) merges.push(`${colName(c0)}${r + 1}:${colName(c1)}${r + 1}`); };

  line([{ v: report.company, t: 's', s: S.title }]); span(0, 0, ncol - 1);
  line([{ v: report.title, t: 's', s: S.bold }]); span(1, 0, ncol - 1);
  line([{ v: report.subtitle, t: 's', s: S.muted }]); span(2, 0, ncol - 1);
  let freeze = 0;

  report.sections.forEach((sec: Section, si) => {
    line([]);
    if (sec.heading) { line([{ v: sec.heading, t: 's', s: S.bold }]); span(rows.length - 1, 0, sec.columns.length - 1); }
    if (sec.groups) {
      const r = rows.length;
      let c = 0;
      const cells: Cell[] = [];
      for (const g of sec.groups) {
        for (let k = 0; k < g.span; k++) cells.push({ v: k === 0 ? g.label : '', t: 's', s: S.header });
        span(r, c, c + g.span - 1);
        c += g.span;
      }
      line(cells);
    }
    line(sec.columns.map((col) => ({ v: col.label, t: 's', s: S.header })));
    if (si === 0 && report.sections.length === 1) freeze = rows.length;
    for (const row of sec.rows) line(rowCells(sec, row));
    if (sec.note) line([{ v: sec.note, t: 's', s: S.muted }]);
  });
  if (report.notes.length) line([]);
  for (const n of report.notes) line([{ v: n, t: 's', s: S.muted }]);
  line([{ v: report.printedAt, t: 's', s: S.muted }]);

  const widths = Array.from({ length: ncol }, (_, i) => Math.max(...report.sections.map((s) => s.columns[i]?.width ?? 0), 8));
  const cols = widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('');
  const body = rows.map((cells, r) => `<row r="${r + 1}">${cells.map((cell, c) => {
    const ref = `${colName(c)}${r + 1}`;
    if (cell.t === 'n') return `<c r="${ref}" s="${cell.s}"><v>${cell.v}</v></c>`;
    if (cell.v === '') return `<c r="${ref}" s="${cell.s}"/>`;
    return `<c r="${ref}" s="${cell.s}" t="inlineStr"><is><t xml:space="preserve">${esc(cell.v)}</t></is></c>`;
  }).join('')}</row>`).join('');
  const pane = freeze ? `<pane ySplit="${freeze}" topLeftCell="A${freeze + 1}" activePane="bottomLeft" state="frozen"/>` : '';
  return `${XML}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`
    + '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>'
    + `<sheetViews><sheetView workbookViewId="0">${pane}</sheetView></sheetViews>`
    + `<cols>${cols}</cols><sheetData>${body}</sheetData>`
    + (merges.length ? `<mergeCells count="${merges.length}">${merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>` : '')
    + `<pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/>`
    + `<pageSetup paperSize="9" orientation="${report.orientation}" fitToWidth="1" fitToHeight="0"/></worksheet>`;
}

function rowCells(sec: Section, row: Row): Cell[] {
  const total = row.style === 'total';
  const sub = row.style === 'subtotal';
  return sec.columns.map((col, i) => {
    const v = row.cells[i] ?? null;
    const numeric = col.kind === 'money' || col.kind === 'number';
    if (numeric && v !== null && NUMBER.test(v)) {
      const s = col.kind === 'number' ? (total ? S.totalNumber : S.number) : total ? S.totalMoney : sub ? S.subMoney : S.money;
      return { v, t: 'n', s };
    }
    const text = v ?? '';
    const s = total ? S.totalText : sub ? S.subText : row.style === 'heading' ? S.heading : S.cell;
    return { v: i === 0 && row.indent ? `${'    '.repeat(row.indent)}${text}` : text, t: 's', s };
  });
}

/** ชื่อแผ่นงาน: ไม่เกิน 31 ตัว ห้าม : \ / ? * [ ] */
const sheetName = (s: string) => s.replace(/[:\\/?*[\]]/g, ' ').slice(0, 31) || 'Sheet1';

export function toXlsx(report: Report): Buffer {
  const files: [string, string][] = [
    ['[Content_Types].xml', `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
      + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
      + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
      + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
      + '</Types>'],
    ['_rels/.rels', `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
      + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
      + '</Relationships>'],
    ['docProps/core.xml', `${XML}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">`
      + `<dc:title>${esc(`${report.title} ${report.company}`)}</dc:title></cp:coreProperties>`],
    ['xl/workbook.xml', `${XML}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`
      + `<sheets><sheet name="${esc(sheetName(report.sheetName))}" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
      + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
      + '</Relationships>'],
    ['xl/styles.xml', STYLES],
    ['xl/worksheets/sheet1.xml', sheetXml(report)],
  ];
  return zip(files.map(([name, text]) => [name, Buffer.from(text, 'utf8')]));
}

/** zip แบบ deflate (ไม่มีโฟลเดอร์ ไม่มี zip64) วันที่คงที่ ไฟล์เดิม = ไบต์เดิม */
export function zip(entries: [string, Buffer][]): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01
  for (const [name, data] of entries) {
    const n = Buffer.from(name, 'utf8');
    const comp = deflateRawSync(data);
    const crc = crc32(data) >>> 0;
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(8, 8);
    h.writeUInt16LE(0, 10); h.writeUInt16LE(DOS_DATE, 12); h.writeUInt32LE(crc, 14);
    h.writeUInt32LE(comp.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(n.length, 26); h.writeUInt16LE(0, 28);
    local.push(h, n, comp);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(8, 10);
    c.writeUInt16LE(0, 12); c.writeUInt16LE(DOS_DATE, 14); c.writeUInt32LE(crc, 16); c.writeUInt32LE(comp.length, 20);
    c.writeUInt32LE(data.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt16LE(0, 30); c.writeUInt16LE(0, 32);
    c.writeUInt16LE(0, 34); c.writeUInt16LE(0, 36); c.writeUInt32LE(0, 38); c.writeUInt32LE(offset, 42);
    central.push(c, n);
    offset += h.length + n.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, end]);
}
