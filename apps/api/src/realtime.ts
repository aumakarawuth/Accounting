import pg from 'pg';
import { pgConfig } from './db.js';

export type RealtimeEvent = { ch: string; k: string; [key: string]: unknown };

/**
 * ช่องทาง realtime: ทั้งระบบใช้ interface เดียวนี้ (PLAN.md ข้อ 3.4)
 * ตอนนี้: Postgres LISTEN/NOTIFY; ตอน Supabase ใช้ Broadcast, self-host ใช้ Redis pub/sub โดยไม่แตะ route
 */
export interface RealtimeBus {
  subscribe(channel: string, fn: (e: RealtimeEvent) => void): () => void;
  close(): Promise<void>;
  /** รอให้พร้อมรับ event (LISTEN ต่อแล้ว) ก่อนบอกผู้ฟังว่า "ok" — ไม่ throw */
  ready?(): Promise<void>;
}

/** LISTEN ต้องใช้การเชื่อมต่อตรง (session) ไม่ผ่าน pooler แบบ transaction pooling */
export function pgListenBus(connectionString: string, log: (msg: string) => void = () => {}): RealtimeBus {
  const subs = new Map<string, Set<(e: RealtimeEvent) => void>>();
  let client: pg.Client | null = null;
  let closed = false;
  let delay = 1000;

  async function connect() {
    const c = new pg.Client(pgConfig(connectionString));
    c.on('notification', (msg) => {
      if (!msg.payload) return;
      let e: RealtimeEvent;
      try { e = JSON.parse(msg.payload); } catch { return; }
      for (const fn of subs.get(e.ch) ?? []) fn(e);
    });
    c.on('error', (err) => {
      log(`realtime: ${err.message}`);
      client = null;
      retry();
    });
    await c.connect();
    await c.query('listen acc_events');
    client = c;
    delay = 1000;
  }
  // ต่อไม่ได้ (รวมครั้งแรก) ลองใหม่แบบถอยเวลา ไม่ทำให้ทั้ง process ล้ม
  function retry() {
    if (!closed && subs.size > 0) setTimeout(() => void connect().catch((e) => { log(`realtime: ${e.message}`); retry(); }), delay = Math.min(delay * 2, 30_000));
  }
  // ต่อเมื่อมีผู้ฟังจริงเท่านั้น และปล่อยการเชื่อมต่อเมื่อไม่มีผู้ฟัง 60 วินาที:
  // บน Vercel ทุก instance เคยถือ LISTEN ไว้ตั้งแต่เริ่ม แม้ใช้แค่เปิดหน้า ทำให้ session pooler (15 ช่อง) เต็มเมื่อคนเยอะ (EMAXCONNSESSION)
  let ready: Promise<void> = Promise.resolve();
  let idle: ReturnType<typeof setTimeout> | null = null;
  function ensure() {
    if (idle) { clearTimeout(idle); idle = null; }
    if (client || closed || connecting) return;
    connecting = true;
    ready = connect().catch((e) => { log(`realtime: ${e.message}`); retry(); }).finally(() => { connecting = false; });
  }
  let connecting = false;
  function release() {
    if (subs.size > 0 || idle) return;
    idle = setTimeout(() => {
      idle = null;
      if (subs.size === 0 && client) { const c = client; client = null; void c.end().catch(() => {}); }
    }, 60_000);
    (idle as { unref?: () => void }).unref?.();
  }

  return {
    subscribe(channel, fn) {
      let set = subs.get(channel);
      if (!set) subs.set(channel, (set = new Set()));
      set.add(fn);
      ensure();
      return () => {
        set!.delete(fn);
        if (set!.size === 0) subs.delete(channel);
        release();
      };
    },
    ready() {
      return Promise.race([ready.catch(() => {}), new Promise<void>((r) => setTimeout(r, 5000).unref?.())]);
    },
    async close() {
      closed = true;
      if (idle) clearTimeout(idle);
      await ready.catch(() => {});
      await client?.end().catch(() => {});
    },
  };
}
