import { CancelPanel } from '@/components/CancelPanel';
import { TransferForm, WarehouseList } from '@/components/inventory/Warehouses';
import { serverApi } from '@/lib/server-api';
import type { InventoryOverview, InventoryTransfer } from '@/lib/api';
import { isoToThai } from '@/lib/date';
import { th } from '@/i18n/th';

const t = th.warehouses;
const qty = (s: string) => s.replace(/\.?0+$/, '') || '0';

// คลังสินค้า: รายชื่อคลัง คงเหลือตามคลัง และใบโอนย้าย (ไม่ลงบัญชี)
export default async function WarehousesPage({ params }: { params: Promise<{ companyId: string }> }) {
  const { companyId } = await params;
  const [r, transfers] = await Promise.all([
    serverApi<InventoryOverview>(`/companies/${companyId}/inventory`),
    serverApi<InventoryTransfer[]>(`/companies/${companyId}/inventory/transfers`),
  ]);
  const editable = r.company.canWrite && !r.company.locked;
  const warehouses = r.warehouses.length ? r.warehouses : [{ code: 'MAIN', name: t.main, isMain: true, active: true }];
  const names = new Map(r.items.map((i) => [i.code, i]));
  const cell = 'border-b border-rule px-3 py-2';

  return (
    <div className="flex max-w-5xl flex-col gap-5 p-4 sm:p-6">
      <div className="border-b-2 border-ink pb-2.5">
        <h1 className="font-doc text-[20px] font-bold sm:text-2xl">{t.title} {r.company.name}</h1>
      </div>
      <p className="text-sm text-ink2">{t.note}</p>
      <WarehouseList companyId={companyId} warehouses={warehouses} editable={editable} />

      <section className="flex flex-col gap-2" aria-label={t.stock}>
        <h2 className="text-[17px] font-semibold">{t.stock}</h2>
        {r.stock.length === 0 ? <p className="text-ink2">{t.noStock}</p> : (
          <div className="overflow-x-auto border border-rule-strong bg-paper">
            <table className="w-full text-sm">
              <thead><tr className="bg-ground text-left">
                <th className={`${cell} font-medium`}>{th.inventory.warehouse}</th><th className={`${cell} font-medium`}>{th.inventory.col.name}</th>
                <th className={`${cell} text-right font-medium`}>{th.inventory.col.qty}</th>
              </tr></thead>
              <tbody>{r.stock.map((s) => (
                <tr key={`${s.warehouse}-${s.itemCode}`}>
                  <td className={`${cell} font-num`}>{s.warehouse}</td>
                  <td className={cell}><span className="font-num">{s.itemCode}</span> {names.get(s.itemCode)?.name}</td>
                  <td className={`${cell} text-right font-num`}>{qty(s.qty)} {names.get(s.itemCode)?.unit}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </section>

      {editable && warehouses.filter((w) => w.active).length > 1 && r.items.length > 0 && (
        <TransferForm companyId={companyId} warehouses={warehouses} items={r.items.filter((i) => i.active)} />
      )}

      <section className="flex flex-col gap-2" aria-label={t.transfers}>
        <h2 className="text-[17px] font-semibold">{t.transfers}</h2>
        {transfers.length === 0 ? <p className="text-ink2">{t.transferEmpty}</p> : (
          <ul className="border-t border-rule-strong bg-paper">
            {transfers.map((x) => (
              <li key={x.id} className={`flex flex-col gap-1 border-b border-rule px-3 py-2 ${x.cancelled ? 'text-ink2' : ''}`}>
                <div className="flex flex-wrap gap-x-3">
                  <span className={`font-num ${x.cancelled ? 'line-through' : ''}`}>{x.docNo}</span>
                  <span className="font-num">{isoToThai(x.date)}</span>
                  <span>{x.from} → {x.to}</span>
                </div>
                <div className="text-sm">{x.lines.map((l) => `${l.itemCode} ${l.name} ${qty(l.qty)} ${l.unit}`).join(' · ')}</div>
                {x.cancelled && x.cancelReason && <div className="text-sm">{t.cancelled(x.cancelReason)}</div>}
                {editable && !x.cancelled && (
                  <CancelPanel path={`/companies/${companyId}/inventory/transfers/${x.id}/cancel`} title={t.cancel} explain={t.cancelExplain} />
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
