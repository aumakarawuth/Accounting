import { AdminWorkspace } from '@/components/admin/AdminWorkspace';
import { serverApi } from '@/lib/server-api';
import type { AdminClassroom, Staff } from '@/lib/api';

export default async function AdminHome() {
  const [staff, rooms, settings] = await Promise.all([
    serverApi<Staff[]>('/admin/staff'),
    serverApi<AdminClassroom[]>('/admin/classrooms'),
    serverApi<{ worksheetFormats: number[] }>('/admin/settings'),
  ]);
  return <AdminWorkspace staff={staff} rooms={rooms} worksheetFormats={settings.worksheetFormats} />;
}
