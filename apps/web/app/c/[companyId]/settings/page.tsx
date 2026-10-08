import { CompanyProfileForm } from '@/components/CompanyProfileForm';
import { serverApi } from '@/lib/server-api';
import type { CompanyProfile } from '@/lib/api';
import { th } from '@/i18n/th';

export default async function SettingsPage({ params }: { params: Promise<{ companyId: string }> }) {
  const { companyId } = await params;
  const profile = await serverApi<CompanyProfile>(`/companies/${companyId}/profile`);
  return (
    <div className="flex max-w-3xl flex-col gap-4 p-4 sm:p-6">
      <div className="border-b-2 border-ink pb-2.5">
        <h1 className="font-doc text-[20px] font-bold sm:text-2xl">{th.profile.title}</h1>
        <p className="text-sm text-ink2">{th.profile.note}</p>
      </div>
      {profile.locked && <p role="status" className="border border-rule-strong bg-band px-4 py-2.5">{th.submission.lockedNote}</p>}
      {!profile.canEdit && <p className="text-sm text-ink2">{th.master.readOnly}</p>}
      <CompanyProfileForm companyId={companyId} initial={profile} editable={profile.canEdit && !profile.locked} />
    </div>
  );
}
