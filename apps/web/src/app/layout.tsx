import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { BrandMark } from '@/components/brand-mark';
import { ArrowIcon, SearchIcon, UserIcon } from '@/components/icons';
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

/**
 * Navigation the design calls for, against the routes that exist.
 *
 * Competitions and How it works go somewhere. **Winners, About and Contact do
 * not exist** — there are no such routes, and settlement (which is what a
 * winners page would show) is a later phase. They are rendered as plain text
 * rather than as links, so the navigation matches the design without three
 * items that 404. Give them pages and they become links.
 */
const NAV = [
  { label: 'Competitions', href: '/#competitions' },
  { label: 'Winners', href: null },
  { label: 'How it works', href: '/#how-it-works' },
  { label: 'About', href: null },
  { label: 'Contact', href: null },
] as const;

export default async function RootLayout({ children }: { children: ReactNode }) {
  // The footer and the header both list the markets that are actually open,
  // which only the API knows (ADR-0005). A failed lookup is an empty list and
  // the column is simply absent: a footer is not worth failing a page over.
  const markets = (await fetchMarkets()) ?? [];
  // Search lives on a market's listing (`?q=`), so it only has a destination
  // when there is one market to search. With several, the market comes first.
  const searchHref = markets.length === 1 ? `/${markets[0]!.code}/draws` : '/#competitions';

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
              <span className="brand__name">
                Highland Vault
                <small className="brand__tag">Prize competitions</small>
              </span>
            </Link>

            <nav className="site-nav" aria-label="Sections">
              {NAV.map((item) =>
                item.href ? (
                  <Link key={item.label} href={item.href}>
                    {item.label}
                  </Link>
                ) : (
                  // Not a link, and not announced as one.
                  <span key={item.label} className="site-nav__soon" aria-disabled="true">
                    {item.label}
                  </span>
                ),
              )}
            </nav>

            <div className="site-header__actions">
              {/* Not "Search competitions": the listing page has a search field with
                  exactly that label, and two controls sharing an accessible name is a
                  real ambiguity for anyone navigating by name, not just a test clash. */}
              <Link className="icon-link" href={searchHref} aria-label="Search">
                <SearchIcon />
              </Link>
              <Link className="icon-link icon-link--labelled" href="/account">
                <UserIcon />
                <span>My account</span>
              </Link>
              <Link className="button button--blue button--sm" href="/#competitions">
                Enter now
                <ArrowIcon className="button__arrow" />
              </Link>
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
                  <span className="brand__name">Highland Vault</span>
                </span>
                <p>
                  Prize draws with transparent entry, clear rules and a skill question on every
                  entry.
                </p>
              </div>

              <nav className="site-footer__col" aria-labelledby="footer-sections">
                <h2 id="footer-sections" className="site-footer__heading">
                  Sections
                </h2>
                <ul>
                  {NAV.map((item) => (
                    <li key={item.label}>
                      {item.href ? (
                        <Link href={item.href}>{item.label}</Link>
                      ) : (
                        <span className="site-footer__soon" aria-disabled="true">
                          {item.label}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </nav>

              {markets.length > 0 && (
                <nav className="site-footer__col" aria-labelledby="footer-markets">
                  <h2 id="footer-markets" className="site-footer__heading">
                    Markets
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
            </div>

            {/*
              No registered address and no social accounts are configured
              anywhere in this repository, so neither is shown. Inventing a
              postal address or linking to accounts that may not be ours is
              worse than an honest gap.
            */}
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
