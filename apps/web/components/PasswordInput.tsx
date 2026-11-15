'use client';

import { useState } from 'react';
import { th } from '@/i18n/th';

// ช่องรหัสผ่านพร้อมปุ่มแสดง/ซ่อน: บนมือถือพิมพ์ผิดตัวเดียวมองไม่เห็น ทำให้คิดว่าลืมรหัส
export function PasswordInput({ value, onChange, autoComplete, className, name, required }: {
  value: string; onChange: (v: string) => void; autoComplete: 'current-password' | 'new-password';
  className: string; name?: string; required?: boolean;
}) {
  const [shown, setShown] = useState(false);
  return (
    <span className="relative flex">
      <input
        name={name}
        type={shown ? 'text' : 'password'}
        className={`${className} pr-[72px]`}
        autoComplete={autoComplete}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        required={required}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <button
        type="button"
        aria-pressed={shown}
        aria-label={shown ? th.password.hideLabel : th.password.showLabel}
        className="absolute inset-y-0 right-0 min-w-[64px] px-3 text-sm text-ink2 underline"
        onClick={() => setShown((s) => !s)}
      >
        {shown ? th.password.hide : th.password.show}
      </button>
    </span>
  );
}
