'use client';

import { useId, type ReactNode } from 'react';

// ช่องกรอกของฟอร์มข้อมูลหลัก: ป้ายอยู่บน เส้นใต้ ข้อความเตือนใต้ช่อง
// คำอธิบาย/คำเตือนอยู่นอก <label> แล้วผูกด้วย aria-describedby ชื่อช่องที่โปรแกรมอ่านจอได้ยินจึงสั้นตามป้าย
const inputCls = 'h-11 w-full border-b border-rule-input bg-transparent px-0.5 text-base';

function Note({ id, text, error }: { id: string; text?: string | null; error?: boolean }) {
  return text ? <span id={id} className={`pt-1 text-[13px] ${error ? 'neg' : 'text-ink2'}`}>{text}</span> : null;
}

export function TextField({
  label, value, onChange, hint, error, inputMode, mono, maxLength, readOnly, multiline,
}: {
  label: string; value: string; onChange: (v: string) => void; hint?: string; error?: string | null;
  inputMode?: 'text' | 'numeric' | 'decimal'; mono?: boolean; maxLength?: number; readOnly?: boolean; multiline?: boolean;
}) {
  const id = useId();
  const note = error || hint;
  const props = {
    id, value, maxLength, readOnly, 'aria-invalid': Boolean(error), 'aria-describedby': note ? `${id}-n` : undefined,
    onChange: (e: { target: { value: string } }) => onChange(e.target.value),
  };
  return (
    <div className="flex min-w-0 flex-col text-sm">
      <label htmlFor={id}>{label}</label>
      {multiline
        ? <textarea {...props} rows={3} className={`${inputCls} h-auto min-h-11 resize-y py-2`} />
        : <input {...props} inputMode={inputMode} className={`${inputCls} ${mono ? 'font-num' : ''}`} />}
      <Note id={`${id}-n`} text={note} error={Boolean(error)} />
    </div>
  );
}

export function CheckField({ label, checked, onChange, note }: { label: string; checked: boolean; onChange: (v: boolean) => void; note?: string }) {
  const id = useId();
  return (
    <div className="flex flex-col py-1">
      <label className="flex min-h-11 items-center gap-3 text-[15px]">
        <input type="checkbox" className="size-5 shrink-0 text-base accent-ink" checked={checked}
          aria-describedby={note ? `${id}-n` : undefined} onChange={(e) => onChange(e.target.checked)} />
        {label}
      </label>
      {note && <span id={`${id}-n`} className="pl-8 text-[13px] text-ink2">{note}</span>}
    </div>
  );
}

export function SelectField({ label, value, onChange, children }: { label: string; value: string; onChange: (v: string) => void; children: ReactNode }) {
  const id = useId();
  return (
    <div className="flex min-w-0 flex-col text-sm">
      <label htmlFor={id}>{label}</label>
      <select id={id} className="h-11 w-full border-b border-rule-input bg-transparent text-base" value={value} onChange={(e) => onChange(e.target.value)}>
        {children}
      </select>
    </div>
  );
}
