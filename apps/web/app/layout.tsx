import type { Metadata, Viewport } from 'next';
import '@fontsource/ibm-plex-sans-thai-looped/400.css';
import '@fontsource/ibm-plex-sans-thai-looped/500.css';
import '@fontsource/ibm-plex-sans-thai-looped/600.css';
import '@fontsource/noto-serif-thai/600.css';
import '@fontsource/noto-serif-thai/700.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import './globals.css';
import { th } from '@/i18n/th';
import { ServiceWorker } from '@/components/ServiceWorker';

export const metadata: Metadata = {
  title: th.app.name,
  description: th.pwa.description,
  appleWebApp: { capable: true, title: th.pwa.shortName, statusBarStyle: 'default' },
};
export const viewport: Viewport = { width: 'device-width', initialScale: 1, viewportFit: 'cover', themeColor: '#FAFBF7' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="th">
      <body>
        {children}
        <ServiceWorker />
      </body>
    </html>
  );
}
