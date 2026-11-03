import Link from 'next/link';
import { th } from '@/i18n/th';

// รวมรายงานทุกตัวของบริษัท (แถบล่างมือถือ "รายงาน" และเมนูข้าง)
const GROUPS: { title: string; items: [key: string, path: string][] }[] = [
  { title: th.reportsPage.groups.gl, items: [['ledger', '/ledger'], ['trialBalance', '/trial-balance'], ['worksheet', '/worksheet'], ['statements', '/statements']] },
  { title: th.reportsPage.groups.partner, items: [['receivables', '/sales/receivables'], ['payables', '/purchases/payables']] },
  { title: th.reportsPage.groups.tax, items: [['vat', '/tax/vat'], ['wht', '/tax/wht']] },
];

export default async function ReportsPage({ params }: { params: Promise<{ companyId: string }> }) {
  const { companyId } = await params;
  return (
    <div className="flex flex-col gap-5 p-4 sm:p-6">
      <h1 className="border-b-2 border-ink pb-2.5 font-doc text-[22px] font-bold sm:text-2xl">{th.reportsPage.title}</h1>
      <div className="grid gap-5 lg:grid-cols-3">
        {GROUPS.map((g) => (
          <section key={g.title} aria-label={g.title} className="flex flex-col gap-2">
            <h2 className="text-[17px] font-semibold">{g.title}</h2>
            <ul className="border-t border-rule-strong bg-paper">
              {g.items.map(([key, path]) => {
                const [name, note] = th.reportsPage.items[key]!;
                return (
                  <li key={key} className="border-b border-rule">
                    <Link href={`/c/${companyId}${path}`} className="flex min-h-14 flex-col justify-center px-4 py-2">
                      <span className="font-medium">{name}</span>
                      <span className="text-[13px] text-ink2">{note}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
