import { defineConfig, devices } from '@playwright/test';

// เทสต์หน้าจอจริง 3 ขนาด (PLAN.md ข้อ 8: มือถือ > iPad > คอม) ต้องมีเว็บ + API + ฐานข้อมูลรันอยู่
// CI: .github/workflows/ci.yml (job e2e) · เครื่องตัวเอง: docs/dev.md
// Chromium ของเครื่องพัฒนา (ไม่ดาวน์โหลดเพิ่ม) ใช้เฉพาะโปรเจกต์ Chromium
const chromium = { browserName: 'chromium' as const, launchOptions: process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {} };

export default defineConfig({
  testDir: './e2e',
  outputDir: './e2e-results/artifacts',
  fullyParallel: false,
  workers: 1, // ใช้ฐานข้อมูลชุดเดียวกัน
  retries: 0,
  reporter: [['list'], ['html', { outputFolder: './e2e-results/report', open: 'never' }]],
  use: {
    baseURL: process.env.E2E_BASE ?? 'http://localhost:3000',
    locale: 'th-TH',
    timezoneId: 'Asia/Bangkok',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'phone', use: { ...chromium, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } },
    { name: 'ipad', use: { ...chromium, viewport: { width: 1180, height: 820 }, hasTouch: true } },
    { name: 'pc', use: { ...chromium, viewport: { width: 1440, height: 900 } } },
    // เอนจินเดียวกับ Safari บน iPhone/iPad (PLAN.md ข้อ 8) รันใน CI ที่ติดตั้ง WebKit ได้ (E2E_WEBKIT=1)
    // ใกล้ของจริงแต่ไม่แทนการลองบนเครื่องจริง: docs/device-test.md
    ...(process.env.E2E_WEBKIT === '1'
      ? [
          { name: 'iphone-safari', use: { ...devices['iPhone 14'] } },
          { name: 'ipad-safari', use: { ...devices['iPad Pro 11'] } },
        ]
      : []),
  ],
});
