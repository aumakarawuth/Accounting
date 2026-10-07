// Service worker (scope /c/ = หน้าบริษัทของนักเรียน): ไม่ทำ offline-first (PLAN.md ข้อ 8 การลงบัญชีต้องออนไลน์เสมอ)
// - ไฟล์ static ที่มี hash (/_next/static, ฟอนต์, ไอคอน): cache-first เปิดเร็วบนเน็ตช้า
// - หน้าเว็บ: ไปเน็ตเสมอ ออฟไลน์ค่อยแสดงหน้า /offline (ไม่เก็บหน้าที่มีข้อมูลบัญชี เครื่องห้องคอมใช้ร่วมกัน)
// - /api: ไม่แตะเลย
const STATIC = 'static-v1';
const PAGES = 'offline-v1';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(PAGES).then((c) => c.add(new Request('/offline', { cache: 'reload' }))));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== STATIC && key !== PAGES) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(async () => (await caches.match('/offline')) ?? Response.error()));
    return;
  }
  if (url.pathname.startsWith('/_next/static/') || url.pathname.startsWith('/icons/')) {
    event.respondWith((async () => {
      const cache = await caches.open(STATIC);
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    })());
  }
});
