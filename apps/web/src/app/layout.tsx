import type { Metadata } from 'next';
import Link from 'next/link';
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
          <strong>Highland Vault</strong> <small>(development shell — Phase 2)</small>{' '}
          <nav style={{ display: 'inline' }}>
            <Link href="/">Home</Link> · <Link href="/account">Account</Link> ·{' '}
            <Link href="/login">Sign in</Link> · <Link href="/register">Register</Link>
          </nav>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
