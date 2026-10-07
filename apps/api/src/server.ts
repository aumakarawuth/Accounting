import { buildApp } from './app.js';
import { devAuth } from './auth.js';
import { createPool } from './db.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('ต้องตั้ง DATABASE_URL (บทบาท app_rw ผ่าน pooler)');

const adapter = process.env.AUTH_ADAPTER ?? 'dev';
if (adapter !== 'dev') throw new Error(`ยังไม่มี AUTH_ADAPTER=${adapter} (มาในเฟส 1)`);
if (process.env.NODE_ENV === 'production') throw new Error('AUTH_ADAPTER=dev ห้ามใช้ใน production');

const app = buildApp({ pool: createPool(url), auth: devAuth(process.env.DEV_USER_ID), logger: true });
await app.listen({ host: process.env.HOST ?? '127.0.0.1', port: Number(process.env.PORT ?? 4000) });
