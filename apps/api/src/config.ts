export type AuthConfig = {
  cookieName: string;
  cookieSecure: boolean;
  idleSeconds: number; // ไม่ใช้งานเกินนี้ต้องเข้าใหม่ (นักเรียน 8 ชม.)
  maxAgeSeconds: number; // อายุสูงสุดของเซสชัน
  maxFailures: number; // ผิดติดกันกี่ครั้งถึงล็อก
  lockMinutes: number;
  ipMaxFailures: number; // ต่อ IP ในช่วงเดียวกัน (สูง เพราะทั้งโรงเรียนอาจออกเน็ต IP เดียว)
  loginPerIpPerMinute: number;
  requestsPerIpPerMinute: number;
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
    loginPerIpPerMinute: Number(env.LOGIN_PER_IP_PER_MINUTE ?? 300),
    requestsPerIpPerMinute: Number(env.REQUESTS_PER_IP_PER_MINUTE ?? 6000),
    allowedOrigins: (env.WEB_ORIGIN ?? 'http://localhost:3000').split(',').map((s) => s.trim()),
  };
}
