import type { NextConfig } from 'next';

const api = process.env.API_URL ?? 'http://127.0.0.1:4000';

const config: NextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  // เบราว์เซอร์คุยกับ /api ที่ origin เดียวกัน (cookie SameSite=Lax ใช้ได้ ไม่ต้องเปิด CORS)
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${api}/:path*` }];
  },
  async headers() {
    return [{
      source: '/:path*',
      headers: [
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
      ],
    }];
  },
};

export default config;
