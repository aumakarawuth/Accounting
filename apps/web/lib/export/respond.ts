import 'server-only';
import type { ApiError } from '../api';
import { th } from '../../i18n/th';
import type { Report } from './model';
import { toPdf } from './pdf';
import { toXlsx } from './xlsx';
import { contentDisposition } from './filename';

const TYPES = {
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
} as const;
export type ExportFormat = keyof typeof TYPES;

export async function sendReport(report: Report, format: ExportFormat, ascii: string): Promise<Response> {
  const body = format === 'pdf' ? await toPdf(report) : toXlsx(report);
  return new Response(new Uint8Array(body), {
    headers: {
      'content-type': TYPES[format],
      'content-disposition': contentDisposition(report.fileName, ascii, format),
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

/** ข้อผิดพลาดจาก API (ไม่มีสิทธิ์/ไม่พบ/ข้อมูลผิด) ตอบเป็นข้อความสั้น ๆ สถานะเดิม */
export function exportError(e: unknown): Response {
  const err = e as Partial<ApiError>;
  if (typeof err?.status !== 'number') throw e; // redirect ของ Next และ error จริงส่งต่อ
  return new Response(th.export.failed(err.status, String(err.message ?? '')), {
    status: err.status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}
