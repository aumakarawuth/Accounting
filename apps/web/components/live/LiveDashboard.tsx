'use client';

import { useEffect, useState } from 'react';
import { api, type LiveRow } from '@/lib/api';
import { formatMoney, fromCents, toCents } from '@/lib/money';
import { th } from '@/i18n/th';
import { SpectatePane } from './SpectatePane';

const ONLINE_MS = 5 * 60_000;
const STALE_MIN = 20;

type Group = 'unbalanced' | 'stale' | 'online' | 'offline';

// จัดกลุ่มตามที่ครูต้องดูก่อน (PLAN.md ข้อ 9): ร่างไม่ดุล → ค้างนาน → ออนไลน์ → ออฟไลน์
function classify(r: LiveRow): { group: Group; reason: string } {
  const now = new Date(r.now).getTime();
  const seen = Math.max(r.lastSeenAt ? Date.parse(r.lastSeenAt) : 0, r.presenceAt ? Date.parse(r.presenceAt) : 0);
  const online = now - seen < ONLINE_MS;
  const diff = (toCents(r.draftDebit ?? '0') ?? 0n) - (toCents(r.draftCredit ?? '0') ?? 0n);
  if ((r.draftLines ?? 0) > 0 && diff !== 0n) {
    return { group: 'unbalanced', reason: th.live.diff(formatMoney(fromCents(diff < 0n ? -diff : diff))) };
  }
  if (!online) return { group: 'offline', reason: r.companyId ? '' : th.live.noCompany };
  if (!r.lastPostedAt) return { group: 'stale', reason: th.live.neverPosted };
  const idle = Math.floor((now - Date.parse(r.lastPostedAt)) / 60_000);
  if (idle >= STALE_MIN) return { group: 'stale', reason: th.live.idle(idle) };
  return { group: 'online', reason: r.page ? th.live.page[r.page] ?? '' : '' };
}

export function LiveDashboard({ classroomId }: { classroomId: string }) {
  const [rows, setRows] = useState<LiveRow[]>([]);
  const [selected, setSelected] = useState<LiveRow | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => api<LiveRow[]>(`/teacher/classrooms/${classroomId}/live`).then((r) => alive && setRows(r)).catch(() => {});
    load();
    const t = setInterval(load, 5_000); // แดชบอร์ดใช้สรุปทุก 5 วินาที ไม่ push ทุกคน
    return () => { alive = false; clearInterval(t); };
  }, [classroomId]);

  const groups: Record<Group, (LiveRow & { reason: string })[]> = { unbalanced: [], stale: [], online: [], offline: [] };
  for (const r of rows) { const c = classify(r); groups[c.group].push({ ...r, reason: c.reason }); }

  return (
    <div className="flex gap-5">
      <section className={`flex w-full flex-col lg:w-[380px] lg:shrink-0 ${selected ? 'max-lg:hidden' : ''}`}>
        <p className="border border-rule-strong bg-paper px-3 py-2 text-sm">
          {th.live.counts(groups.unbalanced.length, groups.stale.length, groups.online.length)} · {th.live.refresh}
        </p>
        {(Object.keys(groups) as Group[]).map((g) => groups[g].length > 0 && (
          <div key={g}>
            <h2 className="flex justify-between border-x border-b border-rule-strong bg-band px-3 py-2 text-[13px] font-semibold">
              <span>{th.live.groups[g]}</span><span className="font-num">{groups[g].length}</span>
            </h2>
            <ul>
              {groups[g].map((r) => (
                <li key={r.studentId}>
                  <button
                    type="button"
                    disabled={!r.companyId}
                    aria-pressed={selected?.studentId === r.studentId}
                    onClick={() => setSelected(r)}
                    className="grid min-h-12 w-full grid-cols-[60px_minmax(0,1fr)_auto] items-center gap-x-3 border-x border-b border-rule bg-paper px-3 text-left aria-pressed:outline-2 aria-pressed:-outline-offset-2 aria-pressed:outline-ink disabled:text-ink2"
                  >
                    <span className="font-num">{r.studentCode}</span>
                    <span className="truncate">{r.name}</span>
                    <span className={`text-sm ${g === 'unbalanced' ? 'neg num' : 'text-ink2'}`}>{r.reason}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>
      <div className={`min-w-0 flex-1 ${selected ? '' : 'max-lg:hidden'}`}>
        {selected?.companyId ? (
          <div className="flex flex-col gap-2">
            <button type="button" className="flex min-h-11 items-center text-sm underline lg:hidden" onClick={() => setSelected(null)}>‹ {th.live.back}</button>
            <SpectatePane key={selected.companyId} companyId={selected.companyId} studentLabel={{ code: selected.studentCode, name: selected.name }} />
          </div>
        ) : (
          <p className="text-ink2 max-lg:hidden">{th.live.pick}</p>
        )}
      </div>
    </div>
  );
}
