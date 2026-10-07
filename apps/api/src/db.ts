import pg from 'pg';
import type { AuthUser } from './auth.js';

// ทุกคำขอผ่าน pooler แบบ transaction pooling: ตั้งค่าตัวตนด้วย set_config(..., true)
// ซึ่งหมดอายุพร้อมทรานแซกชัน จึงไม่รั่วข้ามคำขอบน connection เดียวกัน
export function createPool(connectionString: string, max = 10) {
  return new pg.Pool({ connectionString, max });
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
