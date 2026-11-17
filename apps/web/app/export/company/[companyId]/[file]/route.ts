import type { NextRequest } from 'next/server';
import { serverApi } from '@/lib/server-api';
import type { Company, Ledger, LedgerAccount, Statements, TrialBalance, Worksheet } from '@/lib/api';
import { isMonth } from '@/lib/date';
import { ledgerReport, statementsReport, trialBalanceReport, worksheetReport } from '@/lib/export/reports';
import { exportError, sendReport, type ExportFormat } from '@/lib/export/respond';
import { th } from '@/i18n/th';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// /export/company/<id>/<รายงาน>.<pdf|xlsx>?month=YYYY-MM — ข้อมูลจาก API ชุดเดียวกับหน้าจอ (สิทธิ์ตัดสินที่ API/RLS)
const FILE = /^(trial-balance|ledger|statements|worksheet)\.(pdf|xlsx)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(req: NextRequest, { params }: { params: Promise<{ companyId: string; file: string }> }) {
  const { companyId, file } = await params;
  const m = FILE.exec(file);
  const sp = req.nextUrl.searchParams;
  const month = sp.get('month') ?? undefined;
  if (!m || !UUID.test(companyId) || !isMonth(month)) {
    return new Response(th.error.notFound, { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
  const [, report, format] = m as unknown as [string, 'trial-balance' | 'ledger' | 'statements' | 'worksheet', ExportFormat];
  const base = `/companies/${companyId}`;
  try {
    const company = await serverApi<Company>(base);
    const ascii = `${report}-${month}`;
    if (report === 'trial-balance') {
      const tb = await serverApi<TrialBalance>(`${base}/trial-balance?month=${month}${sp.get('stage') === 'after' ? '&stage=after' : ''}`);
      return sendReport(trialBalanceReport(company.name, tb), format, ascii);
    }
    if (report === 'ledger') {
      const accounts = await serverApi<LedgerAccount[]>(`${base}/ledger-accounts?month=${month}`);
      const ledgers: Ledger[] = [];
      for (const a of accounts) ledgers.push(await serverApi<Ledger>(`${base}/ledger?month=${month}&account=${encodeURIComponent(a.code)}`));
      return sendReport(ledgerReport(company.name, month, ledgers), format, ascii);
    }
    if (report === 'statements') {
      const scope = sp.get('scope') === 'month' ? 'month' : 'ytd';
      const st = await serverApi<Statements>(`${base}/statements?month=${month}&scope=${scope}`);
      return sendReport(statementsReport(company.name, st), format, ascii);
    }
    const fmt = sp.get('format');
    const ws = await serverApi<Worksheet>(`${base}/worksheet?month=${month}${fmt && /^(6|8|10)$/.test(fmt) ? `&format=${fmt}` : ''}`);
    if (ws.format === null) return new Response(th.worksheet.disabled, { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    return sendReport(worksheetReport(company.name, ws), format, `${ascii}-${ws.format}`);
  } catch (e) {
    return exportError(e);
  }
}
