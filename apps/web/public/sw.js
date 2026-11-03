// Service worker (scope /c/ = หน้าบริษัทของนักเรียน): ไม่ทำ offline-first (PLAN.md ข้อ 8 การลงบัญชีต้องออนไลน์เสมอ)
// - ไฟล์ static ที่มี hash (/_next/static, ฟอนต์, ไอคอน): cache-first เปิดเร็วบนเน็ตช้า
// - หน้าเว็บ: ไปเน็ตเสมอ ออฟไลน์ค่อยแสดงหน้า /offline (ไม่เก็บหน้าที่มีข้อมูลบัญชี เครื่องห้องคอมใช้ร่วมกัน)
// - /api: ไม่แตะเลย
const STATIC = 'static-v1';
const PAGES = 'offline-v2';

self.addEventListener('install', (event) => {
  event.waitUntil(cacheOfflinePage());
  self.skipWaiting();
});

// หน้า /offline เก็บแบบไม่มีสคริปต์ของ Next: ถ้ามี router มันจะเห็นว่า URL ไม่ตรงกับหน้า (เช่น /c/.../trial-balance) แล้วขึ้นหน้าผิดพลาด
// ปุ่มลองใหม่ = โหลดหน้าเดิมซ้ำ (สคริปต์สั้นในหน้า)
async function cacheOfflinePage() {
  const res = await fetch(new Request('/offline', { cache: 'reload' }));
  const html = (await res.text())
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<link[^>]+rel="(?:preload|modulepreload)"[^>]*>/gi, '')
    .replace('</body>', '<script>document.querySelectorAll("button").forEach(function(b){b.addEventListener("click",function(){location.reload()})})</script></body>');
  const cache = await caches.open(PAGES);
  await cache.put('/offline', new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } }));
}

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
