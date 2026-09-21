import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Highland Vault',
  robots: { index: false, follow: false }, // development shell — not for indexing
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', margin: '2rem', lineHeight: 1.5 }}>
        <header>
          <strong>Highland Vault</strong> <small>(development shell — Phase 1)</small>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
