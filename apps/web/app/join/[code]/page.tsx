import { JoinPage } from '@/components/JoinPage';

export const dynamic = 'force-dynamic';

// ปลายทางของ QR ที่ครูฉายขึ้นจอ
export default async function JoinWithCode({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  return <JoinPage code={decodeURIComponent(code).slice(0, 12)} />;
}
