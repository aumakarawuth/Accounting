import websocketPlugin from '@fastify/websocket';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { AuthAdapter, AuthUser } from './auth.js';
import type { AuthConfig } from './config.js';
import { HttpError, toHttp } from './errors.js';
import { requireUser } from './guard.js';
import type { RealtimeBus } from './realtime.js';
import { authorizeChannel, Channel } from './routes/live.js';

/**
 * ดูสดผ่าน WebSocket (self-host, PLAN.md ข้อ 3: Realtime ฝั่ง self-host) การเชื่อมต่อเดียวฟังได้หลายช่อง
 * โปรโตคอล (JSON ต่อข้อความ):
 *   เบราว์เซอร์ → { op: 'sub' | 'unsub', ch: 'company:<id>' | 'student:<id>' }
 *   API → { op: 'ok', ch } · { op: 'err', ch, code } · event { ch, k, ... } (สัญญาณเท่านั้น ข้อมูลจริงดึงผ่าน API/RLS)
 * สิทธิ์ต่อช่องใช้ authorizeChannel ตัวเดียวกับ SSE (/realtime) ยังคงเปิด SSE ไว้เป็นทางสำรอง (Vercel, เครือข่ายที่ปิด WebSocket)
 *
 * ความปลอดภัย: Origin ต้องเป็นของเว็บเรา (กัน Cross-Site WebSocket Hijacking: cookie ติดไปเองเหมือน CSRF)
 * ต้องล็อกอินตอนเปิด และตรวจเซสชันซ้ำทุก SESSION_CHECK_MS (ออกจากระบบ/ถูกปิดบัญชี = ตัดภายในนาที)
 */
export const MAX_CHANNELS = 20;
const PING_MS = 25_000;
const SESSION_CHECK_MS = 60_000;

export async function registerWebSocket(app: FastifyInstance, ctx: { pool: pg.Pool; auth: AuthAdapter; cfg: AuthConfig; bus: RealtimeBus },
  timing: { pingMs?: number; sessionCheckMs?: number } = {}) {
  const { pool, auth, cfg, bus } = ctx;
  await app.register(websocketPlugin, { options: { maxPayload: 1024 } });

  app.get('/ws', {
    websocket: true,
    // ก่อน upgrade: ตอบเป็น HTTP error ได้ตามปกติ (ยังไม่เปิด socket)
    preValidation: async (req) => {
      if (cfg.allowedOrigins !== false) {
        const origin = req.headers.origin;
        if (!origin || !cfg.allowedOrigins.includes(origin)) throw new HttpError(403, 'csrf', 'คำขอนี้ไม่ได้มาจากหน้าเว็บของระบบ');
      }
      (req as { wsUser?: AuthUser }).wsUser = await requireUser(auth, req);
    },
  }, (socket, req) => {
    const user = (req as { wsUser?: AuthUser }).wsUser!;
    const subs = new Map<string, () => void>();
    const send = (m: unknown) => { if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(m)); };
    let alive = true;
    let queue = Promise.resolve(); // คำสั่ง sub/unsub ทำตามลำดับที่ส่งมา

    socket.on('pong', () => { alive = true; });
    const ping = setInterval(() => {
      if (!alive) { socket.terminate(); return; }
      alive = false;
      socket.ping();
    }, timing.pingMs ?? PING_MS);
    const recheck = setInterval(() => {
      void auth.authenticate(req).then((u) => {
        if (!u || u.id !== user.id || u.mustChange) socket.close(4401, 'session');
      }).catch(() => { /* DB สะดุดชั่วคราว: ไม่ตัดผู้ใช้ รอบหน้าตรวจใหม่ */ });
    }, timing.sessionCheckMs ?? SESSION_CHECK_MS);

    socket.on('message', (raw) => {
      let msg: { op?: unknown; ch?: unknown };
      try { msg = JSON.parse(String(raw)); } catch { socket.close(4400, 'bad message'); return; }
      const ch = Channel.safeParse(msg.ch);
      if (!ch.success || (msg.op !== 'sub' && msg.op !== 'unsub')) { send({ op: 'err', ch: msg.ch ?? null, code: 'invalid' }); return; }
      const channel = ch.data;
      const op = msg.op;
      queue = queue.then(async () => {
        if (op === 'unsub') { subs.get(channel)?.(); subs.delete(channel); return; }
        if (subs.has(channel)) { send({ op: 'ok', ch: channel }); return; }
        if (subs.size >= MAX_CHANNELS) { send({ op: 'err', ch: channel, code: 'too_many' }); return; }
        try {
          await authorizeChannel(pool, user, channel);
        } catch (e) {
          send({ op: 'err', ch: channel, code: toHttp(e).body.code });
          return;
        }
        if (socket.readyState !== socket.OPEN) return;
        subs.set(channel, bus.subscribe(channel, (e) => send(e)));
        send({ op: 'ok', ch: channel });
      });
    });

    socket.on('close', () => {
      clearInterval(ping);
      clearInterval(recheck);
      for (const unsub of subs.values()) unsub();
      subs.clear();
    });
  });
}
