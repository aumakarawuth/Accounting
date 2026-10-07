import { th } from '@/i18n/th';
import { LogoutButton } from './LogoutButton';

type Props = {
  company: string;
  month: string; // "ต.ค. 2569"
  mode: keyof typeof th.mode;
  status: string;
  watchedBy?: string; // ชื่อครูที่กำลังดู (เฟส 1: มาจาก realtime)
  user: string;
};

// แสดงเสมอ: ชื่อบริษัท | งวด | โหมด | สถานะบันทึก (+ ป้ายครูกำลังดู)
export function Topbar({ company, month, mode, status, watchedBy, user }: Props) {
  const cell = 'border-l border-rule px-4 max-sm:border-0 max-sm:px-0';
  return (
    <header className="border-b border-rule-strong bg-paper">
      <div className="flex min-h-[52px] items-center text-[15px] max-sm:flex-col max-sm:items-start max-sm:px-4 max-sm:py-2 sm:min-h-14 lg:min-h-[52px]">
        <span className="hidden w-[220px] shrink-0 px-4 font-semibold lg:block lg:w-[232px]">{th.app.name}</span>
        <span className="px-4 font-semibold max-sm:px-0 lg:border-l lg:border-rule lg:font-normal">{company}</span>
        <span className="text-ink2 max-sm:text-[13px] sm:contents">
          <span className={cell}>{th.topbar.period(month)}</span>
          <span className="sm:hidden"> · </span>
          <span className={cell}>{th.mode[mode]}</span>
          <span className="sm:hidden"> · </span>
          <span className={`${cell} sm:text-ink2`}>{status}</span>
        </span>
        {watchedBy && (
          <span className="flex items-center gap-2 text-sm sm:ml-auto sm:border-l sm:border-rule sm:px-4">
            <span aria-hidden className="inline-block size-2 bg-ink" />
            {th.topbar.teacherWatching(watchedBy)}
          </span>
        )}
        <span className="hidden items-center gap-4 border-l border-rule px-4 text-sm sm:ml-auto sm:flex">
          {user}
          <LogoutButton />
        </span>
      </div>
    </header>
  );
}
