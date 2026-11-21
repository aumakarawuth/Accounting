import Link from 'next/link';
import { ExportLinks } from '@/components/ExportLinks';
import { MonthNav } from '@/components/MonthNav';
import { Money } from '@/components/Money';
import { serverApi } from '@/lib/server-api';
import type { BookKey, Company, SpecialJournal } from '@/lib/api';
import { isMonth, isoToThai, monthLabel, todayIso } from '@/lib/date';
import { formatMoney } from '@/lib/money';
import { th } from '@/i18n/th';

const BOOKS: BookKey[] = ['sales', 'purchases', 'receipts', 'payments', 'general'];
const isBook = (v: string | undefined): v is BookKey => BOOKS.includes(v as BookKey);
const blank = (v: string | undefined) => !v || /^-?0+\.00$/.test(v);

// สมุดรายวันเฉพาะ (docs/phase6-spec.md ข้อ 1): มุมมองของรายการที่ลงแล้ว แบบฟอร์มสมุดหลายช่องที่สอนในไทย
export default async function BooksPage({
  params, searchParams,
}: { params: Promise<{ companyId: string }>; searchParams: Promise<{ month?: string; book?: string }> }) {
  const { companyId } = await params;
  const sp = await searchParams;
  const month = isMonth(sp.month) ? sp.month : todayIso().slice(0, 7);
  const book: BookKey = isBook(sp.book) ? sp.book : 'sales';
  const [company, j] = await Promise.all([
    serverApi<Company>(`/companies/${companyId}`),
    serverApi<SpecialJournal>(`/companies/${companyId}/books?month=${month}&book=${book}`),
  ]);
  const t = th.books;
  const href = (m: string, b: BookKey = book) => `/c/${companyId}/books?month=${m}&book=${b}`;
  const entry = (id: string) => `/c/${companyId}/journal/${id}`;
  const cell = 'border border-rule px-2 py-1.5 align-top';
  const num = `${cell} text-right whitespace-nowrap`;
  const general = book === 'general';
  const label = (r: SpecialJournal['rows'][number]) =>
    r.reversal && r.reversesDocNo ? t.reversalOf(r.reversesDocNo) : (r.party ?? r.description) || '—';

  return (
    <div className="flex flex-col gap-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-end gap-3 border-b-2 border-ink pb-2.5">
        <div className="min-w-0">
          <h1 className="font-doc text-[20px] font-bold sm:text-2xl">{t.heading(t.names[book]!, company.name, monthLabel(month))}</h1>
          <p className="text-sm text-ink2">{t.count(j.rows.length)}</p>
        </div>
        <div className="flex flex-wrap items-center gap-3 sm:ml-auto">
          <MonthNav month={month} href={(m) => href(m)} />
          <ExportLinks base={`/export/company/${companyId}/journal-${book}`} query={`month=${month}`} />
        </div>
      </div>

      <nav aria-label={t.title} className="flex flex-wrap">
        {BOOKS.map((b, i) => (
          <Link key={b} href={href(month, b)} aria-current={b === book ? 'page' : undefined}
            className={`flex min-h-11 items-center gap-1.5 border border-rule-strong px-3 aria-[current=page]:bg-ink aria-[current=page]:text-paper sm:px-4 ${i > 0 ? 'border-l-0' : ''}`}>
            {t.tabs[b]} <span className="font-num text-[13px]">({j.counts[b]})</span>
          </Link>
        ))}
      </nav>
      <p className="text-[13px] text-ink2">{t.rule}</p>

      {j.rows.length === 0 ? (
        <p className="text-ink2">{t.empty}</p>
      ) : (
        <>
          {/* iPad/คอม: แบบฟอร์มสมุดหลายช่อง เลื่อนแนวนอนเฉพาะตาราง ตรึงคอลัมน์วันที่/รายการ */}
          <div className="overflow-x-auto border border-rule-strong max-sm:hidden" role="region" aria-label={t.names[book]} tabIndex={0}>
            <table className="w-full border-collapse bg-paper text-[14px]">
              <thead className="bg-band text-left text-[13px]">
                {general ? (
                  <tr>
                    <th className={`${cell} w-24 font-medium`}>{t.date}</th>
                    <th className={`${cell} font-medium`}>{t.account}</th>
                    <th className={`${cell} w-20 font-medium`}>{t.ref}</th>
                    <th className={`${cell} w-32 text-right font-medium`}>{t.debit}</th>
                    <th className={`${cell} w-32 text-right font-medium`}>{t.credit}</th>
                  </tr>
                ) : (
                  <>
                    <tr>
                      <th rowSpan={2} className={`${cell} w-24 font-medium`}>{t.date}</th>
                      <th rowSpan={2} className={`${cell} w-24 font-medium`}>{t.docNo}</th>
                      <th rowSpan={2} className={`${cell} sticky left-0 z-10 min-w-[10rem] bg-band font-medium`}>{t.party[book]}</th>
                      {j.columns.map((c) => (
                        <th key={c.key} rowSpan={2} className={`${cell} min-w-[7.5rem] text-right font-medium`}>
                          {t.column(c.side, c.name)}<span className="block font-num text-[12px] text-ink2">{c.code}</span>
                        </th>
                      ))}
                      <th colSpan={4} className={`${cell} text-center font-medium`}>{t.others}</th>
                    </tr>
                    <tr>
                      <th className={`${cell} min-w-[9rem] font-medium`}>{t.othersAccount}</th>
                      <th className={`${cell} font-medium`}>{t.ref}</th>
                      <th className={`${cell} min-w-[6.5rem] text-right font-medium`}>{t.debit}</th>
                      <th className={`${cell} min-w-[6.5rem] text-right font-medium`}>{t.credit}</th>
                    </tr>
                  </>
                )}
              </thead>
              <tbody>
                {j.rows.flatMap((r) => {
                  const doc = (
                    <Link href={entry(r.entryId)} aria-label={t.openEntry(r.docNo)} className={`whitespace-nowrap font-num underline decoration-rule-input ${r.reversal ? 'neg' : ''}`}>{r.docNo}</Link>
                  );
                  if (general) {
                    return [
                      <tr key={r.entryId}>
                        <td className={`${cell} font-num`} rowSpan={r.others.length + 1}>{isoToThai(r.date)}</td>
                        <td className={cell} colSpan={4}>{doc} <span className="text-ink2">{r.reversal && r.reversesDocNo ? t.reversalOf(r.reversesDocNo) : r.description}</span></td>
                      </tr>,
                      ...r.others.map((o, i) => (
                        <tr key={`${r.entryId}-${i}`}>
                          <td className={cell}><span className={blank(o.debit) ? 'pl-7' : ''}>{o.name}</span>{o.memo && <span className="block text-[13px] text-ink2">{o.memo}</span>}</td>
                          <td className={`${cell} font-num`}>{o.code}</td>
                          <td className={num}>{!blank(o.debit) && <Money value={o.debit} />}</td>
                          <td className={num}>{!blank(o.credit) && <Money value={o.credit} />}</td>
                        </tr>
                      )),
                    ];
                  }
                  const n = Math.max(1, r.others.length);
                  return Array.from({ length: n }, (_, i) => {
                    const o = r.others[i];
                    return (
                      <tr key={`${r.entryId}-${i}`}>
                        {i === 0 && (
                          <>
                            <td rowSpan={n} className={`${cell} whitespace-nowrap font-num`}>{isoToThai(r.date)}</td>
                            <td rowSpan={n} className={cell}>{doc}{r.vendorDocNo && <span className="block text-[12px] text-ink2">{t.vendorDoc(r.vendorDocNo)}</span>}</td>
                            <td rowSpan={n} className={`${cell} sticky left-0 bg-paper`}>{label(r)}</td>
                            {j.columns.map((c) => (
                              <td key={c.key} rowSpan={n} className={num}>{!blank(r.cells[c.key]) && <Money value={r.cells[c.key]!} />}</td>
                            ))}
                          </>
                        )}
                        <td className={cell}>{o?.name}</td>
                        <td className={`${cell} font-num`}>{o?.code}</td>
                        <td className={num}>{o && !blank(o.debit) && <Money value={o.debit} />}</td>
                        <td className={num}>{o && !blank(o.credit) && <Money value={o.credit} />}</td>
                      </tr>
                    );
                  });
                })}
              </tbody>
              {!general && (
                <tfoot>
                  <tr className="font-semibold">
                    <th scope="row" colSpan={3} className={`${cell} sticky left-0 border-t-2 border-t-ink bg-paper text-left`}>{t.total}</th>
                    {j.columns.map((c) => (
                      <td key={c.key} className={`${num} border-t-2 border-t-ink`}><Money value={c.total} className="border-b-[3px] border-double border-ink" /></td>
                    ))}
                    <td colSpan={2} className={`${cell} border-t-2 border-t-ink`} />
                    <td className={`${num} border-t-2 border-t-ink`}><Money value={j.othersTotal.debit} /></td>
                    <td className={`${num} border-t-2 border-t-ink`}><Money value={j.othersTotal.credit} /></td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>

          {/* มือถือ: ทีละรายการ */}
          <ul className="border-t border-rule-strong bg-paper sm:hidden" aria-label={t.names[book]}>
            {j.rows.map((r) => (
              <li key={r.entryId} className="flex flex-col gap-1 border-b border-rule px-4 py-2.5">
                <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3">
                  <span className="truncate font-medium">{general ? r.description || '—' : label(r)}</span>
                  <Link href={entry(r.entryId)} aria-label={t.openEntry(r.docNo)} className={`flex min-h-11 items-center font-num text-[14px] underline ${r.reversal ? 'neg' : ''}`}>{r.docNo}</Link>
                  <span className="font-num text-[13px] text-ink2">{isoToThai(r.date)}</span>
                </div>
                <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 text-[14px]">
                  {j.columns.filter((c) => !blank(r.cells[c.key])).map((c) => (
                    <div key={c.key} className="contents">
                      <dt>{t.column(c.side, c.name)}</dt>
                      <dd className="text-right"><Money value={r.cells[c.key]!} /></dd>
                    </div>
                  ))}
                  {r.others.map((o, i) => (
                    <div key={i} className="contents">
                      <dt className={blank(o.debit) ? 'pl-5' : ''}><span className="font-num text-[13px] text-ink2">{o.code} </span>{o.name}</dt>
                      <dd className="text-right"><Money value={blank(o.debit) ? o.credit : o.debit} /> <span className="text-[12px] text-ink2">{blank(o.debit) ? 'Cr' : 'Dr'}</span></dd>
                    </div>
                  ))}
                </dl>
              </li>
            ))}
          </ul>

          <section aria-label={t.posting} className="flex flex-col gap-2">
            <h2 className="text-[17px] font-semibold">{t.posting}</h2>
            <table className="w-full max-w-2xl border-collapse bg-paper text-[14px]">
              <thead className="bg-band text-left text-[13px]">
                <tr>
                  <th className={`${cell} w-16 font-medium max-sm:hidden`}>{t.ref}</th>
                  <th className={`${cell} font-medium`}>{t.othersAccount}</th>
                  <th className={`${cell} w-28 text-right font-medium`}>{t.debit}</th>
                  <th className={`${cell} w-28 text-right font-medium`}>{t.credit}</th>
                </tr>
              </thead>
              <tbody>
                {j.posting.map((p) => (
                  <tr key={p.code}>
                    <td className={`${cell} font-num max-sm:hidden`}>{p.code}</td>
                    <td className={cell}><span className="font-num text-[13px] text-ink2 sm:hidden">{p.code} </span>{p.name}<span className="block text-[12px] text-ink2">{t.via[p.via]}</span></td>
                    <td className={num}>{!blank(p.debit) && <Money value={p.debit} />}</td>
                    <td className={num}>{!blank(p.credit) && <Money value={p.credit} />}</td>
                  </tr>
                ))}
                <tr className="font-semibold">
                  <td className={`${cell} border-t-2 border-t-ink max-sm:hidden`} /><th scope="row" className={`${cell} border-t-2 border-t-ink text-left`}>{t.total}</th>
                  <td className={`${num} border-t-2 border-t-ink`}><Money value={j.totalDebit} className="border-b-[3px] border-double border-ink" /></td>
                  <td className={`${num} border-t-2 border-t-ink`}><Money value={j.totalCredit} className="border-b-[3px] border-double border-ink" /></td>
                </tr>
              </tbody>
            </table>
            <p role="status" className={`text-sm ${j.balanced ? '' : 'neg font-semibold'}`}>
              {j.balanced ? t.balanced(formatMoney(j.totalDebit)) : t.unbalanced(formatMoney(j.totalDebit), formatMoney(j.totalCredit))}
            </p>
            <p className="text-[13px] text-ink2">{t.postingNote}</p>
          </section>
        </>
      )}
    </div>
  );
}

