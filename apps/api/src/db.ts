import pg from 'pg';
import type { AuthUser } from './auth.js';

// ทุกคำขอผ่าน pooler แบบ transaction pooling: ตั้งค่าตัวตนด้วย set_config(..., true)
// ซึ่งหมดอายุพร้อมทรานแซกชัน จึงไม่รั่วข้ามคำขอบน connection เดียวกัน
export function createPool(connectionString: string, max = 10, log: (msg: string) => void = (m) => console.error(m)) {
  const pool = new pg.Pool({ ...pgConfig(connectionString), max });
  // การเชื่อมต่อที่ว่างอยู่ถูกตัด (DB รีสตาร์ต, pooler ปิด idle): pool ทิ้งตัวที่เสียเอง ถ้าไม่มีตัวรับนี้ Node ล่มทั้งโปรเซส
  pool.on('error', (err) => log(`db pool: ${err.message}`));
  return pool;
}

// ฐานข้อมูลที่ใช้ CA ของผู้ให้บริการเอง (เช่น Supabase): ใส่ PEM ใน DATABASE_CA_CERT แล้วตรวจใบรับรองเต็มรูปแบบ
// ห้ามใส่ sslmode ใน URL พร้อมกัน เพราะค่าใน URL ทับค่านี้
export function pgConfig(connectionString: string): pg.ClientConfig {
  const ca = process.env.DATABASE_CA_CERT?.replace(/\\n/g, '\n').trim();
  return ca ? { connectionString, ssl: { ca, rejectUnauthorized: true } } : { connectionString };
}

export async function withUser<T>(
  pool: pg.Pool,
  user: AuthUser,
  fn: (c: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query(
      `select set_config('app.user_id', $1, true), set_config('app.client_info', $2, true)`,
      [user.id, user.clientInfo],
    );
    const result = await fn(c);
    await c.query('commit');
    return result;
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}
