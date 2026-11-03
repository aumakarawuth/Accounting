import { th } from '@/i18n/th';
import { LogoutButton } from './LogoutButton';
import { WatchBanner } from './WatchBanner';
import { SaveStatus } from './SaveStatus';
import { BackButton } from './BackButton';

type Props = {
  company: string;
  home: string; // ปลายทางของปุ่มย้อนกลับเมื่อไม่มีประวัติ
  month: string; // "ต.ค. 2569"
  mode: keyof typeof th.mode;
  work?: keyof typeof th.work.state | null; // สถานะงานในโหมดส่งงาน
  userId: string; // ฟังช่อง student:<id> เพื่อแสดงป้ายครูกำลังดู
  user: string;
};

// แสดงเสมอ: ชื่อบริษัท | งวด | โหมด | สถานะบันทึก (+ ป้ายครูกำลังดู)
export function Topbar({ company, home, month, mode, work, userId, user }: Props) {
  const cell = 'border-l border-rule px-4 max-sm:border-0 max-sm:px-0';
  return (
    <header className="flex items-center border-b border-rule-strong bg-paper max-sm:pl-1">
      <BackButton fallback={home} />
      <div className="flex min-h-[52px] min-w-0 flex-1 items-center text-[15px] max-sm:flex-col max-sm:items-start max-sm:px-2 max-sm:py-2 sm:min-h-14 lg:min-h-[52px]">
        <span className="hidden w-[220px] shrink-0 px-4 font-semibold lg:block lg:w-[232px]">{th.app.name}</span>
        <a href="/" title={th.company.switch} className="px-4 font-semibold max-sm:px-0 lg:border-l lg:border-rule lg:font-normal">{company}</a>
        <span className="text-ink2 max-sm:text-[13px] sm:contents">
          <span className={cell}>{th.topbar.period(month)}</span>
          <span className="sm:hidden"> · </span>
          <span className={cell}>{th.mode[mode]}{work ? ` · ${th.work.state[work]}` : ''}</span>
          <span className="sm:hidden"> · </span>
          <SaveStatus className={`${cell} sm:text-ink2`} />
        </span>
        <WatchBanner userId={userId} />
        <span className="hidden items-center gap-4 border-l border-rule px-4 text-sm sm:ml-auto sm:flex">
          {user}
          <LogoutButton />
        </span>
      </div>
    </header>
  );
}
