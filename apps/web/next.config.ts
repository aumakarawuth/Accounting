import path from 'node:path';
import type { NextConfig } from 'next';

const api = process.env.API_URL ?? 'http://127.0.0.1:4000';

const embedded = process.env.EMBED_API === '1'; // Vercel: API ฝังใน pages/api (apps/api/src/embedded.ts)

const config: NextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  // Next 16's CLI-based TypeScript setup check can receive empty output in
  // this monorepo. The installed TypeScript API validates the same config.
  experimental: { useTypeScriptCli: false },
  outputFileTracingRoot: path.join(import.meta.dirname, '../..'),
  // ฝัง API: native module (argon2) และ pg ไม่ bundle
  serverExternalPackages: ['@accounting/api', '@node-rs/argon2', 'pg'],
  webpack(config, { isServer }) {
    if (isServer) {
      const externalizeArgon2 = ({ request }: { request?: string }, callback: (error?: Error | null, result?: string) => void) => {
        if (request === '@node-rs/argon2' || request?.startsWith('@node-rs/argon2-')) {
          callback(null, `commonjs ${request}`);
          return;
        }
        callback();
      };
      config.externals = [...(config.externals ?? []), externalizeArgon2];
    }
    return config;
  },
  // เบราว์เซอร์คุยกับ /api ที่ origin เดียวกัน (cookie SameSite=Lax ใช้ได้ ไม่ต้องเปิด CORS)
  // beforeFiles: แยก API ไว้ข้างนอก ให้ rewrite ทำงานก่อนถึง pages/api ที่ใช้เฉพาะตอนฝัง
  async rewrites() {
    return embedded ? [] : { beforeFiles: [{ source: '/api/:path*', destination: `${api}/:path*` }], afterFiles: [], fallback: [] };
  },
  async headers() {
    return [{
      // service worker ต้องได้ตัวล่าสุดเสมอ (ไม่ให้เบราว์เซอร์/CDN cache)
      source: '/sw.js',
      headers: [{ key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' }],
    }, {
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
