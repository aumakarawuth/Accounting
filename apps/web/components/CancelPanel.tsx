'use client';

import { useState } from 'react';
import { Button } from '@/components/Button';
import { ConfirmPanel, PlainInput, useAction } from '@/components/ConfirmPanel';
import { th } from '@/i18n/th';

// ยกเลิกเอกสารที่ไม่ลงบัญชี (ใบเสนอราคา ใบสั่งขาย ใบวางบิล): ต้องระบุเหตุผล ตรวจกติกาที่ DB
export function CancelPanel({ path, title, explain }: { path: string; title: string; explain: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const action = useAction();
  if (!open) return <Button type="button" variant="secondary" onClick={() => setOpen(true)} className="self-start max-sm:w-full">{title}</Button>;
  return (
    <ConfirmPanel title={title} explain={explain} ready={reason.trim().length > 0} busy={action.busy} error={action.error}
      confirm={th.orders.cancelConfirm} onConfirm={async () => { if (await action.run(path, { reason })) setOpen(false); }} onCancel={() => setOpen(false)}>
      <PlainInput label={th.orders.cancelReason} value={reason} onChange={setReason} maxLength={300} />
    </ConfirmPanel>
  );
}
