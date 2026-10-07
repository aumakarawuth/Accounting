export type AuthConfig = {
  cookieName: string;
  cookieSecure: boolean;
  idleSeconds: number; // ไม่ใช้งานเกินนี้ต้องเข้าใหม่ (นักเรียน 8 ชม.)
  maxAgeSeconds: number; // อายุสูงสุดของเซสชัน
  maxFailures: number; // ผิดติดกันกี่ครั้งถึงล็อก
  lockMinutes: number;
  ipMaxFailures: number; // ต่อ IP ในช่วงเดียวกัน (สูง เพราะทั้งโรงเรียนอาจออกเน็ต IP เดียว)
  loginPerIpPerMinute: number;
  requestsPerIpPerMinute: number; // กันน้ำท่วมเท่านั้น: ทั้งโรงเรียนอาจออกเน็ต IP เดียว (NAT)
  requestsPerUserPerMinute: number; // ตัวจำกัดหลัก
  allowedOrigins: string[] | false; // false = ไม่ตรวจ Origin (เฉพาะ adapter ที่ไม่ใช้ cookie)
};

export function authConfigFromEnv(env = process.env): AuthConfig {
  const secure = env.COOKIE_SECURE !== 'false';
  return {
    cookieName: secure ? '__Host-sid' : 'sid',
    cookieSecure: secure,
    idleSeconds: Number(env.SESSION_IDLE_SECONDS ?? 8 * 3600),
    maxAgeSeconds: Number(env.SESSION_MAX_AGE_SECONDS ?? 7 * 24 * 3600),
    maxFailures: 5,
    lockMinutes: 15,
    ipMaxFailures: Number(env.LOGIN_IP_MAX_FAILURES ?? 300),
    // k6 500 คนจาก IP เดียว (docs/load-test.md): ค่าเดิม 300/6000 ทำให้คำขอล้ม 78% ตอนเริ่มคาบ
    // การเดารหัสยังถูกจำกัดด้วยล็อกต่อบัญชี (5 ครั้ง) และเพดานล็อกอินผิดต่อ IP (ipMaxFailures)
    loginPerIpPerMinute: Number(env.LOGIN_PER_IP_PER_MINUTE ?? 1200),
    requestsPerIpPerMinute: Number(env.REQUESTS_PER_IP_PER_MINUTE ?? 60000),
    requestsPerUserPerMinute: Number(env.REQUESTS_PER_USER_PER_MINUTE ?? 600),
    allowedOrigins: (env.WEB_ORIGIN ?? 'http://localhost:3000').split(',').map((s) => s.trim()),
  };
}
