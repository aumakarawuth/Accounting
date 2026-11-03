'use client';

import Link from 'next/link';
import { useMemo, useState, type ReactNode } from 'react';
import { Button } from '@/components/Button';
import { Money } from '@/components/Money';
import { AccountSelect, ConfirmPanel, DateInput, PlainInput, useAction } from '@/components/ConfirmPanel';
import type { AssetPage, AssetRow, DepreciationRunRow } from '@/lib/api';
import { addMonths, isoToThai, monthLabel, thaiToIso, todayIso } from '@/lib/date';
import { depreciationFor, monthlyDepreciation } from '@/lib/depreciation';
import { formatMoney, fromCents, toCents } from '@/lib/money';
import { th } from '@/i18n/th';

const t = th.assets;
const CODE = /^[A-Z0-9][A-Z0-9-]{0,19}$/;
const sum = (rows: AssetRow[], k: 'cost' | 'accumulated' | 'bookValue' | 'depThisMonth') =>
  fromCents(rows.reduce((s, r) => s + (toCents(r[k]) ?? 0n), 0n));

/** ทะเบียนทรัพย์สิน ณ สิ้นเดือน + ลงค่าเสื่อมประจำเดือน + จำหน่าย + ลงทะเบียนใหม่ */
export function FixedAssets({ companyId, data }: { companyId: string; data: AssetPage }) {
  const writable = data.company.canWrite && !data.company.locked;
  const [adding, setAdding] = useState(false);
  const [acting, setActing] = useState<{ id: string; kind: 'dispose' | 'voidDisposal' | 'voidAsset' } | null>(null);
  const [depOpen, setDepOpen] = useState(false);
  const [voidRun, setVoidRun] = useState<string | null>(null);
  const href = (p: string) => `/c/${companyId}${p}`;
  const live = data.assets.filter((r) => r.status !== 'disposed');
  const cell = 'border border-rule px-2.5 py-2 align-top';
  const month = monthLabel(data.month);
  const due = data.assets.some((r) => r.nextMonth !== null && r.nextMonth <= data.month);

  const status = (r: AssetRow) => (
    <>
      <span className="font-medium">{t.status[r.status]}</span>
      <span className="block text-[13px] text-ink2">
        {r.status === 'disposed' && r.disposalDate ? t.disposedOn(isoToThai(r.disposalDate), formatMoney(r.gainLoss ?? '0'))
          : [t.posted(r.monthsPosted, r.lifeMonths), r.nextMonth && t.next(monthLabel(r.nextMonth))].filter(Boolean).join(' · ')}
      </span>
      <span className="flex flex-wrap gap-x-3 text-[13px]">
        {r.entryId && <Link className="underline decoration-rule-input" href={href(`/journal/${r.entryId}`)}>{t.viewEntry('FA')}</Link>}
        {r.disposalEntryId && <Link className="underline decoration-rule-input" href={href(`/journal/${r.disposalEntryId}`)}>{t.viewEntry('FD')}</Link>}
      </span>
    </>
  );
  const buttons = (r: AssetRow) => writable && (
    <span className="flex flex-wrap gap-2">
      {!r.disposalId && <Button type="button" variant="secondary" className="min-h-11 px-3 text-sm" onClick={() => setActing({ id: r.id, kind: 'dispose' })}>{t.dispose}</Button>}
      {r.disposalId && <Button type="button" variant="secondary" className="min-h-11 px-3 text-sm" onClick={() => setActing({ id: r.id, kind: 'voidDisposal' })}>{t.voidDisposal}</Button>}
      {!r.disposalId && r.monthsPosted === 0 && <Button type="button" variant="secondary" className="min-h-11 px-3 text-sm" onClick={() => setActing({ id: r.id, kind: 'voidAsset' })}>{t.voidAsset}</Button>}
    </span>
  );
  const panel = (r: AssetRow) => acting?.id === r.id && (
    acting.kind === 'dispose'
      ? <DisposePanel companyId={companyId} asset={r} accounts={data.accounts} onDone={() => setActing(null)} />
      : <ReasonPanel title={acting.kind === 'voidAsset' ? `${t.voidAsset} ${r.code}` : `${t.voidDisposal} ${r.code}`}
          explain={acting.kind === 'voidAsset' ? t.voidAssetExplain : t.voidDisposalExplain}
          path={acting.kind === 'voidAsset' ? `/companies/${companyId}/fixed-assets/${r.id}/void` : `/companies/${companyId}/asset-disposals/${r.disposalId}/void`}
          onDone={() => setActing(null)} />
  );

  return (
    <div className="flex flex-col gap-5">
      {!data.company.canWrite && <p className="text-sm text-ink2">{t.readOnly}</p>}
      {data.company.locked && <p role="status" className="border border-rule-strong bg-band px-4 py-2.5">{th.submission.lockedNote}</p>}

      <section aria-label={t.title} className="flex flex-col gap-2">
        {data.assets.length === 0 ? <p className="text-ink2">{t.empty}</p> : (
          <>
            <div className="overflow-x-auto max-sm:hidden">
              <table className="w-full min-w-[56rem] border-collapse bg-paper text-[15px]">
                <thead className="bg-band text-left text-sm">
                  <tr>
                    <th className={`${cell} font-medium`}>{t.col.code} / {t.col.name}</th>
                    <th className={`${cell} w-28 font-medium`}>{t.col.acquired}</th>
                    <th className={`${cell} w-32 text-right font-medium`}>{t.col.cost}</th>
                    <th className={`${cell} w-28 text-right font-medium`}>{t.col.monthly}</th>
                    <th className={`${cell} w-28 text-right font-medium`}>{t.col.thisMonth}</th>
                    <th className={`${cell} w-32 text-right font-medium`}>{t.col.accumulated}</th>
                    <th className={`${cell} w-32 text-right font-medium`}>{t.col.book}</th>
                    <th className={`${cell} w-56 font-medium`}>{t.col.status}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.assets.map((r) => (
                    <AssetTableRow key={r.id} r={r} cell={cell} status={status(r)} buttons={buttons(r)} panel={panel(r)} />
                  ))}
                </tbody>
                <tfoot className="font-semibold">
                  <tr>
                    <td className={cell} colSpan={2}>{t.total}</td>
                    <td className={`${cell} text-right`}><Money value={sum(live, 'cost')} /></td>
                    <td className={cell} />
                    <td className={`${cell} text-right`}><Money value={sum(data.assets, 'depThisMonth')} /></td>
                    <td className={`${cell} text-right`}><Money value={sum(live, 'accumulated')} /></td>
                    <td className={`${cell} border-b-[3px] border-b-ink border-double text-right`}><Money value={sum(live, 'bookValue')} /></td>
                    <td className={cell} />
                  </tr>
                </tfoot>
              </table>
            </div>
            <ul className="border-t border-rule-strong bg-paper sm:hidden">
              {data.assets.map((r) => (
                <li key={r.id} className="flex flex-col gap-1.5 border-b border-rule px-4 py-3">
                  <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3">
                    <span className="truncate"><span className="font-num">{r.code}</span> <span className="font-medium">{r.name}</span></span>
                    <Money value={r.bookValue} />
                    <span className="font-num text-[13px] text-ink2">{isoToThai(r.acquiredDate)} · {t.col.cost} {formatMoney(r.cost)}</span>
                    <span className="text-right text-[13px] text-ink2">{t.col.accumulated} <span className="num">{formatMoney(r.accumulated)}</span></span>
                  </div>
                  <div className="text-sm">{status(r)}</div>
                  {buttons(r)}
                  {panel(r)}
                </li>
              ))}
              <li className="grid grid-cols-[minmax(0,1fr)_auto] border-b-[3px] border-double border-ink px-4 py-2 font-semibold">
                <span>{t.col.book}</span><Money value={sum(live, 'bookValue')} />
              </li>
            </ul>
          </>
        )}
      </section>

      {writable && (
        <div className="flex flex-col gap-3">
          {depOpen ? (
            <DepreciatePanel companyId={companyId} month={data.month} onDone={() => setDepOpen(false)} />
          ) : (
            <div className="flex flex-wrap gap-3">
              <Button type="button" disabled={!due} onClick={() => setDepOpen(true)} className="max-sm:w-full">{t.depreciate(month)}</Button>
              {!adding && <Button type="button" variant="secondary" onClick={() => setAdding(true)} className="max-sm:w-full">{t.add}</Button>}
            </div>
          )}
          {adding && <NewAsset companyId={companyId} data={data} onDone={() => setAdding(false)} />}
        </div>
      )}

      <section aria-label={t.runs} className="flex flex-col gap-2">
        <h2 className="border-b border-ink pb-1.5 font-doc text-[18px] font-bold">{t.runs}</h2>
        {data.runs.length === 0 ? <p className="text-ink2">{t.runsEmpty}</p> : (
          <ul className="border-t border-rule bg-paper">
            {data.runs.map((r, i) => (
              <RunRow key={r.id} companyId={companyId} run={r} canVoid={writable && !r.voided && i === data.runs.findIndex((x) => !x.voided)}
                open={voidRun === r.id} onOpen={() => setVoidRun(r.id)} onClose={() => setVoidRun(null)} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function AssetTableRow({ r, cell, status, buttons, panel }: { r: AssetRow; cell: string; status: ReactNode; buttons: ReactNode; panel: ReactNode }) {
  return (
    <>
      <tr>
        <td className={cell}><span className="font-num">{r.code}</span> <span className="font-medium">{r.name}</span>
          <span className="block font-num text-[13px] text-ink2">{r.assetCode} · {r.accumCode} · {r.expenseCode} · {t.lifeUnit(r.lifeMonths)}</span></td>
        <td className={`${cell} font-num`}>{isoToThai(r.acquiredDate)}</td>
        <td className={`${cell} text-right`}><Money value={r.cost} />{r.salvage !== '0.00' && <span className="block text-[13px] text-ink2">{th.assets.col.salvage} <span className="num">{formatMoney(r.salvage)}</span></span>}</td>
        <td className={`${cell} text-right`}><Money value={r.monthly} /></td>
        <td className={`${cell} text-right`}><Money value={r.depThisMonth} /></td>
        <td className={`${cell} text-right`}><Money value={r.accumulated} /></td>
        <td className={`${cell} text-right`}><Money value={r.bookValue} /></td>
        <td className={cell}><div className="flex flex-col gap-2"><div>{status}</div>{buttons}</div></td>
      </tr>
      {panel && <tr><td colSpan={8} className="border border-rule p-2">{panel}</td></tr>}
    </>
  );
}

function RunRow({ companyId, run, canVoid, open, onOpen, onClose }: {
  companyId: string; run: DepreciationRunRow; canVoid: boolean; open: boolean; onOpen: () => void; onClose: () => void;
}) {
  const a = useAction();
  const label = monthLabel(run.month);
  return (
    <li className={`flex flex-col gap-2 border-b border-rule px-3 py-2.5 ${run.voided ? 'text-ink2' : ''}`}>
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3">
        <span>
          {run.entryId && run.docNo ? <Link className="font-num underline decoration-rule-input" href={`/c/${companyId}/journal/${run.entryId}`}>{run.docNo}</Link> : null}
          {' '}{t.runLine(label, run.lines)}
          {run.voided && run.voidDocNo && <span className="neg text-sm"> · {t.runVoided(run.voidDocNo)}</span>}
        </span>
        <span className="flex items-center gap-3">
          <Money value={run.amount} />
          {canVoid && !open && <Button type="button" variant="secondary" className="min-h-11 px-3 text-sm" onClick={onOpen}>{t.voidRun}</Button>}
        </span>
      </div>
      {open && (
        <ConfirmPanel title={t.voidRunTitle(label)} explain={t.voidRunExplain} ready busy={a.busy} error={a.error} onCancel={onClose}
          onConfirm={async () => { if (await a.run(`/companies/${companyId}/depreciation/${run.id}/void`, {})) onClose(); }} />
      )}
    </li>
  );
}

function DepreciatePanel({ companyId, month, onDone }: { companyId: string; month: string; onDone: () => void }) {
  const a = useAction();
  const [done, setDone] = useState<string | null>(null);
  return (
    <ConfirmPanel title={t.depreciate(monthLabel(month))} explain={t.depreciateExplain} ready={!done} busy={a.busy} error={a.error} onCancel={onDone}
      onConfirm={async () => {
        const r = await a.run<{ docNo: string | null }>(`/companies/${companyId}/depreciation`, { month });
        if (r) setDone(t.depreciated(r.docNo ?? '-'));
      }}>
      {done && <p role="status" className="text-[15px]">{done}</p>}
    </ConfirmPanel>
  );
}

function ReasonPanel({ title, explain, path, onDone }: { title: string; explain: string; path: string; onDone: () => void }) {
  const a = useAction();
  const [reason, setReason] = useState('');
  return (
    <ConfirmPanel title={title} explain={explain} ready={reason.trim() !== ''} busy={a.busy} error={a.error} onCancel={onDone}
      onConfirm={async () => { if (await a.run(path, { reason: reason.trim() })) onDone(); }}>
      <PlainInput label={t.reason} value={reason} onChange={setReason} maxLength={300} />
    </ConfirmPanel>
  );
}

function DisposePanel({ companyId, asset, accounts, onDone }: { companyId: string; asset: AssetRow; accounts: { code: string; name: string }[]; onDone: () => void }) {
  // วันที่ตั้งต้น = วันแรกของเดือนถัดจากเดือนที่ลงค่าเสื่อมล่าสุด (หรือวันนี้ถ้าหลังจากนั้น)
  const today = todayIso();
  const first = asset.nextMonth ? `${asset.nextMonth}-01` : today;
  const [date, setDate] = useState(isoToThai(today > first ? today : first));
  const [proceeds, setProceeds] = useState('');
  const [acc, setAcc] = useState(accounts.find((x) => x.code === '1120')?.code ?? accounts[0]?.code ?? '');
  const a = useAction();
  const iso = thaiToIso(date);
  const p = toCents(proceeds);
  const book = toCents(asset.bookValue) ?? 0n;
  const ready = iso !== null && p !== null && (p === 0n || acc !== '');
  return (
    <ConfirmPanel title={t.disposeTitle(asset.code)} explain={t.disposeExplain} ready={ready} busy={a.busy} error={a.error} onCancel={onDone}
      onConfirm={async () => {
        const r = await a.run(`/companies/${companyId}/fixed-assets/${asset.id}/dispose`, {
          date: iso, ...(p && p > 0n ? { proceeds: fromCents(p), proceedsAccount: acc } : {}),
        });
        if (r) onDone();
      }}>
      <div className="grid gap-3 @md:grid-cols-3">
        <DateInput label={t.disposeDate} value={date} onChange={setDate} invalid={iso === null} />
        <PlainInput label={t.proceeds} value={proceeds} onChange={setProceeds} inputMode="decimal" invalid={p === null} />
        {p !== null && p > 0n && <AccountSelect label={t.proceedsAccount} value={acc} onChange={setAcc} accounts={accounts} />}
      </div>
      {p !== null && <p className="text-sm">{t.gainPreview(formatMoney(asset.bookValue), formatMoney(fromCents(p - book)))}</p>}
    </ConfirmPanel>
  );
}

function NewAsset({ companyId, data, onDone }: { companyId: string; data: AssetPage; onDone: () => void }) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [acquired, setAcquired] = useState(isoToThai(todayIso()));
  const [nextMonth, setNextMonth] = useState(false);
  const [cost, setCost] = useState('');
  const [salvage, setSalvage] = useState('');
  const [years, setYears] = useState('5');
  const [months, setMonths] = useState<string | null>(null); // null = ปี × 12
  const [assetAcc, setAssetAcc] = useState(data.assetAccounts.find((x) => x.code === '1630')?.code ?? data.assetAccounts[0]?.code ?? '');
  const [accumAcc, setAccumAcc] = useState(data.assetAccounts.find((x) => x.code === '1631')?.code ?? '');
  const [expAcc, setExpAcc] = useState(data.expenseAccounts.find((x) => x.code === '5250')?.code ?? data.expenseAccounts[0]?.code ?? '');
  const [counter, setCounter] = useState('');
  const a = useAction();
  const iso = thaiToIso(acquired);
  const c = toCents(cost);
  const s = toCents(salvage);
  const life = months !== null ? Number(months) : Number(years) * 12;
  const lifeOk = Number.isInteger(life) && life >= 1 && life <= 1200;
  const errors = {
    code: code !== '' && !CODE.test(code) ? t.invalid.code : null,
    cost: cost !== '' && (c === null || c <= 0n) ? t.invalid.cost : null,
    salvage: s === null || (c !== null && s !== null && c > 0n && s >= c) ? t.invalid.salvage : null,
    life: !lifeOk ? t.invalid.life : null,
  };
  const ready = CODE.test(code) && name.trim() !== '' && iso !== null && c !== null && c > 0n && !errors.salvage && lifeOk
    && assetAcc !== '' && accumAcc !== '' && assetAcc !== accumAcc && expAcc !== '';
  const preview = useMemo(() => (ready ? t.preview(formatMoney(fromCents(monthlyDepreciation(c!, s!, life))), formatMoney(fromCents(depreciationFor(c!, s!, life, life)))) : null),
    [ready, c, s, life]);
  const err = Object.values(errors).find(Boolean);

  return (
    <ConfirmPanel title={t.addTitle} explain={t.counterHint} ready={ready} busy={a.busy} error={a.error} confirm={t.save} onCancel={onDone}
      onConfirm={async () => {
        const r = await a.run(`/companies/${companyId}/fixed-assets`, {
          code, name: name.trim(), acquiredDate: iso, ...(nextMonth ? { depStart: addMonths(iso!.slice(0, 7), 1) } : {}),
          cost: fromCents(c!), ...(s && s > 0n ? { salvage: fromCents(s) } : {}), lifeMonths: life,
          assetAccount: assetAcc, accumAccount: accumAcc, expenseAccount: expAcc, ...(counter ? { counterAccount: counter } : {}),
        });
        if (r) onDone();
      }}>
      <div className="grid gap-3 @md:grid-cols-2 @3xl:grid-cols-3">
        <PlainInput label={t.code} value={code} onChange={(v) => setCode(v.toUpperCase().trim())} mono maxLength={20} invalid={Boolean(errors.code)} />
        <PlainInput label={t.name} value={name} onChange={setName} maxLength={160} />
        <DateInput label={t.acquiredDate} value={acquired} onChange={setAcquired} invalid={iso === null} />
        <PlainInput label={t.cost} value={cost} onChange={setCost} inputMode="decimal" invalid={Boolean(errors.cost)} />
        <PlainInput label={t.salvage} value={salvage} onChange={setSalvage} inputMode="decimal" invalid={Boolean(errors.salvage)} />
        <div className="grid grid-cols-2 gap-3">
          <PlainInput label={t.lifeYears} value={years} onChange={(v) => { setYears(v); setMonths(null); }} inputMode="numeric" invalid={Boolean(errors.life)} />
          <PlainInput label={t.lifeMonths} value={months ?? String(life || '')} onChange={setMonths} inputMode="numeric" invalid={Boolean(errors.life)} />
        </div>
        <AccountSelect label={t.assetAccount} value={assetAcc} onChange={setAssetAcc} accounts={data.assetAccounts} />
        <AccountSelect label={t.accumAccount} value={accumAcc} onChange={setAccumAcc} accounts={data.assetAccounts} />
        <AccountSelect label={t.expenseAccount} value={expAcc} onChange={setExpAcc} accounts={data.expenseAccounts} />
        <label className="flex min-w-0 flex-col text-sm">
          {t.depStart}
          <select className="h-11 w-full border-b border-rule-input bg-transparent text-base" value={nextMonth ? 'next' : 'same'} onChange={(e) => setNextMonth(e.target.value === 'next')}>
            <option value="same">{t.depStartSame}</option>
            <option value="next">{t.depStartNext}</option>
          </select>
        </label>
        <AccountSelect label={t.counter} value={counter} onChange={setCounter} accounts={data.accounts.filter((x) => x.code !== assetAcc && x.code !== accumAcc)} none={t.counterNone} />
      </div>
      {err && <p className="neg text-sm">{err}</p>}
      {preview && <p className="text-sm">{preview}</p>}
    </ConfirmPanel>
  );
}
