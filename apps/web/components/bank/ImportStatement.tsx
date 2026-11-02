'use client';
import { useState } from 'react';
import { postJson } from '@/lib/api';

export function ImportStatement({ companyId }: { companyId: string }) {
  const [message, setMessage] = useState('');
  async function submit(form: FormData) {
    try {
      const lines = String(form.get('lines')).trim().split('\n').filter(Boolean).map((row) => { const [date, description, amount, reference = ''] = row.split(','); return { date: date.trim(), description: description.trim(), amount: amount.trim(), reference: reference.trim() }; });
      await postJson(`/companies/${companyId}/bank-reconciliation/statements`, { accountCode: form.get('accountCode'), periodStart: form.get('periodStart'), periodEnd: form.get('periodEnd'), openingBalance: form.get('openingBalance'), closingBalance: form.get('closingBalance'), lines });
      location.reload();
    } catch { setMessage('นำเข้ารายการไม่สำเร็จ โปรดตรวจรูปแบบข้อมูล'); }
  }
  return <form action={submit} className="flex flex-col gap-2 border border-rule p-3 text-sm"><b>นำเข้า statement</b><input name="accountCode" placeholder="บัญชีธนาคาร เช่น 1120" required /><input name="periodStart" type="date" required /><input name="periodEnd" type="date" required /><input name="openingBalance" placeholder="ยอดต้นงวด" required /><input name="closingBalance" placeholder="ยอดปลายงวด" required /><textarea name="lines" required rows={4} placeholder="วันที่,รายละเอียด,จำนวนเงิน,เลขอ้างอิง&#10;2026-10-01,รับโอน,1000.00,TRX-1" /><button className="border border-ink px-3 py-2">นำเข้า</button>{message && <p>{message}</p>}</form>;
}
