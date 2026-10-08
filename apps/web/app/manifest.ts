import type { MetadataRoute } from 'next';
import { th } from '@/i18n/th';

// PWA ติดตั้งได้ (PLAN.md ข้อ 8) สีตาม design tokens
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: th.app.name,
    short_name: th.pwa.shortName,
    description: th.pwa.description,
    lang: 'th',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#EEF1EA',
    theme_color: '#FAFBF7',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
