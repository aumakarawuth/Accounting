// จุดเดียวที่หน้าจอฟัง realtime (PLAN.md ข้อ 3.4): subscribe(channel)
// ตอนนี้ใช้ Server-Sent Events จาก API; เปลี่ยนเป็น Supabase Broadcast/WebSocket ได้ที่ไฟล์นี้ที่เดียว
// event มีแค่สัญญาณ ("มีอะไรเปลี่ยน") ผู้ฟังต้องดึงข้อมูลจริงเองผ่าน API (RLS)
export type RealtimeEvent = { ch: string; k: string; [key: string]: unknown };

export function subscribe(channel: string, onEvent: (e: RealtimeEvent) => void): () => void {
  const es = new EventSource(`/api/realtime?channel=${encodeURIComponent(channel)}`);
  es.onmessage = (m) => {
    try { onEvent(JSON.parse(m.data)); } catch { /* ข้าม event ที่อ่านไม่ได้ */ }
  };
  return () => es.close();
}
