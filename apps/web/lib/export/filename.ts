/** ชื่อไฟล์ไทยส่งแบบ RFC 5987 (filename*) + ชื่อสำรองตัวอักษรอังกฤษ: ชื่อบริษัทที่ผู้ใช้ตั้งเอง (มี " หรือขึ้นบรรทัด) ฉีด header ไม่ได้ */
export function contentDisposition(name: string, ascii: string, ext: 'pdf' | 'xlsx') {
  const fallback = ascii.replace(/[^A-Za-z0-9._-]/g, '-');
  const encoded = encodeURIComponent(`${name}.${ext}`).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}.${ext}"; filename*=UTF-8''${encoded}`;
}
