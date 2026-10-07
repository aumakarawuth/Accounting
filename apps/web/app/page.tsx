import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

// เฟส 1: เลือกบริษัทจากเซสชันจริง; ตอนนี้ช่วงพัฒนาใช้บริษัทตัวอย่างจาก db/dev
export default function Root() {
  const company = process.env.DEV_COMPANY_ID;
  redirect(company ? `/c/${company}` : '/login');
}
