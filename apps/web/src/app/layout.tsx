import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { BrandMark } from '@/components/brand-mark';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Highland Vault', template: '%s · Highland Vault' },
  description: 'Prize draws from Highland Vault.',
  // Not for indexing until launch.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#0e1726',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a className="visually-hidden" href="#main">
          Skip to content
        </a>
        <header className="site-header">
          <div className="container site-header__inner">
            <Link href="/" className="brand">
              <BrandMark />
              Highland Vault
            </Link>
            <nav className="site-nav" aria-label="Account">
              <Link href="/account">Account</Link>
              <Link href="/login">Sign in</Link>
              <Link href="/register">Register</Link>
            </nav>
          </div>
        </header>
        {children}
        <footer className="site-footer">
          <div className="container">
            <p>Highland Vault — pre-release build. Online entry is not open yet.</p>
          </div>
        </footer>
      </body>
    </html>
  );
}
