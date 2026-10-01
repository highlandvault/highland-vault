import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { BrandMark } from '@/components/brand-mark';
import { fetchMarkets } from '@/markets';
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

export default async function RootLayout({ children }: { children: ReactNode }) {
  // The footer lists the markets that are actually open, which only the API
  // knows (ADR-0005). A failed lookup is null and the column is simply absent:
  // a footer is not worth failing a page over.
  const markets = (await fetchMarkets()) ?? [];

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
            <div className="site-header__nav">
              <nav className="site-nav" aria-label="Competitions">
                <Link href="/#competitions">Competitions</Link>
                <Link href="/#how-it-works">How it works</Link>
              </nav>
              <nav className="site-nav site-nav--account" aria-label="Account">
                <Link href="/account">Account</Link>
                <Link href="/login">Sign in</Link>
                <Link href="/register">Register</Link>
              </nav>
            </div>
          </div>
        </header>
        {children}
        <footer className="site-footer">
          <div className="container">
            <div className="site-footer__grid">
              <div className="site-footer__brand">
                <span className="brand">
                  <BrandMark />
                  Highland Vault
                </span>
                <p>
                  Prize draws with transparent entry, clear rules and a skill question on every
                  entry.
                </p>
              </div>

              {markets.length > 0 && (
                <nav className="site-footer__col" aria-labelledby="footer-markets">
                  <h2 id="footer-markets" className="site-footer__heading">
                    Competitions
                  </h2>
                  <ul>
                    {markets.map((market) => (
                      <li key={market.code}>
                        <Link href={`/${market.code}/draws`}>
                          {market.name} <span className="site-footer__meta">{market.currency}</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </nav>
              )}

              <nav className="site-footer__col" aria-labelledby="footer-account">
                <h2 id="footer-account" className="site-footer__heading">
                  Account
                </h2>
                <ul>
                  <li>
                    <Link href="/login">Sign in</Link>
                  </li>
                  <li>
                    <Link href="/register">Create an account</Link>
                  </li>
                  <li>
                    <Link href="/account">Your account</Link>
                  </li>
                </ul>
              </nav>

              <div className="site-footer__col">
                <h2 className="site-footer__heading">Entering a draw</h2>
                {/* No terms or privacy pages exist yet, so none are linked. The
                    terms are presented and recorded at checkout, which is where
                    they are actually agreed. */}
                <p>
                  Every entry includes a skill question. The terms for each market are shown at
                  checkout and must be accepted before an order is placed.
                </p>
              </div>
            </div>

            <div className="site-footer__base">
              <p>© {new Date().getFullYear()} Highland Vault</p>
              <p>
                Pre-release build. Tickets can be added to a basket, bought and paid for; a live
                payment provider has not been chosen yet.
              </p>
            </div>
          </div>
        </footer>
      </body>
    </html>
  );
}
