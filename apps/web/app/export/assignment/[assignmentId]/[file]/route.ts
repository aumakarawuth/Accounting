import { serverApi } from '@/lib/server-api';
import type { AssignmentOverview } from '@/lib/api';
import { scoresReport } from '@/lib/export/reports';
import { exportError, sendReport, type ExportFormat } from '@/lib/export/respond';
import { th } from '@/i18n/th';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// /export/assignment/<id>/scores.<pdf|xlsx> — ครูเจ้าของงาน/ครูประจำห้องเท่านั้น (API ตรวจ)
const FILE = /^scores\.(pdf|xlsx)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(_req: Request, { params }: { params: Promise<{ assignmentId: string; file: string }> }) {
  const { assignmentId, file } = await params;
  const m = FILE.exec(file);
  if (!m || !UUID.test(assignmentId)) return new Response(th.error.notFound, { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  const format = m[1] as ExportFormat;
  try {
    const ov = await serverApi<AssignmentOverview>(`/teacher/assignments/${assignmentId}`);
    // PDF แสดงรายข้อเมื่อไม่เกิน 15 ข้อ (กระดาษแนวนอน) Excel แสดงทุกข้อ
    return sendReport(scoresReport(ov, format === 'pdf' ? { maxItemColumns: 15 } : {}), format, `scores-${assignmentId.slice(0, 8)}`);
  } catch (e) {
    return exportError(e);
  }
}
