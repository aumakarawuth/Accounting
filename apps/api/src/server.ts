import { buildApp } from './app.js';
import { devAuth, sessionAuth } from './auth.js';
import { authConfigFromEnv } from './config.js';
import { createPool } from './db.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('ต้องตั้ง DATABASE_URL (บทบาท app_rw ผ่าน pooler)');

const cfg = authConfigFromEnv();
const pool = createPool(url);
const adapter = process.env.AUTH_ADAPTER ?? 'session';
if (adapter === 'dev' && process.env.NODE_ENV === 'production') throw new Error('AUTH_ADAPTER=dev ห้ามใช้ใน production');
if (adapter !== 'dev' && adapter !== 'session') throw new Error(`ไม่รู้จัก AUTH_ADAPTER=${adapter}`);
const auth = adapter === 'dev' ? devAuth(process.env.DEV_USER_ID) : sessionAuth(pool, cfg.cookieName);

const app = buildApp({ pool, auth, cfg, logger: true, trustProxy: process.env.TRUST_PROXY ?? 'loopback' });
await app.listen({ host: process.env.HOST ?? '127.0.0.1', port: Number(process.env.PORT ?? 4000) });
