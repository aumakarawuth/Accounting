'use client';

import { useState } from 'react';
import type { AdminClassroom, Staff } from '@/lib/api';
import { PasswordSlips, type Slip } from '../PasswordSlips';
import { AdminClassrooms } from './AdminClassrooms';
import { AdminStaff } from './AdminStaff';

// ใบรหัสผ่านจากการสร้างบัญชี/รีเซ็ต/นำเข้า รวมไว้ที่เดียวเพื่อพิมพ์ทีเดียว
export function AdminWorkspace({ staff, rooms }: { staff: Staff[]; rooms: AdminClassroom[] }) {
  const [slips, setSlips] = useState<Slip[]>([]);
  const add = (s: Slip[]) => setSlips((x) => [...x, ...s]);
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-8">
      <AdminStaff staff={staff} onIssued={add} />
      <AdminClassrooms rooms={rooms} teachers={staff.filter((s) => s.role === 'teacher' && s.active)} onIssued={add} />
      <PasswordSlips slips={slips} onClear={() => setSlips([])} />
    </div>
  );
}
