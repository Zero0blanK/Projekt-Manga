import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { AppShell } from '@/components/app-shell';
import { QueryProvider } from '@/components/query-provider';
import { CoverPrivacyProvider } from '@/components/discover/cover-privacy-provider';
import { SPLASH_INIT_SCRIPT } from '@/lib/splash';
import { THEME_INIT_SCRIPT } from '@/lib/theme';
import '@/styles.css';

export const metadata: Metadata = {
  title: 'Projekt Manga — A minimal manga reader',
  description:
    'A calm, modern desktop-style manga reader. Track chapters, continue where you left off, and discover new series.',
  authors: [{ name: 'Projekt Manga' }],
  // The brand SVG scales to every icon size; there is no /favicon.ico in public/.
  icons: { icon: '/brand/ProjektManga.svg' },
  openGraph: {
    title: 'Projekt Manga — A minimal manga reader',
    description: 'A calm, modern manga reader for your library.',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
  },
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // The init script rewrites class/style/data-theme on <html> before hydration, which
    // is a deliberate server/client difference — suppress the warning it would raise.
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        {/* Must run before first paint so the stylesheet's defaults never flash — see
            THEME_INIT_SCRIPT. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        {/* Decides before first paint whether this session already showed the boot splash
            — see SPLASH_INIT_SCRIPT. SplashIntro renders unconditionally as server HTML, so
            without this the real page would show briefly before React took over. */}
        <script dangerouslySetInnerHTML={{ __html: SPLASH_INIT_SCRIPT }} />
      </head>
      <body>
        <QueryProvider>
          <CoverPrivacyProvider>
            <AppShell>{children}</AppShell>
          </CoverPrivacyProvider>
        </QueryProvider>
      </body>
    </html>
  );
}
