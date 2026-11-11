import Link from 'next/link';
import { Money } from '@/components/Money';
import { InventoryAdjust } from '@/components/inventory/InventoryAdjust';
import { InventoryMethod } from '@/components/inventory/InventoryMethod';
import { serverApi } from '@/lib/server-api';
import type { ApiError, InventoryOverview, StockCard } from '@/lib/api';
import { isoToThai } from '@/lib/date';
import { th } from '@/i18n/th';

const t = th.inventory;
const cell = 'border-b border-rule px-3 py-2';
const qty = (s: string) => s.replace(/\.?0+$/, '') || '0';

// สินค้าคงเหลือ (perpetual): ยอดคงเหลือทุกสินค้าที่ติดตามสต็อก เทียบยอดบัญชี 1310 · บัตรสต็อกรายสินค้า (?item=รหัส) · ปรับสต็อก
export default async function InventoryPage({ params, searchParams }: { params: Promise<{ companyId: string }>; searchParams: Promise<{ item?: string }> }) {
  const { companyId } = await params;
  const { item } = await searchParams;
  const r = await serverApi<InventoryOverview>(`/companies/${companyId}/inventory`);
  let card: StockCard | null = null;
  if (item && /^[A-Za-z0-9-]{1,20}$/.test(item)) {
    card = await serverApi<StockCard>(`/companies/${companyId}/inventory/${encodeURIComponent(item.toUpperCase())}`).catch((e: ApiError) => {
      if (e.status === 404) return null;
      throw e;
    });
  }
  const same = r.totalValue === r.glBalance;
  const editable = r.company.canWrite && !r.company.locked;

  return (
    <div className="flex max-w-5xl flex-col gap-5 p-4 sm:p-6">
      <div className="border-b-2 border-ink pb-2.5">
        <h1 className="font-doc text-[20px] font-bold sm:text-2xl">{t.title} {r.company.name}</h1>
      </div>
      <p className="text-sm text-ink2">{t.note}</p>
      {r.company.locked && <p role="status" className="border border-rule-strong bg-band px-4 py-2.5">{th.submission.lockedNote}</p>}
      <InventoryMethod companyId={companyId} method={r.company.inventoryMethod} editable={editable} />

      {r.items.length === 0 ? (
        <p className="flex flex-wrap items-center gap-3 text-ink2">{t.empty}
          <Link href={`/c/${companyId}/items`} className="flex min-h-11 items-center underline">{t.manageItems}</Link></p>
      ) : (
        <section className="overflow-x-auto border border-rule-strong bg-paper" aria-label={t.title}>
          <table className="w-full text-sm">
            <thead><tr className="bg-ground text-left">
              <th className={`${cell} font-medium`}>{t.col.code}</th><th className={`${cell} font-medium`}>{t.col.name}</th>
              <th className={`${cell} font-medium max-sm:hidden`}>{t.col2Method}</th>
              <th className={`${cell} text-right font-medium`}>{t.col.qty}</th>
              <th className={`${cell} text-right font-medium max-sm:hidden`}>{t.col.unitCost}</th>
              <th className={`${cell} text-right font-medium`}>{t.col.value}</th>
            </tr></thead>
            <tbody>
              {r.items.map((it) => (
                <tr key={it.code} className={it.code === card?.item.code ? 'bg-band' : undefined}>
                  <td className={`${cell} font-num`}>
                    <Link href={`?item=${it.code}`} className="flex min-h-11 items-center underline" aria-label={`${t.viewCard} ${it.code}`}>{it.code}</Link>
                  </td>
                  <td className={cell}>{it.name}</td>
                  <td className={`${cell} max-sm:hidden`}>{it.method === 'fifo' ? 'FIFO' : t.methods.average}</td>
                  <td className={`${cell} text-right font-num whitespace-nowrap`}>{qty(it.quantity)} {it.unit}</td>
                  <td className={`${cell} text-right font-num max-sm:hidden`}>{Number(it.unitCost).toFixed(2)}</td>
                  <td className={`${cell} text-right`}><Money value={it.value} /></td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr><td colSpan={3} className={`${cell} font-medium sm:hidden`}>{t.total}</td><td colSpan={5} className={`${cell} font-medium max-sm:hidden`}>{t.total}</td>
                <td className={`${cell} text-right font-semibold`}><Money value={r.totalValue} /></td></tr>
              <tr><td colSpan={3} className={`${cell} sm:hidden`}>{t.gl}</td><td colSpan={5} className={`${cell} max-sm:hidden`}>{t.gl}</td>
                <td className={`${cell} text-right`}><Money value={r.glBalance} /></td></tr>
            </tfoot>
          </table>
          <p role="status" className={`px-3 py-2 text-sm ${same ? '' : 'neg'}`}>{same ? `✓ ${t.matches}` : t.mismatch}</p>
        </section>
      )}

      {card && (
        <section className="flex flex-col gap-2" aria-label={t.card(card.item.code, card.item.name)}>
          <h2 className="text-[17px] font-semibold">{t.card(card.item.code, card.item.name)}</h2>
          <p className="text-[14px] text-ink2">{t.methods[card.item.method]}</p>
          {card.card.some((m) => m.restated) && <p className="text-[14px] text-ink2">{t.restatedNote}</p>}
          {card.card.length === 0 ? <p className="text-ink2">{t.cardEmpty}</p> : (
            <div className="overflow-x-auto border border-rule-strong bg-paper">
              <table className="w-full min-w-[640px] text-sm">
                <thead><tr className="bg-ground text-left">
                  {[t.cardCol.date, t.cardCol.ref].map((h) => <th key={h} className={`${cell} font-medium`}>{h}</th>)}
                  {[t.cardCol.qtyIn, t.cardCol.qtyOut, t.cardCol.unitCost, t.cardCol.value, t.cardCol.balQty, t.cardCol.balValue].map((h) =>
                    <th key={h} className={`${cell} text-right font-medium`}>{h}</th>)}
                </tr></thead>
                <tbody>
                  {card.card.map((m, i) => (
                    <tr key={i}>
                      <td className={`${cell} font-num whitespace-nowrap`}>{isoToThai(m.date)}</td>
                      <td className={cell}>
                        <Link href={`/c/${companyId}/journal/${m.entryId}`} className="font-num underline">{m.entryDocNo}</Link>
                        {m.reference && <span className="text-ink2"> {m.reference}</span>}
                        {m.restated && <span className="text-ink2"> · {t.restated}</span>}
                      </td>
                      <td className={`${cell} text-right font-num`}>{Number(m.qtyIn) ? qty(m.qtyIn) : ''}</td>
                      <td className={`${cell} text-right font-num`}>{Number(m.qtyOut) ? qty(m.qtyOut) : ''}</td>
                      <td className={`${cell} text-right font-num`}>{Number(m.unitCost).toFixed(2)}</td>
                      <td className={`${cell} text-right`}><Money value={Number(m.valueIn) ? m.valueIn : `-${m.valueOut}`} /></td>
                      <td className={`${cell} text-right font-num`}>{qty(m.balanceQty)}</td>
                      <td className={`${cell} text-right`}><Money value={m.balanceValue} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {card.layers && card.layers.length > 0 && (
            <div className="flex flex-col gap-1 pt-2" role="region" aria-label={t.layersTitle}>
              <h3 className="font-semibold">{t.layersTitle}</h3>
              <p className="text-[14px] text-ink2">{t.layersNote}</p>
              <div className="overflow-x-auto border border-rule-strong bg-paper">
                <table className="w-full text-sm">
                  <thead><tr className="bg-ground text-left">
                    <th className={`${cell} font-medium`}>{t.layerCol.date}</th>
                    {[t.layerCol.qty, t.layerCol.unitCost, t.layerCol.value].map((h) => <th key={h} className={`${cell} text-right font-medium`}>{h}</th>)}
                  </tr></thead>
                  <tbody>{card.layers.map((l, i) => (
                    <tr key={i}>
                      <td className={`${cell} font-num`}>{isoToThai(l.date)}</td>
                      <td className={`${cell} text-right font-num`}>{qty(l.qty)}</td>
                      <td className={`${cell} text-right font-num`}>{(Number(l.value) / Number(l.qty)).toFixed(2)}</td>
                      <td className={`${cell} text-right`}><Money value={l.value} /></td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            </div>
          )}
        </section>
      )}

      {editable && r.items.length > 0 && (
        <InventoryAdjust companyId={companyId} items={r.items.filter((i) => i.active)} accounts={r.accounts} initialItem={card?.item.code} />
      )}
    </div>
  );
}
