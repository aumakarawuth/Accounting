import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, inflateRawSync } from 'node:zlib';
import PDFDocument from '../apps/web/node_modules/pdfkit';
import { buildApp } from '../apps/api/src/app';
import { devAuth } from '../apps/api/src/auth';
import { authConfigFromEnv } from '../apps/api/src/config';
import { createPool } from '../apps/api/src/db';
import { toPdf, wrapText } from '../apps/web/lib/export/pdf';
import { toXlsx, colName } from '../apps/web/lib/export/xlsx';
import { contentDisposition } from '../apps/web/lib/export/filename';
import { ledgerReport, scoresReport, statementsReport, trialBalanceReport, worksheetReport } from '../apps/web/lib/export/reports';
import { PLEX_THAI_REGULAR } from '../apps/web/lib/export/fonts';
import type { AssignmentOverview, Ledger, LedgerAccount, Statements, TrialBalance, Worksheet } from '../apps/web/lib/api';
import { apiUrl } from './global-setup';
import { pool as db, newSchool, newUser, newClassroom, newCompany } from './helpers';

// เฟส 4 รายงาน PDF/Excel: ตัวเลขจาก API ชุดเดียวกับหน้าจอ · .xlsx แตกได้และตัวเลขตรง · PDF ฝังฟอนต์ไทยและดึงข้อความไทยกลับได้
const apiPool = createPool(apiUrl());
const app = buildApp({ pool: apiPool, auth: devAuth(), cfg: { ...authConfigFromEnv({}), allowedOrigins: false } });
afterAll(async () => { await app.close(); await apiPool.end(); await db.end(); });

let owner: string, co: string;
const get = async <T>(url: string) => {
  const r = await app.inject({ method: 'GET', url, headers: { 'x-dev-user-id': owner } });
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as T;
};

beforeAll(async () => {
  const school = await newSchool();
  const teacher = await newUser(school, 'teacher');
  owner = await newUser(school, 'student');
  const room = await newClassroom(school, teacher, [owner]);
  co = await newCompany(owner, room);
  // ชื่อบัญชีขึ้นต้นด้วย = ต้องไม่กลายเป็นสูตรใน Excel
  await app.inject({ method: 'POST', url: `/companies/${co}/accounts`, headers: { 'x-dev-user-id': owner },
    payload: { code: '5299', name: '=HYPERLINK("http://evil.example","ค่าใช้จ่ายอื่น")', type: 'expense' } });
  const post = (date: string, lines: object[], adjusting = false) => app.inject({ method: 'POST', url: `/companies/${co}/journal`,
    headers: { 'x-dev-user-id': owner, 'idempotency-key': randomUUID() }, payload: { date, description: 'ซื้อวัสดุที่ร้านผู้ใหญ่บ้าน', lines, adjusting } });
  for (const r of [
    await post('2026-10-01', [{ account_code: '1110', debit: '125000' }, { account_code: '3110', credit: '125000' }]),
    await post('2026-10-05', [{ account_code: '5299', debit: '1250.50' }, { account_code: '1110', credit: '1250.50' }]),
    await post('2026-10-09', [{ account_code: '1110', debit: '3000' }, { account_code: '4120', credit: '3000' }]),
    await post('2026-10-31', [{ account_code: '5250', debit: '500' }, { account_code: '1621', credit: '500' }], true),
  ]) expect(r.statusCode, r.body).toBe(201);
});

/** แตก zip (deflate) ตรวจ CRC ทุกไฟล์ */
function unzip(buf: Buffer): Map<string, string> {
  const out = new Map<string, string>();
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50);
    const crc = buf.readUInt32LE(p + 16), size = buf.readUInt32LE(p + 20), nlen = buf.readUInt16LE(p + 28), off = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    const lnlen = buf.readUInt16LE(off + 26), lxlen = buf.readUInt16LE(off + 28);
    const data = inflateRawSync(buf.subarray(off + 30 + lnlen + lxlen, off + 30 + lnlen + lxlen + size));
    expect(crc32(data) >>> 0, name).toBe(crc);
    out.set(name, data.toString('utf8'));
    p += 46 + nlen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return out;
}

const hasPdftotext = (() => { try { execFileSync('pdftotext', ['-v'], { stdio: 'ignore' }); return true; } catch { return false; } })();
function pdfText(pdf: Buffer) {
  const dir = mkdtempSync(join(tmpdir(), 'pdf-'));
  writeFileSync(join(dir, 'a.pdf'), pdf);
  // pdftotext คืนสระอำเป็น "ำา" (ฟอนต์วาดอำด้วยสองรูป) ลำดับในข้อความที่คัดลอกเพี้ยนได้ แต่ภาพบนกระดาษถูกต้อง
  return execFileSync('pdftotext', ['-layout', join(dir, 'a.pdf'), '-'], { encoding: 'utf8' }).replace(/ำา/g, 'ำ');
}

describe('ส่งออก Excel (.xlsx)', () => {
  it('งบทดลอง: ตัวเลขเป็นตัวเลขจริงตรงกับ API · ภาษาไทยครบ · ข้อความขึ้นต้น = ไม่เป็นสูตร · zip/CRC ถูก', async () => {
    const tb = await get<TrialBalance>(`/companies/${co}/trial-balance?month=2026-10`);
    expect(tb.totalDebit).toBe('128500.00');
    const files = unzip(toXlsx(trialBalanceReport('บริษัท ก. จำกัด', tb)));
    expect([...files.keys()].sort()).toEqual(['[Content_Types].xml', '_rels/.rels', 'docProps/core.xml', 'xl/_rels/workbook.xml.rels',
      'xl/styles.xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml']);
    const sheet = files.get('xl/worksheets/sheet1.xml')!;
    expect(sheet).toContain('<t xml:space="preserve">บริษัท ก. จำกัด</t>');
    expect(sheet).toContain('<t xml:space="preserve">เงินสด</t>');
    expect(sheet).toContain('<v>128500.00</v>');
    expect(sheet).toContain('<v>126749.50</v>'); // เงินสด 125,000 − 1,250.50 + 3,000
    expect(sheet).toContain('=HYPERLINK(&quot;http://evil.example&quot;');
    expect(sheet).not.toContain('<f>');
    expect(files.get('xl/styles.xml')).toContain('formatCode="#,##0.00;(#,##0.00);0.00"');
    expect(files.get('xl/workbook.xml')).toContain('name="งบทดลอง"');
  });

  it('แยกประเภท งบการเงิน กระดาษทำการ คะแนน สร้างได้และมียอดรวมตรง API', async () => {
    const accounts = await get<LedgerAccount[]>(`/companies/${co}/ledger-accounts?month=2026-10`);
    const ledgers = await Promise.all(accounts.map((a) => get<Ledger>(`/companies/${co}/ledger?month=2026-10&account=${a.code}`)));
    const led = unzip(toXlsx(ledgerReport('บริษัท ก.', '2026-10', ledgers))).get('xl/worksheets/sheet1.xml')!;
    expect(led).toContain('1110 เงินสด');
    expect(led).toContain(`<v>${ledgers.find((l) => l.account.code === '1110')!.closing}</v>`);

    const st = await get<Statements>(`/companies/${co}/statements?month=2026-10&scope=ytd`);
    const sts = unzip(toXlsx(statementsReport('บริษัท ก.', st))).get('xl/worksheets/sheet1.xml')!;
    expect(st.netIncome).toBe('1249.50');
    expect(sts).toContain('<v>1249.50</v>');
    expect(sts).toContain(`<v>${st.totalAssets}</v>`);

    const ws = await get<Worksheet>(`/companies/${co}/worksheet?month=2026-10&format=10`);
    const wss = unzip(toXlsx(worksheetReport('บริษัท ก.', ws))).get('xl/worksheets/sheet1.xml')!;
    expect(wss).toContain('งบทดลองหลังปรับปรุง');
    expect(wss).toContain(`<v>${ws.grand!.bs.debit}</v>`);
    expect(wss).toMatch(/<mergeCell ref="C\d+:D\d+"\/>/);

    const ov: AssignmentOverview = {
      assignment: { id: 'a', mode: 'exam', title: 'สอบย่อย', companyName: 'ร้าน', setId: 's', classroomId: 'r', classroom: 'ม.5/2', feedback: 'items',
        reveal: 'after_release', checkDate: true, opensAt: null, closesAt: null, durationMinutes: 30, releasedAt: null, closedAt: null, createdAt: '' },
      items: [{ no: 1, date: '2026-10-01', narrative: 'x', points: '1.00' }, { no: 2, date: '2026-10-02', narrative: 'y', points: '2.00' }],
      students: [
        { studentId: '1', studentCode: '65001', name: 'ก', companyId: 'c1', companyName: 'ร้าน', status: 'draft', teacherScore: null, maxScore: '3.00',
          startedAt: null, deadline: null, extraMinutes: null, lockReason: 'exam_over', entries: 2,
          grade: { score: '3.00', maxScore: '3.00', correct: 2, extra: 0, items: [{ no: 1, status: 'correct', earned: '1.00' }, { no: 2, status: 'correct', earned: '2.00' }] } },
        { studentId: '2', studentCode: '65002', name: 'ข', companyId: 'c2', companyName: 'ร้าน', status: 'draft', teacherScore: null, maxScore: '3.00',
          startedAt: null, deadline: null, extraMinutes: null, lockReason: 'exam_over', entries: 1,
          grade: { score: '1.00', maxScore: '3.00', correct: 1, extra: 1, items: [{ no: 1, status: 'correct', earned: '1.00' }, { no: 2, status: 'wrong', earned: '0.00' }] } },
        { studentId: '3', studentCode: '65003', name: 'ค', companyId: null, companyName: null, status: null, teacherScore: null, maxScore: null,
          startedAt: null, deadline: null, extraMinutes: null, lockReason: null, entries: 0, grade: null },
      ],
      now: '',
    };
    const sc = unzip(toXlsx(scoresReport(ov))).get('xl/worksheets/sheet1.xml')!;
    expect(sc).toContain('<v>2.00</v>'); // เฉลี่ย (3 + 1) / 2 คนที่มีบริษัท
    expect(sc).toContain('หมดเวลา');
    expect(sc).toContain('ยังไม่มีบริษัท');
    expect(sc).toContain('ข้อ 2');
  });

  it('ชื่อคอลัมน์ Excel', () => {
    expect([0, 25, 26, 27, 51, 52, 701, 702].map(colName)).toEqual(['A', 'Z', 'AA', 'AB', 'AZ', 'BA', 'ZZ', 'AAA']);
  });
});

describe('ส่งออก PDF', () => {
  it('ฝังฟอนต์ไทย + ToUnicode · ดึงข้อความไทยและตัวเลขกลับได้ (pdftotext) · ติดลบเป็นวงเล็บ', async () => {
    const tb = await get<TrialBalance>(`/companies/${co}/trial-balance?month=2026-10`);
    const pdf = await toPdf(trialBalanceReport('บริษัท ก. จำกัด', tb));
    const raw = pdf.toString('latin1');
    expect(raw.startsWith('%PDF-')).toBe(true);
    expect(raw).toContain('/FontFile2');
    expect(raw).toContain('/ToUnicode');
    expect(raw).toMatch(/IBMPlexSansThaiLooped/);
    expect(raw).not.toContain('/Helvetica');
    if (!hasPdftotext) return;
    const text = pdfText(pdf).replace(/\s+/g, '');
    for (const w of ['งบทดลอง', 'รหัสบัญชี', '128,500.00', '126,749.50', 'หน้า1/1']) expect(text, w).toContain(w);

    const st = await get<Statements>(`/companies/${co}/statements?month=2026-10&scope=ytd`);
    const ws = await get<Worksheet>(`/companies/${co}/worksheet?month=2026-10&format=10`);
    const neg = { ...tb, rows: [...tb.rows, { code: '1999', name: 'ทดสอบยอดติดลบ', type: 'asset', normalSide: 'debit' as const, debit: '-500.00', credit: '0.00' }] };
    for (const r of [statementsReport('บริษัท ก.', st), worksheetReport('บริษัท ก.', ws), trialBalanceReport('บริษัท ก.', neg)]) {
      const t = pdfText(await toPdf(r)).replace(/\s+/g, '');
      expect(t).toContain(r.title.replace(/\s+/g, ''));
    }
    expect(pdfText(await toPdf(trialBalanceReport('ก', neg))).replace(/\s+/g, '')).toContain('(500.00)');
  });

  it('รายงานยาวขึ้นหน้าใหม่พร้อมหัวตารางซ้ำและเลขหน้า', async () => {
    const tb = await get<TrialBalance>(`/companies/${co}/trial-balance?month=2026-10&all=1`);
    const many = { ...tb, rows: Array.from({ length: 6 }, () => tb.rows).flat() };
    const pdf = await toPdf(trialBalanceReport('บริษัท ก.', many));
    const pages = (pdf.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length;
    expect(pages).toBeGreaterThan(2);
    if (!hasPdftotext) return;
    const text = pdfText(pdf).replace(/[ \t]+/g, '');
    expect(text).toContain(`หน้า${pages}/${pages}`);
    expect(text.split('รหัสบัญชี').length - 1).toBe(pages);
  });

  it('ตัดบรรทัดภาษาไทยตามคำ ไม่เกินความกว้าง ไม่แยกสระ/วรรณยุกต์ออกจากพยัญชนะ', () => {
    const doc = new PDFDocument({ font: Buffer.from(PLEX_THAI_REGULAR, 'base64') as unknown as string });
    doc.fontSize(9);
    const text = 'ซื้อวัสดุสิ้นเปลืองจากร้านผู้ใหญ่บ้านจ่ายเป็นเช็คธนาคารกรุงไทยลงวันที่ล่วงหน้าสามสิบวันและรับใบกำกับภาษีเต็มรูปแบบ';
    const lines = wrapText(doc, text, 120);
    expect(lines.length).toBeGreaterThan(2);
    expect(lines.join('')).toBe(text);
    for (const l of lines) {
      expect(doc.widthOfString(l)).toBeLessThanOrEqual(120);
      expect(l).not.toMatch(/^[ัิ-ฺ็-๎]/); // บรรทัดไม่ขึ้นต้นด้วยสระบน/ล่างหรือวรรณยุกต์
    }
    expect(wrapText(doc, 'ก'.repeat(80), 50).every((l) => doc.widthOfString(l) <= 50)).toBe(true);
    doc.end();
  });
});

describe('ชื่อไฟล์ดาวน์โหลด', () => {
  it('ชื่อไทยเข้ารหัสใน filename* · ชื่อที่มี " หรือขึ้นบรรทัดฉีด header ไม่ได้', () => {
    const h = contentDisposition('งบทดลอง บริษัท "ก"\r\nSet-Cookie: x=1', 'trial-balance-2026-10', 'pdf');
    expect(h).not.toMatch(/[\r\n]/);
    expect(h).toBe(`attachment; filename="trial-balance-2026-10.pdf"; filename*=UTF-8''${encodeURIComponent('งบทดลอง บริษัท "ก"\r\nSet-Cookie: x=1.pdf')}`);
    expect(h.split('"').length - 1).toBe(2);
  });
});
