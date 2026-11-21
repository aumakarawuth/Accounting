import Link from 'next/link';
import { IncomeTax } from '@/components/incometax/IncomeTax';
import { serverApi } from '@/lib/server-api';
import type { Company, IncomeTaxPage } from '@/lib/api';
import { isoToThai } from '@/lib/date';
import { th } from '@/i18n/th';

// ภาษีเงินได้นิติบุคคล ภ.ง.ด.51 / ภ.ง.ด.50 (บริษัทจำกัด · docs/phase7-spec.md ข้อ 2)
export default async function IncomeTaxRoute({
  params, searchParams,
}: { params: Promise<{ companyId: string }>; searchParams: Promise<{ year?: string }> }) {
  const { companyId } = await params;
  const sp = await searchParams;
  const q = sp.year && /^\d{4}-\d{2}-\d{2}$/.test(sp.year) ? `?yearEnd=${sp.year}` : '';
  const [company, data] = await Promise.all([
    serverApi<Company>(`/companies/${companyId}`),
    serverApi<IncomeTaxPage>(`/companies/${companyId}/income-tax${q}`),
  ]);
  const t = th.incomeTax;
  return (
    <div className="flex min-h-full flex-col gap-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-end gap-3 border-b-2 border-ink pb-2.5">
        <h1 className="font-doc text-[20px] font-bold sm:text-2xl">{t.title} {company.name}</h1>
        {data.years.length > 1 && (
          <nav aria-label={t.year} className="flex flex-wrap gap-2 sm:ml-auto">
            {data.years.map((y) => (
              <Link key={y.end} href={`/c/${companyId}/tax/income-tax?year=${y.end}`} aria-current={y.end === data.yearEnd ? 'page' : undefined}
                className="flex min-h-11 items-center border border-rule-strong px-3 text-sm aria-[current=page]:bg-ink aria-[current=page]:text-paper">
                {t.yearRange(isoToThai(y.start), isoToThai(y.end))}
              </Link>
            ))}
          </nav>
        )}
      </div>
      <p className="max-w-3xl text-sm text-ink2">{t.note}</p>
      {data.entityType !== 'company' ? <p role="status" className="border border-rule-strong bg-band px-4 py-2.5">{t.onlyCompany}</p>
        : <IncomeTax key={data.yearEnd} companyId={companyId} data={data} />}
    </div>
  );
}
