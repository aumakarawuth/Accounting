'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, postJson, type Account, type LiveCompany } from '@/lib/api';
import { subscribe } from '@/lib/realtime';
import { fromCents, formatMoney, toCents } from '@/lib/money';
import { isoToThai } from '@/lib/date';
import { th } from '@/i18n/th';

const time = (iso: string) => new Date(iso).toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok' });

// ดูสดนักเรียนหนึ่งคน: เริ่ม → ส่งสัญญาณทุก 15 วินาที → หยุดเมื่อออก (นักเรียนเห็นป้ายตลอดที่ดู)
// ได้ event จากช่อง company:<id> แล้วดึงข้อมูลจริงผ่าน API (RLS)
export function SpectatePane({ companyId, studentLabel }: { companyId: string; studentLabel: { code: string; name: string } }) {
  const [data, setData] = useState<LiveCompany | null>(null);
  const [accounts, setAccounts] = useState<Map<string, string>>(new Map());
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(() => {
    api<LiveCompany>(`/companies/${companyId}/live`).then(setData).catch(() => {});
  }, [companyId]);

  useEffect(() => {
    load();
    api<Account[]>(`/companies/${companyId}/accounts`).then((a) => setAccounts(new Map(a.map((x) => [x.code, x.name])))).catch(() => {});
    const unsub = subscribe(`company:${companyId}`, () => {
      // รวม event ที่มาติด ๆ กัน (นักเรียนพิมพ์เร็ว) ดึงครั้งเดียว
      if (pending.current) clearTimeout(pending.current);
      pending.current = setTimeout(load, 250);
    });

    let spectateId: string | null = null;
    let stopped = false;
    const stop = () => {
      if (spectateId) void fetch(`/api/spectate/${spectateId}/stop`, { method: 'POST', keepalive: true, credentials: 'same-origin' });
      spectateId = null;
    };
    postJson<{ id: string }>(`/companies/${companyId}/spectate`, {}).then((r) => {
      spectateId = r.id;
      if (stopped) stop();
    }).catch(() => {});
    const ping = setInterval(() => spectateId && void postJson(`/spectate/${spectateId}/ping`, {}).catch(() => {}), 15_000);
    window.addEventListener('pagehide', stop);
    return () => {
      stopped = true;
      unsub();
      clearInterval(ping);
      if (pending.current) clearTimeout(pending.current);
      window.removeEventListener('pagehide', stop);
      stop();
    };
  }, [companyId, load]);

  if (!data) return <p className="text-ink2">{th.live.refresh}</p>;
  const p = data.presence;
  const lines = p?.draft?.lines.filter((l) => l.account_code || l.debit || l.credit) ?? [];
  const dr = toCents(p?.draftDebit ?? '0') ?? 0n;
  const cr = toCents(p?.draftCredit ?? '0') ?? 0n;
  const diff = dr - cr;
  const amt = (v: string) => { const c = toCents(v); return c && c > 0n ? formatMoney(fromCents(c)) : v; };
  const cell = 'border border-rule px-2.5 py-2';

  return (
    <section className="flex flex-col gap-4" aria-live="polite">
      <div className="border-b border-rule-strong pb-2">
        <h2 className="font-semibold">{th.live.spectating(studentLabel.code, studentLabel.name, data.company.name)}</h2>
        <p className="text-[13px] text-ink2">{th.live.note}</p>
        {p && <p className="text-sm">{th.live.onPage(th.live.page[p.page] ?? p.page)}</p>}
      </div>

      <div className="flex flex-col gap-2 border border-rule-strong bg-paper p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2 border-b-2 border-ink pb-1.5">
          <h3 className="font-doc text-[18px] font-bold">{th.live.draft}</h3>
          {p?.draft && <span className="text-[13px] text-ink2">{th.live.draftUpdated(time(p.updatedAt))}</span>}
        </div>
        {lines.length === 0 ? <p className="text-ink2">{th.live.noDraft}</p> : (
          <>
            {p?.draft?.description && <p className="text-sm">{p.draft.description}{p.draft.date ? ` · ${p.draft.date}` : ''}</p>}
            <table className="w-full border-collapse text-[15px]">
              <thead className="bg-band text-left text-sm">
                <tr>
                  <th className={`${cell} w-20 font-medium`}>{th.journal.accountCode}</th>
                  <th className={`${cell} font-medium`}>{th.journal.accountName}</th>
                  <th className={`${cell} w-32 text-right font-medium`}>{th.money.debit}</th>
                  <th className={`${cell} w-32 text-right font-medium`}>{th.money.credit}</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={i}>
                    <td className={`${cell} font-num`}>{l.account_code}</td>
                    <td className={`${cell} ${l.credit ? 'pl-7' : ''} ${accounts.has(l.account_code) ? '' : 'text-ink2'}`}>{accounts.get(l.account_code) ?? ''}</td>
                    <td className={`${cell} num`}>{l.debit && amt(l.debit)}</td>
                    <td className={`${cell} num`}>{l.credit && amt(l.credit)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="font-medium">
                <tr>
                  <td colSpan={2} className={`${cell} border-t-2 border-t-ink text-right`}>{th.money.total}</td>
                  <td className={`${cell} num border-t-2 border-t-ink`}>{formatMoney(fromCents(dr))}</td>
                  <td className={`${cell} num border-t-2 border-t-ink`}>{formatMoney(fromCents(cr))}</td>
                </tr>
              </tfoot>
            </table>
            <p className={`text-sm ${diff === 0n ? '' : 'neg font-semibold'}`}>
              {diff === 0n
                ? `${th.money.difference} 0.00 · ${th.money.balanced}`
                : th.error.ACC01(formatMoney(fromCents(dr)), formatMoney(fromCents(cr)), formatMoney(fromCents(diff < 0n ? -diff : diff)))}
            </p>
          </>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="text-[15px] font-semibold">{th.live.posted}</h3>
        {data.entries.length === 0 ? <p className="text-ink2">{th.journal.empty}</p> : (
          <ul className="border-t border-rule-strong bg-paper">
            {data.entries.map((e) => (
              <li key={e.id} className="grid grid-cols-[auto_minmax(0,1fr)_auto] gap-x-3 border-b border-rule px-3 py-2 text-[15px]">
                <span className={`font-num ${e.reversal ? 'neg' : ''}`}>{e.docNo}</span>
                <span className="truncate">{isoToThai(e.date)} · {e.description}</span>
                <span className={`num ${e.reversal ? 'neg' : ''}`}>{e.reversal ? `(${formatMoney(e.total)})` : formatMoney(e.total)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
