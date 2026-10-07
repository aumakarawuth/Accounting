import { describe, it, expect } from 'vitest';
import { decodeCsv, parseCsv, toStudentRows } from '../apps/web/lib/csv';

// สร้างไบต์ TIS-620/Windows-874 เอง: อักษรไทย U+0E01–U+0E5B = 0xA1–0xFB
function tis620(s: string): Uint8Array {
  return Uint8Array.from([...s].map((ch) => {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0x0e01 && cp <= 0x0e5b) return cp - 0x0e01 + 0xa1;
    if (cp < 0x80) return cp;
    throw new Error(`ไม่มีใน TIS-620: ${ch}`);
  }));
}

const rows = (text: string) => toStudentRows(parseCsv(text));

describe('อ่าน CSV รายชื่อนักเรียน', () => {
  it('UTF-8 มี BOM + หัวตารางภาษาไทย + CRLF', () => {
    const r = rows(decodeCsv(new TextEncoder().encode('﻿รหัสนักเรียน,ชื่อ-สกุล\r\n65001,กมลชนก ใจดี\r\n65002,เขมินท์  รักเรียน\r\n')));
    expect(r.header).toBe(true);
    expect(r.rows).toEqual([
      { line: 2, studentCode: '65001', name: 'กมลชนก ใจดี', problems: [] },
      { line: 3, studentCode: '65002', name: 'เขมินท์ รักเรียน', problems: [] },
    ]);
  });

  it('ไฟล์ไทยจาก Excel (Windows-874) อ่านได้', () => {
    const r = rows(decodeCsv(tis620('รหัส,ชื่อ,นามสกุล\n65003,จิรายุ,มั่นคง\n')));
    expect(r.rows[0]).toMatchObject({ studentCode: '65003', name: 'จิรายุ มั่นคง', problems: [] });
  });

  it('ไม่มีหัวตาราง: คอลัมน์แรกเป็นรหัส ที่เหลือรวมเป็นชื่อ; ตัวคั่น ; และ tab', () => {
    expect(rows('65004;ธนกร;ศรีสุข').rows[0]).toMatchObject({ line: 1, studentCode: '65004', name: 'ธนกร ศรีสุข' });
    expect(rows('65005\tชลธิชา').rows[0]).toMatchObject({ studentCode: '65005', name: 'ชลธิชา' });
  });

  it('หัวตารางมีคอลัมน์อื่น (เลขที่, เลขบัตร) ไม่ถูกอ่าน', () => {
    const r = rows('เลขที่,รหัสนักเรียน,ชื่อ,นามสกุล,เลขบัตรประชาชน\n1,65006,อารียา,ดีงาม,1234567890123');
    expect(r.rows[0]).toEqual({ line: 2, studentCode: '65006', name: 'อารียา ดีงาม', problems: [] });
  });

  it('ช่องในเครื่องหมายคำพูด มีจุลภาคและ "" ข้างใน; ขึ้นบรรทัดในช่องไม่ทำให้เลขบรรทัดเพี้ยน', () => {
    expect(rows('65007,"ณัฐ ""นัท"", วงศ์ไทย"').rows[0]!.name).toBe('ณัฐ "นัท", วงศ์ไทย');
    expect(rows('65010,"สอง\nบรรทัด"\nก1,x').rows.map((r) => r.line)).toEqual([1, 3]);
  });

  it('แจ้งปัญหาทีละแถว: รหัสผิดรูปแบบ, ไม่มีชื่อ, รหัสซ้ำในไฟล์; ข้ามบรรทัดว่าง', () => {
    const r = rows('65008,ก\nก123,ข\n65009,\n\n65008,ค\n');
    expect(r.rows.map((x) => [x.line, x.problems])).toEqual([
      [1, ['duplicate']], [2, ['invalid_code']], [3, ['empty_name']], [5, ['duplicate']],
    ]);
  });
});
