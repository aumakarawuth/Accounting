'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { postJson, type ApiError } from '@/lib/api';
import { th } from '@/i18n/th';

type Check = 'pass' | 'fail' | 'notYet' | 'pending';

// เงื่อนไขแสดงเป็นคำ (ผ่าน/ไม่ผ่าน) ไม่ใช้สีอย่างเดียว; รายการรหัสยอดแย่ตรวจที่เซิร์ฟเวอร์
export function ChangePasswordForm({ mustChange, studentCode }: { mustChange: boolean; studentCode: string | null }) {
  const router = useRouter();
  const [current, setCurrent] = useState('');
  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [commonFor, setCommonFor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const len = [...pw].length;
  const lengthOk: Check = len >= 8 ? 'pass' : 'notYet';
  const codeOk: Check = !pw ? 'notYet' : studentCode && pw.toLowerCase().includes(studentCode.toLowerCase()) ? 'fail' : 'pass';
  const commonOk: Check = commonFor === pw && pw ? 'fail' : 'pending';
  const matches = confirm.length > 0 && confirm === pw;
  const canSubmit = !busy && lengthOk === 'pass' && codeOk === 'pass' && commonOk !== 'fail' && matches && (mustChange || current.length > 0);
  const input = 'h-12 w-full rounded-doc border border-rule-input bg-paper px-3 text-base max-sm:h-13';

  const row = (state: Check, text: string) => (
    <li className={`grid grid-cols-[96px_minmax(0,1fr)] gap-2 border-b border-rule-faint py-1.5 text-sm ${state === 'fail' ? 'neg' : ''}`}>
      <span className="font-semibold">{th.password.check[state]}</span>
      <span>{text}</span>
    </li>
  );

  return (
    <form
      className="flex w-full flex-col gap-4 px-5 py-6 sm:w-[480px] sm:border sm:border-rule-strong sm:bg-paper sm:px-8 sm:py-7"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await postJson('/auth/change-password', { newPassword: pw, ...(mustChange ? {} : { currentPassword: current }) });
          router.replace('/');
          router.refresh();
        } catch (err) {
          const x = err as ApiError;
          if (x.code === 'weak_password' && x.reason === 'common') setCommonFor(pw);
          else if (x.code === 'weak_password' && x.reason === 'same') setError(th.password.sameAsOld);
          else if (x.code === 'bad_current_password') setError(th.password.wrongCurrent);
          else if (x.code === 'unauthenticated') router.replace('/login');
          else setError(th.error.server(x.ref ?? '-'));
          setBusy(false);
        }
      }}
    >
      <div className="border-b-2 border-ink pb-2.5">
        <h1 className="font-doc text-[22px] font-bold">{mustChange ? th.password.title : th.password.changeTitle}</h1>
        {mustChange && <p className="text-sm text-ink2">{th.password.hint}</p>}
      </div>
      {!mustChange && (
        <label className="flex flex-col gap-1 text-sm">
          {th.password.current}
          <input type="password" autoComplete="current-password" className={input} value={current} onChange={(e) => setCurrent(e.target.value)} />
        </label>
      )}
      <label className="flex flex-col gap-1 text-sm">
        {th.password.newPassword}
        <input type="password" autoComplete="new-password" className={input} value={pw} onChange={(e) => setPw(e.target.value)} />
      </label>
      <ul aria-live="polite">
        {row(lengthOk, lengthOk === 'pass' ? th.password.rule.length : th.password.rule.lengthNow(len))}
        {studentCode && row(codeOk, th.password.rule.notStudentCode)}
        {row(commonOk, commonOk === 'fail' ? th.password.rule.isCommon : th.password.rule.notCommon)}
      </ul>
      <label className="flex flex-col gap-1 text-sm">
        {th.password.confirm}
        <input type="password" autoComplete="new-password" className={input} value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      </label>
      {confirm && <p className={`text-sm ${matches ? '' : 'neg'}`}>{matches ? th.password.match : th.password.mismatch}</p>}
      <p className="text-sm text-ink2">{th.password.advice}</p>
      {error && <p role="alert" className="neg text-sm">{error}</p>}
      <button type="submit" disabled={!canSubmit} className="min-h-12 rounded-doc bg-ink px-5 font-medium text-paper disabled:bg-disabled disabled:text-ink2 max-sm:min-h-13">
        {th.password.submit}
      </button>
    </form>
  );
}
