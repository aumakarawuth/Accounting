'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { postJson, type ApiError } from '@/lib/api';
import { th } from '@/i18n/th';

type Kind = 'student' | 'staff';

function message(kind: Kind, e: ApiError): string {
  switch (e.code) {
    case 'bad_credentials':
      return (kind === 'student' ? th.login.wrongStudent : th.login.wrongStaff)(Number(e.left), Number(e.lockMinutes));
    case 'locked':
      return (kind === 'student' ? th.login.locked : th.login.lockedStaff)(Number(e.minutes));
    case 'rate_limited':
    case 'ip_limited':
      return th.error.rateLimited(Number(e.retryAfter ?? 60));
    case 'invalid':
      return kind === 'student' ? th.login.invalidStudent : th.login.invalidEmail;
    default:
      return th.error.server(e.ref ?? '-');
  }
}

/** next: หน้าที่จะกลับไปหลังเข้าสู่ระบบ (ต้องเป็น path ภายใน เช่น /join/ABC234) */
export function LoginForm({ kind, next }: { kind: Kind; next?: string }) {
  const router = useRouter();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = 'h-12 w-full rounded-doc border bg-paper px-3 text-base max-sm:h-13';

  return (
    <form
      className="flex w-full flex-col gap-4 px-5 py-6 sm:w-[420px] sm:border sm:border-rule-strong sm:bg-paper sm:px-8 sm:py-7"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          const r = await postJson<{ mustChange: boolean }>('/auth/login', { kind, identifier, password });
          router.replace(r.mustChange ? '/change-password' : next?.startsWith('/') && !next.startsWith('//') ? next : '/');
          router.refresh();
        } catch (err) {
          setError(message(kind, err as ApiError));
          setBusy(false);
        }
      }}
    >
      <div className="border-b-2 border-ink pb-2.5">
        <h1 className="font-doc text-[22px] font-bold">{kind === 'student' ? th.login.title : th.login.staffTitle}</h1>
        <p className="text-sm text-ink2">{kind === 'student' ? th.login.studentHint : th.login.staffHint}</p>
      </div>
      <label className="flex flex-col gap-1 text-sm">
        {kind === 'student' ? th.login.studentCode : th.login.email}
        <input
          name="identifier"
          className={`${input} ${kind === 'student' ? 'font-num' : ''} ${error ? 'border-red' : 'border-rule-input'}`}
          inputMode={kind === 'student' ? 'numeric' : 'email'}
          type={kind === 'student' ? 'text' : 'email'}
          autoComplete="username"
          autoCapitalize="none"
          required
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        {th.login.password}
        <input
          name="password"
          type="password"
          className={`${input} ${error ? 'border-red' : 'border-rule-input'}`}
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>
      {error && <p role="alert" className="neg text-sm">{error}</p>}
      <button type="submit" disabled={busy} className="min-h-12 rounded-doc bg-ink px-5 font-medium text-paper disabled:bg-disabled disabled:text-ink2 max-sm:min-h-13">
        {busy ? th.login.signingIn : th.login.submit}
      </button>
      <p className="border-t border-rule pt-3 text-sm text-ink2">{kind === 'student' ? th.login.forgotStudent : th.login.forgotStaff}</p>
      <a href={kind === 'student' ? '/login/staff' : '/login'} className="flex min-h-11 items-center text-sm underline">
        {kind === 'student' ? th.login.staffLink : th.login.studentLink}
      </a>
    </form>
  );
}
