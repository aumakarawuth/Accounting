// ตัวจำกัดอัตราแบบหน้าต่างคงที่ ใช้ interface เดียว: ตอนนี้ในหน่วยความจำ, self-host/หลายเครื่องเปลี่ยนเป็น Redis
export interface RateLimiter {
  /** คืนจำนวนวินาทีที่ต้องรอ ถ้าเกินโควตา; 0 = ผ่าน */
  hit(key: string, limit: number, windowSec: number): Promise<number>;
}

export function memoryLimiter(now = () => Date.now()): RateLimiter {
  const buckets = new Map<string, { start: number; count: number }>();
  return {
    async hit(key, limit, windowSec) {
      const t = now();
      const b = buckets.get(key);
      if (!b || t - b.start >= windowSec * 1000) {
        buckets.set(key, { start: t, count: 1 });
        if (buckets.size > 100_000) buckets.clear(); // กันหน่วยความจำโต
        return 0;
      }
      b.count++;
      return b.count > limit ? Math.ceil((b.start + windowSec * 1000 - t) / 1000) : 0;
    },
  };
}
