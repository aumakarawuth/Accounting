// จุดเดียวที่หน้าจอฟัง realtime (PLAN.md ข้อ 3.4): subscribe(channel)
// event มีแค่สัญญาณ ("มีอะไรเปลี่ยน") ผู้ฟังต้องดึงข้อมูลจริงเองผ่าน API (RLS)
// ทาง: WebSocket /api/ws (self-host: การเชื่อมต่อเดียวทุกช่อง เปิดด้วย NEXT_PUBLIC_REALTIME=ws ตอน build)
//      ไม่ได้ตั้ง (Vercel) หรือต่อไม่ได้ตั้งแต่ครั้งแรก (เครือข่ายที่ปิด WebSocket) = SSE /api/realtime ต่อช่อง
export type RealtimeEvent = { ch: string; k: string; [key: string]: unknown };
type Listener = (e: RealtimeEvent) => void;

const listeners = new Map<string, Set<Listener>>();
const sse = new Map<string, EventSource>();
let mode: 'ws' | 'sse' | null = process.env.NEXT_PUBLIC_REALTIME === 'ws' ? null : 'sse'; // null = ยังไม่รู้ (ลอง WebSocket ก่อน)
let ws: WebSocket | null = null;
let opened = false; // socket นี้เคยเปิดสำเร็จ (ใช้แยก "ไม่มี WebSocket" ออกจาก "หลุดกลางทาง")
let failures = 0;
let retry: ReturnType<typeof setTimeout> | null = null;
const MEMO = 'realtime-transport';

function emit(e: RealtimeEvent) {
  for (const fn of listeners.get(e.ch) ?? []) fn(e);
}

function openSse(ch: string) {
  if (sse.has(ch)) return;
  const es = new EventSource(`/api/realtime?channel=${encodeURIComponent(ch)}`);
  es.onmessage = (m) => {
    try { emit(JSON.parse(m.data)); } catch { /* ข้าม event ที่อ่านไม่ได้ */ }
  };
  sse.set(ch, es);
}

function switchToSse() {
  mode = 'sse';
  try { sessionStorage.setItem(MEMO, 'sse'); } catch { /* โหมดส่วนตัว: ไม่จำก็ได้ */ }
  ws?.close();
  ws = null;
  for (const ch of listeners.keys()) openSse(ch);
}

function send(m: { op: 'sub' | 'unsub'; ch: string }) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
}

function connect() {
  retry = null;
  if (listeners.size === 0 || mode === 'sse') return;
  opened = false;
  const s = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws`);
  ws = s;
  s.onopen = () => {
    opened = true;
    failures = 0;
    mode = 'ws';
    for (const ch of listeners.keys()) send({ op: 'sub', ch });
  };
  s.onmessage = (m) => {
    let e: RealtimeEvent & { op?: string };
    try { e = JSON.parse(String(m.data)); } catch { return; }
    if (e.op) return; // ok/err ของการสมัครช่อง: หน้าจอยังดึงข้อมูลเป็นรอบอยู่แล้ว ไม่ต้องทำอะไร
    emit(e);
  };
  s.onclose = (ev) => {
    if (ws !== s) return;
    ws = null;
    // ยังไม่เคยเปิดได้ในหน้านี้ (ไม่มี /api/ws หรือถูกกั้น) = ใช้ SSE ทันที ไม่ให้พลาด event ระหว่างรอ
    // หลุดหลังเคยเปิดได้ = ต่อ WebSocket ใหม่แบบถอยเวลา · 4401 = เซสชันหมด (หน้าจอพาไปล็อกอินเอง)
    if (!opened && mode === null) { switchToSse(); return; }
    if (!opened && ++failures >= 3) { switchToSse(); return; } // เคยใช้ได้แต่ต่อใหม่ไม่ได้ 3 รอบติด
    if (ev.code === 4401 || listeners.size === 0) return;
    retry = setTimeout(connect, Math.min(1000 * 2 ** failures, 15_000) + Math.random() * 1000);
  };
}

export function subscribe(channel: string, onEvent: Listener): () => void {
  if (mode === null) {
    try { if (sessionStorage.getItem(MEMO) === 'sse') mode = 'sse'; } catch { /* ไม่มี storage */ }
  }
  let set = listeners.get(channel);
  const first = !set;
  if (!set) listeners.set(channel, (set = new Set()));
  set.add(onEvent);
  if (first) {
    if (mode === 'sse') openSse(channel);
    else if (ws) send({ op: 'sub', ch: channel });
    else if (!retry) connect();
  }
  return () => {
    set.delete(onEvent);
    if (set.size > 0) return;
    listeners.delete(channel);
    sse.get(channel)?.close();
    sse.delete(channel);
    send({ op: 'unsub', ch: channel });
    if (listeners.size === 0 && ws) { const s = ws; ws = null; s.close(); }
  };
}
