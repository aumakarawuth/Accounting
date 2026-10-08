import type { NextApiRequest, NextApiResponse } from 'next';

// Vercel (EMBED_API=1): API ทั้งหมดรันในเว็บตัวเดียวกันที่ /api/* (ดู apps/api/src/embedded.ts)
// เครื่องตัวเอง/self-host: next.config.ts ส่ง /api/* ไป API ที่แยกรันก่อนถึงไฟล์นี้ (beforeFiles rewrite)
export const config = { api: { bodyParser: false, externalResolver: true, responseLimit: false } };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (process.env.EMBED_API !== '1') {
    res.status(404).json({ code: 'not_found', message: 'ไม่พบ API' });
    return;
  }
  const { handle } = await import('@accounting/api/embedded');
  await handle(req, res);
}
