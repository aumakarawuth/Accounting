import Link from 'next/link';
import { serverApi } from '@/lib/server-api';
import type { AuditRow } from '@/lib/api';
import { th } from '@/i18n/th';

const when = (iso: string) =>
  new Date(iso).toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'medium', timeZone: 'Asia/Bangkok' });

function item(r: AuditRow): string {
  if (r.op === 'IMPORT_STUDENTS' && r.detail) {
    return [r.target, th.admin.importDetail(Number(r.detail.created), Number(r.detail.enrolled))].filter(Boolean).join(' · ');
  }
  const table = th.admin.auditTables[r.table] ?? r.table;
  return [table, r.target, r.changed?.length ? th.admin.changedFields(r.changed) : null].filter(Boolean).join(' · ');
}

export default async function AuditPage({ searchParams }: { searchParams: Promise<{ before?: string }> }) {
  const { before } = await searchParams;
  const rows = await serverApi<AuditRow[]>(`/admin/audit${before && /^\d+$/.test(before) ? `?before=${before}` : ''}`);
  const cell = 'border border-rule px-3 py-2 align-top';
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-3">
      <h1 className="border-b-2 border-ink pb-2.5 font-doc text-[22px] font-bold">{th.admin.audit}</h1>
      {rows.length === 0 ? (
        <p className="text-ink2">{th.admin.noAudit}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] border-collapse bg-paper text-sm">
            <thead className="bg-band text-left">
              <tr>
                {(['at', 'who', 'action', 'item', 'from'] as const).map((k) => (
                  <th key={k} className={`${cell} font-medium`}>{th.admin.auditCols[k]}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className={`${cell} font-num whitespace-nowrap`}>{when(r.at)}</td>
                  <td className={cell}>{r.userName ? `${r.userCode ?? ''} ${r.userName}`.trim() : th.admin.system}</td>
                  <td className={cell}>{th.admin.auditOps[r.op] ?? r.op}</td>
                  <td className={cell}>{item(r)}</td>
                  <td className={`${cell} font-num text-[13px] text-ink2`}>{r.client ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex gap-4">
        {before && <Link href="/admin/audit" className="flex min-h-11 items-center underline">{th.admin.newest}</Link>}
        {rows.length === 50 && (
          <Link href={`/admin/audit?before=${rows[rows.length - 1]!.id}`} className="flex min-h-11 items-center underline">{th.admin.older}</Link>
        )}
      </div>
    </div>
  );
}
