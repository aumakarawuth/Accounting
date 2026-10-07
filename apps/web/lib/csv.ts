// อ่านไฟล์รายชื่อนักเรียนในเบราว์เซอร์ (ส่งเฉพาะรหัสและชื่อไป API ตาม PDPA)

/** UTF-8 (มี/ไม่มี BOM) หรือไฟล์ไทยจาก Excel แบบ Windows-874/TIS-620 */
export function decodeCsv(bytes: ArrayBuffer | Uint8Array): string {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    text = new TextDecoder('windows-874').decode(bytes);
  }
  return text.replace(/^\uFEFF/, '');
}

/** CSV ตาม RFC 4180 (เครื่องหมายคำพูด, ขึ้นบรรทัดในช่อง) ตัวคั่น , ; หรือ tab เดาจากบรรทัดแรก */
export type CsvRow = { cells: string[]; line: number }; // line = บรรทัดจริงในไฟล์ที่แถวเริ่ม

export function parseCsv(text: string): CsvRow[] {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const delim = [',', ';', '\t'].map((d) => [d, firstLine.split(d).length] as const).sort((a, b) => b[1] - a[1])[0]![0];
  const rows: CsvRow[] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let line = 1;
  let start = 1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else { if (ch === '\n') line++; cell += ch; }
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push({ cells: row, line: start }); row = []; cell = '';
      line++; start = line;
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push({ cells: row, line: start }); }
  return rows.filter((r) => r.cells.some((c) => c.trim() !== ''));
}

export type Problem = 'invalid_code' | 'empty_name' | 'name_too_long' | 'duplicate';
export type StudentRow = { line: number; studentCode: string; name: string; problems: Problem[] };

const CODE = /^[0-9A-Za-z-]{1,20}$/;
const clean = (s: string) => s.normalize('NFC').replace(/\s+/g, ' ').trim();

/**
 * แปลงตารางเป็นรายชื่อ: มีหัวตาราง = หาคอลัมน์จากชื่อ (รหัส / ชื่อ / นามสกุล) ไม่มี = คอลัมน์ 1 รหัส, ที่เหลือเป็นชื่อ
 * คอลัมน์อื่น (เลขที่, เลขบัตร ฯลฯ) ไม่ถูกอ่าน
 */
export function toStudentRows(table: CsvRow[]): { rows: StudentRow[]; header: boolean } {
  const first = table[0]?.cells ?? [];
  const header = (first.length > 0 && !CODE.test(clean(first[0] ?? ''))) || first.some((c) => /รหัส|ชื่อ|code|name/i.test(c));
  let codeCol = 0;
  let nameCols: number[] = [];
  if (header) {
    const h = first.map((c) => clean(c).toLowerCase());
    codeCol = h.findIndex((c) => /รหัส|code|student.?id/.test(c));
    const name = h.findIndex((c, i) => i !== codeCol && /ชื่อ|name/.test(c) && !/สกุล|last|surname/.test(c));
    const last = h.findIndex((c) => /นามสกุล|สกุล|last|surname/.test(c));
    if (codeCol < 0) codeCol = 0;
    nameCols = [name, last].filter((i) => i >= 0 && i !== codeCol);
  }
  const body = header ? table.slice(1) : table;
  const seen = new Map<string, number>();
  const rows = body.map(({ cells: r, line }): StudentRow => {
    const studentCode = clean(r[codeCol] ?? '');
    const cols = nameCols.length ? nameCols : r.map((_, j) => j).filter((j) => j !== codeCol);
    const name = clean(cols.map((j) => r[j] ?? '').join(' '));
    const problems: Problem[] = [];
    if (!CODE.test(studentCode)) problems.push('invalid_code');
    if (!name) problems.push('empty_name');
    if ([...name].length > 120) problems.push('name_too_long');
    seen.set(studentCode, (seen.get(studentCode) ?? 0) + 1);
    return { line, studentCode, name, problems };
  });
  for (const r of rows) if ((seen.get(r.studentCode) ?? 0) > 1) r.problems.push('duplicate');
  return { rows, header };
}
