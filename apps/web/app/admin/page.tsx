import { AdminWorkspace } from '@/components/admin/AdminWorkspace';
import { serverApi } from '@/lib/server-api';
import type { AdminClassroom, Staff } from '@/lib/api';

export default async function AdminHome() {
  const [staff, rooms] = await Promise.all([
    serverApi<Staff[]>('/admin/staff'),
    serverApi<AdminClassroom[]>('/admin/classrooms'),
  ]);
  return <AdminWorkspace staff={staff} rooms={rooms} />;
}
