import pg from 'pg';

export type RealtimeEvent = { ch: string; k: string; [key: string]: unknown };

/**
 * ช่องทาง realtime: ทั้งระบบใช้ interface เดียวนี้ (PLAN.md ข้อ 3.4)
 * ตอนนี้: Postgres LISTEN/NOTIFY; ตอน Supabase ใช้ Broadcast, self-host ใช้ Redis pub/sub โดยไม่แตะ route
 */
export interface RealtimeBus {
  subscribe(channel: string, fn: (e: RealtimeEvent) => void): () => void;
  close(): Promise<void>;
}

/** LISTEN ต้องใช้การเชื่อมต่อตรง (session) ไม่ผ่าน pooler แบบ transaction pooling */
export function pgListenBus(connectionString: string, log: (msg: string) => void = () => {}): RealtimeBus {
  const subs = new Map<string, Set<(e: RealtimeEvent) => void>>();
  let client: pg.Client | null = null;
  let closed = false;
  let delay = 1000;

  async function connect() {
    const c = new pg.Client({ connectionString });
    c.on('notification', (msg) => {
      if (!msg.payload) return;
      let e: RealtimeEvent;
      try { e = JSON.parse(msg.payload); } catch { return; }
      for (const fn of subs.get(e.ch) ?? []) fn(e);
    });
    c.on('error', (err) => {
      log(`realtime: ${err.message}`);
      client = null;
      if (!closed) setTimeout(() => void connect().catch(() => {}), delay = Math.min(delay * 2, 30_000));
    });
    await c.connect();
    await c.query('listen acc_events');
    client = c;
    delay = 1000;
  }
  const ready = connect();

  return {
    subscribe(channel, fn) {
      void ready;
      let set = subs.get(channel);
      if (!set) subs.set(channel, (set = new Set()));
      set.add(fn);
      return () => {
        set!.delete(fn);
        if (set!.size === 0) subs.delete(channel);
      };
    },
    async close() {
      closed = true;
      await ready.catch(() => {});
      await client?.end().catch(() => {});
    },
  };
}
